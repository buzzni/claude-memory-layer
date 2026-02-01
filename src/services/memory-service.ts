/**
 * Memory Service - Main entry point for memory operations
 * Coordinates EventStore, VectorStore, Retriever, and Graduation
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';

import { EventStore } from '../core/event-store.js';
import { VectorStore } from '../core/vector-store.js';
import { Embedder, getDefaultEmbedder } from '../core/embedder.js';
import { VectorWorker, createVectorWorker } from '../core/vector-worker.js';
import { Matcher, getDefaultMatcher } from '../core/matcher.js';
import { Retriever, createRetriever, RetrievalResult } from '../core/retriever.js';
import { GraduationPipeline, createGraduationPipeline } from '../core/graduation.js';
import type {
  MemoryEventInput,
  AppendResult,
  MemoryEvent,
  Config,
  ConfigSchema,
  ToolObservationPayload,
  MemoryMode,
  EndlessModeConfig,
  EndlessModeConfigSchema,
  WorkingSet,
  ConsolidatedMemory,
  EndlessModeStatus,
  ContextSnapshot,
  ContinuityScore
} from '../core/types.js';
import { createToolObservationEmbedding } from '../core/metadata-extractor.js';
import { WorkingSetStore, createWorkingSetStore } from '../core/working-set-store.js';
import { ConsolidatedStore, createConsolidatedStore } from '../core/consolidated-store.js';
import { ConsolidationWorker, createConsolidationWorker } from '../core/consolidation-worker.js';
import { ContinuityManager, createContinuityManager } from '../core/continuity-manager.js';

export interface MemoryServiceConfig {
  storagePath: string;
  embeddingModel?: string;
}

export class MemoryService {
  private readonly eventStore: EventStore;
  private readonly vectorStore: VectorStore;
  private readonly embedder: Embedder;
  private readonly matcher: Matcher;
  private readonly retriever: Retriever;
  private readonly graduation: GraduationPipeline;
  private vectorWorker: VectorWorker | null = null;
  private initialized = false;

  // Endless Mode components
  private workingSetStore: WorkingSetStore | null = null;
  private consolidatedStore: ConsolidatedStore | null = null;
  private consolidationWorker: ConsolidationWorker | null = null;
  private continuityManager: ContinuityManager | null = null;
  private endlessMode: MemoryMode = 'session';

  constructor(config: MemoryServiceConfig) {
    const storagePath = this.expandPath(config.storagePath);

    // Ensure storage directory exists
    if (!fs.existsSync(storagePath)) {
      fs.mkdirSync(storagePath, { recursive: true });
    }

    // Initialize components
    this.eventStore = new EventStore(path.join(storagePath, 'events.duckdb'));
    this.vectorStore = new VectorStore(path.join(storagePath, 'vectors'));
    this.embedder = config.embeddingModel
      ? new Embedder(config.embeddingModel)
      : getDefaultEmbedder();
    this.matcher = getDefaultMatcher();
    this.retriever = createRetriever(
      this.eventStore,
      this.vectorStore,
      this.embedder,
      this.matcher
    );
    this.graduation = createGraduationPipeline(this.eventStore);
  }

  /**
   * Initialize all components
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.eventStore.initialize();
    await this.vectorStore.initialize();
    await this.embedder.initialize();

    // Start vector worker
    this.vectorWorker = createVectorWorker(
      this.eventStore,
      this.vectorStore,
      this.embedder
    );
    this.vectorWorker.start();

    // Load endless mode setting
    const savedMode = await this.eventStore.getEndlessConfig('mode') as MemoryMode | null;
    if (savedMode === 'endless') {
      this.endlessMode = 'endless';
      await this.initializeEndlessMode();
    }

    this.initialized = true;
  }

  /**
   * Start a new session
   */
  async startSession(sessionId: string, projectPath?: string): Promise<void> {
    await this.initialize();

    await this.eventStore.upsertSession({
      id: sessionId,
      startedAt: new Date(),
      projectPath
    });
  }

  /**
   * End a session
   */
  async endSession(sessionId: string, summary?: string): Promise<void> {
    await this.initialize();

    await this.eventStore.upsertSession({
      id: sessionId,
      endedAt: new Date(),
      summary
    });
  }

  /**
   * Store a user prompt
   */
  async storeUserPrompt(
    sessionId: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<AppendResult> {
    await this.initialize();

    const result = await this.eventStore.append({
      eventType: 'user_prompt',
      sessionId,
      timestamp: new Date(),
      content,
      metadata
    });

    // Enqueue for embedding if new
    if (result.success && !result.isDuplicate) {
      await this.eventStore.enqueueForEmbedding(result.eventId, content);
    }

    return result;
  }

  /**
   * Store an agent response
   */
  async storeAgentResponse(
    sessionId: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<AppendResult> {
    await this.initialize();

    const result = await this.eventStore.append({
      eventType: 'agent_response',
      sessionId,
      timestamp: new Date(),
      content,
      metadata
    });

    // Enqueue for embedding if new
    if (result.success && !result.isDuplicate) {
      await this.eventStore.enqueueForEmbedding(result.eventId, content);
    }

    return result;
  }

  /**
   * Store a session summary
   */
  async storeSessionSummary(
    sessionId: string,
    summary: string
  ): Promise<AppendResult> {
    await this.initialize();

    const result = await this.eventStore.append({
      eventType: 'session_summary',
      sessionId,
      timestamp: new Date(),
      content: summary
    });

    if (result.success && !result.isDuplicate) {
      await this.eventStore.enqueueForEmbedding(result.eventId, summary);
    }

    return result;
  }

  /**
   * Store a tool observation
   */
  async storeToolObservation(
    sessionId: string,
    payload: ToolObservationPayload
  ): Promise<AppendResult> {
    await this.initialize();

    // Create content for storage (JSON stringified payload)
    const content = JSON.stringify(payload);

    const result = await this.eventStore.append({
      eventType: 'tool_observation',
      sessionId,
      timestamp: new Date(),
      content,
      metadata: {
        toolName: payload.toolName,
        success: payload.success
      }
    });

    // Create embedding content (optimized for search)
    if (result.success && !result.isDuplicate) {
      const embeddingContent = createToolObservationEmbedding(
        payload.toolName,
        payload.metadata || {},
        payload.success
      );
      await this.eventStore.enqueueForEmbedding(result.eventId, embeddingContent);
    }

    return result;
  }

  /**
   * Retrieve relevant memories for a query
   */
  async retrieveMemories(
    query: string,
    options?: {
      topK?: number;
      minScore?: number;
      sessionId?: string;
    }
  ): Promise<RetrievalResult> {
    await this.initialize();

    // Process any pending embeddings first
    if (this.vectorWorker) {
      await this.vectorWorker.processAll();
    }

    return this.retriever.retrieve(query, options);
  }

  /**
   * Get session history
   */
  async getSessionHistory(sessionId: string): Promise<MemoryEvent[]> {
    await this.initialize();
    return this.eventStore.getSessionEvents(sessionId);
  }

  /**
   * Get recent events
   */
  async getRecentEvents(limit: number = 100): Promise<MemoryEvent[]> {
    await this.initialize();
    return this.eventStore.getRecentEvents(limit);
  }

  /**
   * Get memory statistics
   */
  async getStats(): Promise<{
    totalEvents: number;
    vectorCount: number;
    levelStats: Array<{ level: string; count: number }>;
  }> {
    await this.initialize();

    const recentEvents = await this.eventStore.getRecentEvents(10000);
    const vectorCount = await this.vectorStore.count();
    const levelStats = await this.graduation.getStats();

    return {
      totalEvents: recentEvents.length,
      vectorCount,
      levelStats
    };
  }

  /**
   * Process pending embeddings
   */
  async processPendingEmbeddings(): Promise<number> {
    if (this.vectorWorker) {
      return this.vectorWorker.processAll();
    }
    return 0;
  }

  /**
   * Format retrieval results as context for Claude
   */
  formatAsContext(result: RetrievalResult): string {
    if (!result.context) {
      return '';
    }

    const confidence = result.matchResult.confidence;
    let header = '';

    if (confidence === 'high') {
      header = '🎯 **High-confidence memory match found:**\n\n';
    } else if (confidence === 'suggested') {
      header = '💡 **Suggested memories (may be relevant):**\n\n';
    }

    return header + result.context;
  }

  // ============================================================
  // Endless Mode Methods
  // ============================================================

  /**
   * Get the default endless mode config
   */
  private getDefaultEndlessConfig(): EndlessModeConfig {
    return {
      enabled: true,
      workingSet: {
        maxEvents: 100,
        timeWindowHours: 24,
        minRelevanceScore: 0.5
      },
      consolidation: {
        triggerIntervalMs: 3600000, // 1 hour
        triggerEventCount: 100,
        triggerIdleMs: 1800000, // 30 minutes
        useLLMSummarization: false
      },
      continuity: {
        minScoreForSeamless: 0.7,
        topicDecayHours: 48
      }
    };
  }

  /**
   * Initialize Endless Mode components
   */
  async initializeEndlessMode(): Promise<void> {
    const config = await this.getEndlessConfig();

    this.workingSetStore = createWorkingSetStore(this.eventStore, config);
    this.consolidatedStore = createConsolidatedStore(this.eventStore);
    this.consolidationWorker = createConsolidationWorker(
      this.workingSetStore,
      this.consolidatedStore,
      config
    );
    this.continuityManager = createContinuityManager(this.eventStore, config);

    // Start consolidation worker
    this.consolidationWorker.start();
  }

  /**
   * Get Endless Mode configuration
   */
  async getEndlessConfig(): Promise<EndlessModeConfig> {
    const savedConfig = await this.eventStore.getEndlessConfig('config') as EndlessModeConfig | null;
    return savedConfig || this.getDefaultEndlessConfig();
  }

  /**
   * Set Endless Mode configuration
   */
  async setEndlessConfig(config: Partial<EndlessModeConfig>): Promise<void> {
    const current = await this.getEndlessConfig();
    const merged = { ...current, ...config };
    await this.eventStore.setEndlessConfig('config', merged);
  }

  /**
   * Set memory mode (session or endless)
   */
  async setMode(mode: MemoryMode): Promise<void> {
    await this.initialize();

    if (mode === this.endlessMode) return;

    this.endlessMode = mode;
    await this.eventStore.setEndlessConfig('mode', mode);

    if (mode === 'endless') {
      await this.initializeEndlessMode();
    } else {
      // Stop endless mode components
      if (this.consolidationWorker) {
        this.consolidationWorker.stop();
        this.consolidationWorker = null;
      }
      this.workingSetStore = null;
      this.consolidatedStore = null;
      this.continuityManager = null;
    }
  }

  /**
   * Get current memory mode
   */
  getMode(): MemoryMode {
    return this.endlessMode;
  }

  /**
   * Check if endless mode is active
   */
  isEndlessModeActive(): boolean {
    return this.endlessMode === 'endless';
  }

  /**
   * Add event to Working Set (Endless Mode)
   */
  async addToWorkingSet(eventId: string, relevanceScore?: number): Promise<void> {
    if (!this.workingSetStore) return;
    await this.workingSetStore.add(eventId, relevanceScore);
  }

  /**
   * Get the current Working Set
   */
  async getWorkingSet(): Promise<WorkingSet | null> {
    if (!this.workingSetStore) return null;
    return this.workingSetStore.get();
  }

  /**
   * Search consolidated memories
   */
  async searchConsolidated(
    query: string,
    options?: { topK?: number }
  ): Promise<ConsolidatedMemory[]> {
    if (!this.consolidatedStore) return [];
    return this.consolidatedStore.search(query, options);
  }

  /**
   * Get all consolidated memories
   */
  async getConsolidatedMemories(limit?: number): Promise<ConsolidatedMemory[]> {
    if (!this.consolidatedStore) return [];
    return this.consolidatedStore.getAll({ limit });
  }

  /**
   * Calculate continuity score for current context
   */
  async calculateContinuity(
    content: string,
    metadata?: { files?: string[]; entities?: string[] }
  ): Promise<ContinuityScore | null> {
    if (!this.continuityManager) return null;

    const snapshot = this.continuityManager.createSnapshot(
      crypto.randomUUID(),
      content,
      metadata
    );

    return this.continuityManager.calculateScore(snapshot);
  }

  /**
   * Record activity (for consolidation idle trigger)
   */
  recordActivity(): void {
    if (this.consolidationWorker) {
      this.consolidationWorker.recordActivity();
    }
  }

  /**
   * Force a consolidation run
   */
  async forceConsolidation(): Promise<number> {
    if (!this.consolidationWorker) return 0;
    return this.consolidationWorker.forceRun();
  }

  /**
   * Get Endless Mode status
   */
  async getEndlessModeStatus(): Promise<EndlessModeStatus> {
    await this.initialize();

    let workingSetSize = 0;
    let continuityScore = 0.5;
    let consolidatedCount = 0;
    let lastConsolidation: Date | null = null;

    if (this.workingSetStore) {
      workingSetSize = await this.workingSetStore.count();
      const workingSet = await this.workingSetStore.get();
      continuityScore = workingSet.continuityScore;
    }

    if (this.consolidatedStore) {
      consolidatedCount = await this.consolidatedStore.count();
      lastConsolidation = await this.consolidatedStore.getLastConsolidationTime();
    }

    return {
      mode: this.endlessMode,
      workingSetSize,
      continuityScore,
      consolidatedCount,
      lastConsolidation
    };
  }

  /**
   * Format Endless Mode context for Claude
   */
  async formatEndlessContext(query: string): Promise<string> {
    if (!this.isEndlessModeActive()) {
      return '';
    }

    const workingSet = await this.getWorkingSet();
    const consolidated = await this.searchConsolidated(query, { topK: 3 });
    const continuity = await this.calculateContinuity(query);

    const parts: string[] = [];

    // Continuity status
    if (continuity) {
      const statusEmoji = continuity.transitionType === 'seamless' ? '🔗' :
                          continuity.transitionType === 'topic_shift' ? '↪️' : '🆕';
      parts.push(`${statusEmoji} Context: ${continuity.transitionType} (score: ${continuity.score.toFixed(2)})`);
    }

    // Working set summary
    if (workingSet && workingSet.recentEvents.length > 0) {
      parts.push('\n## Recent Context (Working Set)');
      const recent = workingSet.recentEvents.slice(0, 5);
      for (const event of recent) {
        const preview = event.content.slice(0, 80) + (event.content.length > 80 ? '...' : '');
        const time = event.timestamp.toLocaleTimeString();
        parts.push(`- ${time} [${event.eventType}] ${preview}`);
      }
    }

    // Consolidated memories
    if (consolidated.length > 0) {
      parts.push('\n## Related Knowledge (Consolidated)');
      for (const memory of consolidated) {
        parts.push(`- ${memory.topics.slice(0, 3).join(', ')}: ${memory.summary.slice(0, 100)}...`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Shutdown service
   */
  async shutdown(): Promise<void> {
    // Stop endless mode components
    if (this.consolidationWorker) {
      this.consolidationWorker.stop();
    }

    if (this.vectorWorker) {
      this.vectorWorker.stop();
    }
    await this.eventStore.close();
  }

  /**
   * Expand ~ to home directory
   */
  private expandPath(p: string): string {
    if (p.startsWith('~')) {
      return path.join(os.homedir(), p.slice(1));
    }
    return p;
  }
}

// Default instance
let defaultService: MemoryService | null = null;

export function getDefaultMemoryService(): MemoryService {
  if (!defaultService) {
    defaultService = new MemoryService({
      storagePath: '~/.claude-code/memory'
    });
  }
  return defaultService;
}

export function createMemoryService(config: MemoryServiceConfig): MemoryService {
  return new MemoryService(config);
}
