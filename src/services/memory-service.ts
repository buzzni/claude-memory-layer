/**
 * Memory Service - Main entry point for memory operations
 * Coordinates EventStore, VectorStore, Retriever, and Graduation
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

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
  ConfigSchema
} from '../core/types.js';

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

  /**
   * Shutdown service
   */
  async shutdown(): Promise<void> {
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
