/**
 * Memory Service - Main entry point for memory operations
 * Coordinates EventStore, VectorStore, Retriever, and Graduation
 */

import * as path from 'path';
import * as os from 'os';

import type { EventStore } from '../core/event-store.js';
import type { SQLiteEventStore } from '../core/sqlite-event-store.js';
import type { VectorStore } from '../core/vector-store.js';
import type { Embedder } from '../core/embedder.js';
import type { Retriever, RetrievalResult, UnifiedRetrievalResult } from '../core/retriever.js';
import type { GraduationPipeline } from '../core/graduation.js';
import type { PromotionResult } from '../core/shared-promoter.js';
import {
  createSharedMemoryServices,
  type SharedMemoryServices
} from '../core/engine/shared-memory-services.js';
import type {
  AppendResult,
  MemoryEvent,
  ToolObservationPayload,
  MemoryMode,
  EndlessModeConfig,
  WorkingSet,
  ConsolidatedMemory,
  EndlessModeStatus,
  ContinuityScore,
  SharedStoreConfig,
  Entry
} from '../core/types.js';
import { createToolObservationEmbedding } from '../core/metadata-extractor.js';
import {
  createEndlessMemoryServices,
  type EndlessMemoryServices
} from '../core/engine/endless-memory-services.js';
import {
  createEmbeddingMaintenanceService,
  type EmbeddingMaintenanceService,
  type EmbeddingModelMaintenanceOptions,
  type EmbeddingModelMaintenanceResult
} from '../core/engine/embedding-maintenance-service.js';
import {
  createMemoryRuntimeService,
  type MemoryRuntimeService
} from '../core/engine/memory-runtime-service.js';
import type { GraduationRunResult } from '../core/graduation-worker.js';
import type { IngestInterceptor } from '../core/ingest-interceptor.js';
import type { MemoryIngestService } from '../core/engine/memory-ingest-service.js';
import type { MemoryQueryService } from '../core/engine/memory-query-service.js';
import { createMemoryEngineServices } from '../core/engine/memory-engine-services.js';
import {
  type AccessedMemory,
  type HelpfulMemory,
  type HelpfulnessStats,
  type RecordQueryTraceInput,
  type RetrievalAnalyticsService,
  type RetrievalDisclosureExpansion,
  type RetrievalDisclosureExpandOptions,
  type RetrievalDisclosureSearchOptions,
  type RetrievalDisclosureSearchResponse,
  type RetrievalDisclosureService,
  type RetrievalDisclosureSource,
  type RetrievalOrchestrator,
  type RetrievalTrace,
  type RetrievalTraceStats,
  type RetrieveMemoriesOptions
} from '../core/engine/retrieval-services.js';
import {
  getProjectStoragePath,
  hashProjectPath
} from '../core/registry/project-path.js';
import { getSessionProject } from '../core/registry/session-registry.js';

export { getProjectStoragePath, hashProjectPath } from '../core/registry/project-path.js';
export {
  getSessionProject,
  registerSession,
  type SessionRegistry,
  type SessionRegistryEntry,
  loadSessionRegistry
} from '../core/registry/session-registry.js';

export interface MemoryServiceConfig {
  storagePath: string;
  embeddingModel?: string;
  readOnly?: boolean;
  /** Enable DuckDB analytics store (default: true for server, false for hooks) */
  analyticsEnabled?: boolean;
  /** Lightweight mode for hooks - skip heavy initialization (default: false) */
  lightweightMode?: boolean;
  /** Start only VectorWorker, skip GraduationWorker and SyncWorker (default: false) */
  embeddingOnly?: boolean;
}

const SHARED_STORAGE_PATH = path.join(os.homedir(), '.claude-code', 'memory', 'shared');
export const DISABLED_SHARED_STORE_CONFIG: SharedStoreConfig = {
  enabled: false,
  autoPromote: false,
  searchShared: false,
  minConfidenceForPromotion: 0.8,
  sharedStoragePath: SHARED_STORAGE_PATH
};

export class MemoryService {
  // Primary store: SQLite (WAL mode) - for hooks, always available
  private readonly sqliteStore: SQLiteEventStore;

  private readonly vectorStore: VectorStore;
  private readonly embedder: Embedder;
  private readonly retriever: Retriever;
  private readonly retrievalOrchestrator: RetrievalOrchestrator;
  private readonly retrievalDisclosureService: RetrievalDisclosureService;
  private readonly retrievalAnalyticsService: RetrievalAnalyticsService;
  private readonly embeddingMaintenanceService: EmbeddingMaintenanceService;
  private readonly runtimeService: MemoryRuntimeService;
  private readonly graduation: GraduationPipeline;

  // Endless Mode components
  private readonly endlessMemoryServices: EndlessMemoryServices;

  // Shared Store components (cross-project knowledge)
  private sharedMemoryServices!: SharedMemoryServices;
  private projectHash: string | null = null;
  private projectPath: string | null = null;

  private readonly readOnly: boolean;
  private readonly lightweightMode: boolean;
  private readonly embeddingOnly: boolean;
  private readonly ingestService: MemoryIngestService;
  private readonly queryService: MemoryQueryService;

  constructor(config: MemoryServiceConfig & { projectHash?: string; projectPath?: string; sharedStoreConfig?: SharedStoreConfig }) {
    const storagePath = this.expandPath(config.storagePath);
    this.readOnly = config.readOnly ?? false;
    this.lightweightMode = config.lightweightMode ?? false;
    this.embeddingOnly = config.embeddingOnly ?? false;

    // Store project hash for shared store operations
    this.projectHash = config.projectHash || null;
    this.projectPath = config.projectPath || null;
    // Default: shared store enabled
    const sharedStoreConfig = config.sharedStoreConfig ?? {
      enabled: true,
      autoPromote: true,
      searchShared: true,
      minConfidenceForPromotion: 0.8,
      sharedStoragePath: SHARED_STORAGE_PATH
    };

    const engineServices = createMemoryEngineServices({
      storagePath,
      readOnly: this.readOnly,
      embeddingModel: config.embeddingModel,
      cwd: process.cwd(),
      initialize: () => this.initialize(),
      getProjectHash: () => this.projectHash,
      getProjectPath: () => this.projectPath,
      hasSharedStore: () => this.sharedMemoryServices?.isEnabled() ?? false,
      sharedStore: {
        get: (entryId: string) => this.getSharedEntryForDisclosure(entryId)
      },
      createToolObservationEmbedding: (payload) => createToolObservationEmbedding(
        payload.toolName,
        payload.metadata || {},
        payload.success
      )
    });

    this.sqliteStore = engineServices.sqliteStore;
    this.vectorStore = engineServices.vectorStore;
    this.embedder = engineServices.embedder;
    this.retriever = engineServices.retriever;
    this.retrievalOrchestrator = engineServices.retrievalOrchestrator;
    this.retrievalDisclosureService = engineServices.retrievalDisclosureService;
    this.retrievalAnalyticsService = engineServices.retrievalAnalyticsService;
    this.graduation = engineServices.graduation;
    this.ingestService = engineServices.ingestService;
    this.queryService = engineServices.queryService;
    this.endlessMemoryServices = createEndlessMemoryServices({
      eventStore: this.sqliteStore as unknown as EventStore,
      configStore: this.sqliteStore,
      initialize: () => this.initialize()
    });
    this.sharedMemoryServices = createSharedMemoryServices({
      config: sharedStoreConfig,
      defaultSharedStoragePath: SHARED_STORAGE_PATH,
      readOnly: this.readOnly,
      expandPath: (targetPath) => this.expandPath(targetPath),
      embedder: this.embedder,
      retriever: this.retriever
    });
    this.runtimeService = createMemoryRuntimeService({
      sqliteStore: this.sqliteStore,
      eventStore: this.sqliteStore as unknown as EventStore,
      vectorStore: this.vectorStore,
      embedder: this.embedder,
      retriever: this.retriever,
      graduation: this.graduation,
      endlessMemoryServices: this.endlessMemoryServices,
      sharedMemoryServices: this.sharedMemoryServices,
      readOnly: this.readOnly,
      lightweightMode: this.lightweightMode,
      embeddingOnly: this.embeddingOnly
    });
    this.embeddingMaintenanceService = createEmbeddingMaintenanceService({
      storagePath,
      initialize: () => this.initialize(),
      getEmbeddingModelName: () => this.getEmbeddingModelName(),
      vectorStore: this.vectorStore,
      eventStore: {
        clearEmbeddingOutbox: () => this.sqliteStore.clearEmbeddingOutbox(),
        getEventsPage: async (limit, offset) => {
          const events = await this.sqliteStore.getEventsPage(limit, offset);
          return events.map((event) => ({ id: event.id, content: event.content }));
        },
        enqueueForEmbedding: async (eventId, content) => {
          await this.sqliteStore.enqueueForEmbedding(eventId, content);
        }
      },
      getVectorWorker: () => this.runtimeService.getVectorWorker()
    });
  }

  /**
   * Initialize all components
   */
  async initialize(): Promise<void> {
    await this.runtimeService.initialize();
  }

  private async getSharedEntryForDisclosure(entryId: string) {
    return this.sharedMemoryServices.getEntryForDisclosure(entryId);
  }

  registerIngestBefore(interceptor: IngestInterceptor): () => void {
    return this.ingestService.registerIngestBefore(interceptor);
  }

  registerIngestAfter(interceptor: IngestInterceptor): () => void {
    return this.ingestService.registerIngestAfter(interceptor);
  }

  registerIngestOnError(interceptor: IngestInterceptor): () => void {
    return this.ingestService.registerIngestOnError(interceptor);
  }

  /**
   * Start a new session
   */
  async startSession(sessionId: string, projectPath?: string): Promise<void> {
    return this.ingestService.startSession(sessionId, projectPath);
  }

  /**
   * End a session
   */
  async endSession(sessionId: string, summary?: string): Promise<void> {
    return this.ingestService.endSession(sessionId, summary);
  }

  /**
   * Store a user prompt
   */
  async storeUserPrompt(
    sessionId: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<AppendResult> {
    return this.ingestService.storeUserPrompt(sessionId, content, metadata);
  }

  /**
   * Store an agent response
   */
  async storeAgentResponse(
    sessionId: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<AppendResult> {
    return this.ingestService.storeAgentResponse(sessionId, content, metadata);
  }

  /**
   * Store a session summary
   */
  async storeSessionSummary(
    sessionId: string,
    summary: string,
    metadata?: Record<string, unknown>
  ): Promise<AppendResult> {
    return this.ingestService.storeSessionSummary(sessionId, summary, metadata);
  }

  /**
   * Backfill session summaries for recent sessions that are missing them.
   * Called from session-start hook to catch sessions that ended without Stop hook.
   */
  async backfillMissingSummaries(currentSessionId: string, limit = 5): Promise<void> {
    return this.ingestService.backfillMissingSummaries(currentSessionId, limit);
  }

  /**
   * Generate a rule-based session summary from stored events.
   * Called at session end (Stop hook) when no LLM-generated summary exists.
   * Skips if a summary already exists for this session.
   */
  async generateSessionSummary(sessionId: string): Promise<void> {
    return this.ingestService.generateSessionSummary(sessionId);
  }

  /**
   * Store a tool observation
   */
  async storeToolObservation(
    sessionId: string,
    payload: ToolObservationPayload
  ): Promise<AppendResult> {
    return this.ingestService.storeToolObservation(sessionId, payload);
  }

  /**
   * Retrieve relevant memories for a query
   */
  async retrieveMemories(
    query: string,
    options?: RetrieveMemoriesOptions
  ): Promise<UnifiedRetrievalResult> {
    return this.retrievalOrchestrator.retrieveMemories(query, options);
  }

  /**
   * Layer 1 retrieval disclosure: lightweight search envelopes for UI/API/agent use.
   */
  async searchDisclosure(
    query: string,
    options?: RetrievalDisclosureSearchOptions
  ): Promise<RetrievalDisclosureSearchResponse> {
    return this.retrievalDisclosureService.search(query, options);
  }

  /**
   * Layer 2 retrieval disclosure: expand a search result into surrounding timeline context.
   */
  async expandDisclosure(
    resultId: string,
    options?: RetrievalDisclosureExpandOptions
  ): Promise<RetrievalDisclosureExpansion | null> {
    return this.retrievalDisclosureService.expand(resultId, options);
  }

  /**
   * Layer 3 retrieval disclosure: resolve a search result to its raw source event.
   */
  async sourceDisclosure(resultId: string): Promise<RetrievalDisclosureSource | null> {
    return this.retrievalDisclosureService.source(resultId);
  }

  /**
   * Fast keyword search using SQLite FTS5
   * Much faster than vector search - no embedding model needed
   */
  async keywordSearch(
    query: string,
    options?: { topK?: number; minScore?: number }
  ): Promise<Array<{event: MemoryEvent; score: number}>> {
    return this.queryService.keywordSearch(query, options);
  }

  /**
   * Rebuild FTS index (call after database upgrade)
   */
  async rebuildFtsIndex(): Promise<number> {
    return this.queryService.rebuildFtsIndex();
  }

  /**
   * Get session history
   */
  async getSessionHistory(sessionId: string): Promise<MemoryEvent[]> {
    return this.queryService.getSessionHistory(sessionId);
  }

  /**
   * Get recent events
   */
  async getRecentEvents(limit: number = 100): Promise<MemoryEvent[]> {
    return this.queryService.getRecentEvents(limit);
  }

  /**
   * Get memory statistics
   */

  async getOutboxStats(): Promise<{
    embedding: { pending: number; processing: number; failed: number; total: number };
    vector: { pending: number; processing: number; failed: number; total: number };
  }> {
    return this.queryService.getOutboxStats();
  }

  async getRetrievalTraceStats(): Promise<RetrievalTraceStats> {
    return this.retrievalAnalyticsService.getRetrievalTraceStats();
  }

  async getRecentRetrievalTraces(limit: number = 50): Promise<RetrievalTrace[]> {
    return this.retrievalAnalyticsService.getRecentRetrievalTraces(limit);
  }

  async getStats(): Promise<{
    totalEvents: number;
    vectorCount: number;
    levelStats: Array<{ level: string; count: number }>;
  }> {
    return this.queryService.getStats();
  }

  /**
   * Process pending embeddings
   */
  async processPendingEmbeddings(): Promise<number> {
    return this.runtimeService.processPendingEmbeddings();
  }

  /**
   * Get events by memory level
   */
  async getEventsByLevel(level: string, options?: { limit?: number; offset?: number }): Promise<MemoryEvent[]> {
    return this.queryService.getEventsByLevel(level, options);
  }

  /**
   * Get memory level for a specific event
   */
  async getEventLevel(eventId: string): Promise<string | null> {
    return this.queryService.getEventLevel(eventId);
  }

  /**
   * Format retrieval results as context for Claude
   */
  formatAsContext(result: RetrievalResult): string {
    return this.retrievalOrchestrator.formatAsContext(result);
  }

  // ============================================================
  // Shared Store Methods (Cross-Project Knowledge)
  // ============================================================

  /**
   * Check if shared store is enabled and initialized
   */
  isSharedStoreEnabled(): boolean {
    return this.sharedMemoryServices.isEnabled();
  }

  /**
   * Promote an entry to shared storage
   */
  async promoteToShared(entry: Entry): Promise<PromotionResult> {
    return this.sharedMemoryServices.promoteToShared(entry, this.projectHash);
  }

  /**
   * Get shared store statistics
   */
  async getSharedStoreStats(): Promise<{
    total: number;
    averageConfidence: number;
    topTopics: Array<{ topic: string; count: number }>;
    totalUsageCount: number;
  } | null> {
    return this.sharedMemoryServices.getStats();
  }

  /**
   * Search shared troubleshooting entries
   */
  async searchShared(
    query: string,
    options?: { topK?: number; minConfidence?: number }
  ) {
    return this.sharedMemoryServices.search(query, options);
  }

  /**
   * Get project hash for this service
   */
  getProjectHash(): string | null {
    return this.projectHash;
  }

  // ============================================================
  // Endless Mode Methods
  // ============================================================

  /**
   * Initialize Endless Mode components
   */
  async initializeEndlessMode(): Promise<void> {
    return this.endlessMemoryServices.initializeEndlessMode();
  }

  /**
   * Get Endless Mode configuration
   */
  async getEndlessConfig(): Promise<EndlessModeConfig> {
    return this.endlessMemoryServices.getEndlessConfig();
  }

  /**
   * Set Endless Mode configuration
   */
  async setEndlessConfig(config: Partial<EndlessModeConfig>): Promise<void> {
    return this.endlessMemoryServices.setEndlessConfig(config);
  }

  /**
   * Set memory mode (session or endless)
   */
  async setMode(mode: MemoryMode): Promise<void> {
    return this.endlessMemoryServices.setMode(mode);
  }

  /**
   * Get current memory mode
   */
  getMode(): MemoryMode {
    return this.endlessMemoryServices.getMode();
  }

  /**
   * Check if endless mode is active
   */
  isEndlessModeActive(): boolean {
    return this.endlessMemoryServices.isEndlessModeActive();
  }

  /**
   * Add event to Working Set (Endless Mode)
   */
  async addToWorkingSet(eventId: string, relevanceScore?: number): Promise<void> {
    return this.endlessMemoryServices.addToWorkingSet(eventId, relevanceScore);
  }

  /**
   * Get the current Working Set
   */
  async getWorkingSet(): Promise<WorkingSet | null> {
    return this.endlessMemoryServices.getWorkingSet();
  }

  /**
   * Search consolidated memories
   */
  async searchConsolidated(
    query: string,
    options?: { topK?: number }
  ): Promise<ConsolidatedMemory[]> {
    return this.endlessMemoryServices.searchConsolidated(query, options);
  }

  /**
   * Get all consolidated memories
   */
  async getConsolidatedMemories(limit?: number): Promise<ConsolidatedMemory[]> {
    return this.endlessMemoryServices.getConsolidatedMemories(limit);
  }

  /**
   * Increment access count for memories that were used in prompts
   */
  async incrementMemoryAccess(eventIds: string[]): Promise<void> {
    return this.retrievalOrchestrator.incrementMemoryAccess(eventIds);
  }

  /**
   * Get most accessed memories from events
   */
  async getMostAccessedMemories(limit: number = 10): Promise<AccessedMemory[]> {
    return this.retrievalAnalyticsService.getMostAccessedMemories(limit);
  }

  /**
   * Record a memory retrieval for helpfulness tracking
   */
  async recordRetrieval(eventId: string, sessionId: string, score: number, query: string): Promise<void> {
    return this.retrievalOrchestrator.recordRetrieval(eventId, sessionId, score, query);
  }

  /**
   * Record a query-level retrieval trace (used by user-prompt-submit hook).
   * Feeds the retrieval_traces table that powers dashboard stats.
   */
  async recordQueryTrace(input: RecordQueryTraceInput): Promise<void> {
    return this.retrievalOrchestrator.recordQueryTrace(input);
  }

  /**
   * Evaluate helpfulness of retrievals in a session (called at session end)
   */
  async evaluateSessionHelpfulness(sessionId: string): Promise<void> {
    await this.retrievalAnalyticsService.evaluateSessionHelpfulness(sessionId);
  }

  /**
   * Backfill helpfulness evaluation for sessions that ended without Stop hook.
   * Call on first turn of a new session to catch missed evaluations.
   */
  async evaluatePendingSessions(currentSessionId: string): Promise<void> {
    await this.retrievalAnalyticsService.evaluatePendingSessions(currentSessionId);
  }

  /**
   * Get most helpful memories ranked by helpfulness score
   */
  async getHelpfulMemories(limit: number = 10): Promise<HelpfulMemory[]> {
    return this.retrievalAnalyticsService.getHelpfulMemories(limit);
  }

  /**
   * Get helpfulness statistics for dashboard
   */
  async getHelpfulnessStats(): Promise<HelpfulnessStats> {
    return this.retrievalAnalyticsService.getHelpfulnessStats();
  }

  /**
   * Mark a consolidated memory as accessed
   */
  async markMemoryAccessed(memoryId: string): Promise<void> {
    return this.endlessMemoryServices.markMemoryAccessed(memoryId);
  }

  /**
   * Calculate continuity score for current context
   */
  async calculateContinuity(
    content: string,
    metadata?: { files?: string[]; entities?: string[] }
  ): Promise<ContinuityScore | null> {
    return this.endlessMemoryServices.calculateContinuity(content, metadata);
  }

  /**
   * Record activity (for consolidation idle trigger)
   */
  recordActivity(): void {
    this.endlessMemoryServices.recordActivity();
  }

  /**
   * Force a consolidation run
   */
  async forceConsolidation(): Promise<number> {
    return this.endlessMemoryServices.forceConsolidation();
  }

  /**
   * Get Endless Mode status
   */
  async getEndlessModeStatus(): Promise<EndlessModeStatus> {
    return this.endlessMemoryServices.getEndlessModeStatus();
  }

  // ============================================================
  // Turn Grouping Methods
  // ============================================================

  /**
   * Get events grouped by turn for a session
   */
  async getSessionTurns(sessionId: string, options?: { limit?: number; offset?: number }): Promise<Array<{
    turnId: string;
    events: MemoryEvent[];
    startedAt: Date;
    promptPreview: string;
    eventCount: number;
    toolCount: number;
    hasResponse: boolean;
  }>> {
    return this.queryService.getSessionTurns(sessionId, options);
  }

  /**
   * Get all events for a specific turn
   */
  async getEventsByTurn(turnId: string): Promise<MemoryEvent[]> {
    return this.queryService.getEventsByTurn(turnId);
  }

  /**
   * Count total turns for a session
   */
  async countSessionTurns(sessionId: string): Promise<number> {
    return this.queryService.countSessionTurns(sessionId);
  }

  /**
   * Backfill turn_ids from metadata for events stored before the migration
   */
  async backfillTurnIds(): Promise<number> {
    return this.queryService.backfillTurnIds();
  }

  /**
   * Delete all events for a session (for force reimport)
   */
  async deleteSessionEvents(sessionId: string): Promise<number> {
    return this.queryService.deleteSessionEvents(sessionId);
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
   * Force a graduation evaluation run
   */
  async forceGraduation(): Promise<GraduationRunResult> {
    return this.runtimeService.forceGraduation();
  }

  /**
   * Record access to a memory event (for graduation scoring)
   */
  recordMemoryAccess(eventId: string, sessionId: string, confidence: number = 1.0): void {
    this.graduation.recordAccess(eventId, sessionId, confidence);
  }

  getEmbeddingModelName(): string {
    return this.embedder.getModelName();
  }

  /**
   * Ensure embedding model metadata is in sync and optionally migrate vectors.
   * Migration strategy: clear vector index + clear embedding outbox + re-enqueue all events.
   */
  async ensureEmbeddingModelForImport(
    options?: EmbeddingModelMaintenanceOptions
  ): Promise<EmbeddingModelMaintenanceResult> {
    return this.embeddingMaintenanceService.ensureEmbeddingModelForImport(options);
  }

  /**
   * Backward-compatible alias used by some hooks
   */
  async close(): Promise<void> {
    await this.shutdown();
  }

  /**
   * Shutdown service
   */
  async shutdown(): Promise<void> {
    await this.runtimeService.shutdown();
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

// ============================================================
// Service Instance Management
// ============================================================

// Instance cache: Map from project hash (or '__global__') to MemoryService
const serviceCache = new Map<string, MemoryService>();
const GLOBAL_KEY = '__global__';

/**
 * Get the global memory service (backward compatibility)
 * Use this for operations not tied to a specific project
 * Note: analyticsEnabled=false and sharedStore disabled to avoid DuckDB lock conflicts
 */
export function getDefaultMemoryService(): MemoryService {
  if (!serviceCache.has(GLOBAL_KEY)) {
    serviceCache.set(GLOBAL_KEY, new MemoryService({
      storagePath: '~/.claude-code/memory',
      analyticsEnabled: false,  // Hooks don't need DuckDB
      sharedStoreConfig: DISABLED_SHARED_STORE_CONFIG  // Shared store uses DuckDB too
    }));
  }
  return serviceCache.get(GLOBAL_KEY)!;
}

/**
 * Get a read-only global memory service
 * Use this for web server/dashboard that only needs to read data
 * Creates a fresh connection each time to avoid blocking the main writer process
 * Uses SQLite (WAL mode) which supports concurrent readers
 */
export function getReadOnlyMemoryService(): MemoryService {
  // Don't cache - create fresh instance each time to avoid holding locks
  // The connection will be closed when the request completes
  // Uses SQLite which supports concurrent readers via WAL mode
  return new MemoryService({
    storagePath: '~/.claude-code/memory',
    readOnly: true,
    analyticsEnabled: false,  // Use SQLite for reads (WAL supports concurrent readers)
    sharedStoreConfig: DISABLED_SHARED_STORE_CONFIG  // Skip shared store for now
  });
}

/**
 * Get memory service for a specific project path
 * Creates isolated storage at ~/.claude-code/memory/projects/{hash}/
 * Note: analyticsEnabled=false and sharedStore disabled to avoid DuckDB lock conflicts
 */
export function getMemoryServiceForProject(
  projectPath: string,
  sharedStoreConfig?: SharedStoreConfig
): MemoryService {
  const hash = hashProjectPath(projectPath);

  if (!serviceCache.has(hash)) {
    const storagePath = getProjectStoragePath(projectPath);
    serviceCache.set(hash, new MemoryService({
      storagePath,
      projectHash: hash,
      projectPath,
      // Override shared store config - hooks don't need DuckDB
      sharedStoreConfig: sharedStoreConfig ?? DISABLED_SHARED_STORE_CONFIG,
      analyticsEnabled: false  // Hooks don't need DuckDB
    }));
  }

  return serviceCache.get(hash)!;
}

/**
 * Get memory service for a session by looking up its project
 * Falls back to global storage if session not found in registry
 */
export function getMemoryServiceForSession(sessionId: string): MemoryService {
  const projectInfo = getSessionProject(sessionId);

  if (projectInfo) {
    return getMemoryServiceForProject(projectInfo.projectPath);
  }

  // Fallback to global storage for unknown sessions (backward compat)
  return getDefaultMemoryService();
}

/**
 * Get a lightweight memory service for hooks
 * Only initializes SQLite - no embedder, no vector store, no workers
 * This is FAST (<100ms) compared to full initialization (3-5s)
 */
export function getLightweightMemoryService(sessionId: string): MemoryService {
  const projectInfo = getSessionProject(sessionId);
  const key = projectInfo ? `lightweight_${projectInfo.projectHash}` : 'lightweight_global';

  if (!serviceCache.has(key)) {
    const storagePath = projectInfo
      ? getProjectStoragePath(projectInfo.projectPath)
      : path.join(os.homedir(), '.claude-code', 'memory');

    serviceCache.set(key, new MemoryService({
      storagePath,
      projectHash: projectInfo?.projectHash,
      projectPath: projectInfo?.projectPath,
      lightweightMode: true,  // Skip embedder/vector/workers
      analyticsEnabled: false,
      sharedStoreConfig: DISABLED_SHARED_STORE_CONFIG
    }));
  }

  return serviceCache.get(key)!;
}

export function createMemoryService(config: MemoryServiceConfig): MemoryService {
  return new MemoryService(config);
}
