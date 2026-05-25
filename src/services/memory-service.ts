/**
 * Memory Service - Main entry point for memory operations
 * Coordinates EventStore, VectorStore, Retriever, and Graduation
 */

import * as os from 'os';

import type { RetrievalResult, UnifiedRetrievalResult } from '../core/retriever.js';
import type { PromotionResult } from '../core/shared-promoter.js';
import type { SharedMemoryServices } from '../extensions/shared-memory/index.js';
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
  Entry,
  OutboxStats,
  OutboxStatsOptions,
  OutboxRecoveryOptions,
  OutboxRecoveryResult,
  ProjectScopeRepairOptions,
  ProjectScopeRepairResult
} from '../core/types.js';
import type { EndlessMemoryServices } from '../extensions/endless-memory/index.js';
import {
  type EmbeddingMaintenanceService,
  type EmbeddingModelMaintenanceOptions,
  type EmbeddingModelMaintenanceResult
} from '../core/engine/embedding-maintenance-service.js';
import type { MemoryRuntimeService } from '../core/engine/memory-runtime-service.js';
import type { GraduationRunResult } from '../core/graduation-worker.js';
import type { IngestInterceptor } from '../core/ingest-interceptor.js';
import type { MemoryIngestService } from '../core/engine/memory-ingest-service.js';
import type { MemoryQueryService } from '../core/engine/memory-query-service.js';
import { createMemoryServiceComposition } from '../core/engine/memory-service-composition.js';
import {
  getProjectStoragePath as defaultGetProjectStoragePath,
  hashProjectPath as defaultHashProjectPath
} from '../core/registry/project-path.js';
import { getSessionProject as defaultGetSessionProject } from '../core/registry/session-registry.js';
import {
  DEFAULT_ENABLED_SHARED_STORE_CONFIG,
  DEFAULT_SHARED_STORAGE_PATH,
  DISABLED_SHARED_STORE_CONFIG,
  type MemoryServiceConfig
} from './memory-service-config.js';
import { createMemoryServiceRegistry } from './memory-service-registry.js';
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
export { getProjectStoragePath, hashProjectPath } from '../core/registry/project-path.js';
export {
  getSessionProject,
  registerSession,
  type SessionRegistry,
  type SessionRegistryEntry,
  loadSessionRegistry
} from '../core/registry/session-registry.js';

export {
  DEFAULT_ENABLED_SHARED_STORE_CONFIG,
  DEFAULT_SHARED_STORAGE_PATH,
  DISABLED_SHARED_STORE_CONFIG,
  type MemoryServiceConfig
} from './memory-service-config.js';

export class MemoryService {
  private readonly retrievalOrchestrator: RetrievalOrchestrator;
  private readonly retrievalDisclosureService: RetrievalDisclosureService;
  private readonly retrievalAnalyticsService: RetrievalAnalyticsService;
  private readonly embeddingMaintenanceService: EmbeddingMaintenanceService;
  private readonly runtimeService: MemoryRuntimeService;

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
    this.readOnly = config.readOnly ?? false;
    this.lightweightMode = config.lightweightMode ?? false;
    this.embeddingOnly = config.embeddingOnly ?? false;

    // Store project hash for shared store operations
    this.projectHash = config.projectHash || null;
    this.projectPath = config.projectPath || null;
    const sharedStoreConfig = config.sharedStoreConfig ?? DEFAULT_ENABLED_SHARED_STORE_CONFIG;

    const composition = createMemoryServiceComposition({
      config: {
        ...config,
        storagePath: config.storagePath,
        readOnly: this.readOnly,
        lightweightMode: this.lightweightMode,
        embeddingOnly: this.embeddingOnly,
        sharedStoreConfig
      },
      defaultSharedStoragePath: DEFAULT_SHARED_STORAGE_PATH,
      defaultSharedStoreConfig: DEFAULT_ENABLED_SHARED_STORE_CONFIG,
      initialize: () => this.initialize(),
      getProjectHash: () => this.projectHash,
      getProjectPath: () => this.projectPath
    });

    this.retrievalOrchestrator = composition.retrievalOrchestrator;
    this.retrievalDisclosureService = composition.retrievalDisclosureService;
    this.retrievalAnalyticsService = composition.retrievalAnalyticsService;
    this.ingestService = composition.ingestService;
    this.queryService = composition.queryService;
    this.endlessMemoryServices = composition.endlessMemoryServices;
    this.sharedMemoryServices = composition.sharedMemoryServices;
    this.runtimeService = composition.runtimeService;
    this.embeddingMaintenanceService = composition.embeddingMaintenanceService;
  }

  /**
   * Initialize all components
   */
  async initialize(): Promise<void> {
    await this.runtimeService.initialize();
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

  async getOutboxStats(options?: OutboxStatsOptions): Promise<OutboxStats> {
    return this.queryService.getOutboxStats(options);
  }

  async recoverStuckOutboxItems(options?: OutboxRecoveryOptions): Promise<OutboxRecoveryResult> {
    return this.queryService.recoverStuckOutboxItems(options);
  }

  async repairLegacyProjectScope(options?: ProjectScopeRepairOptions): Promise<ProjectScopeRepairResult> {
    return this.queryService.repairLegacyProjectScope(options);
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
  async getHelpfulnessStats(since?: Date): Promise<HelpfulnessStats> {
    return this.retrievalAnalyticsService.getHelpfulnessStats(since);
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
    return this.endlessMemoryServices.formatEndlessContext(query);
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
    this.runtimeService.recordMemoryAccess(eventId, sessionId, confidence);
  }

  getEmbeddingModelName(): string {
    return this.embeddingMaintenanceService.getEmbeddingModelName();
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
}

const defaultRegistry = createMemoryServiceRegistry<MemoryService>({
  createService: (config) => new MemoryService(config),
  hashProjectPath: defaultHashProjectPath,
  getProjectStoragePath: defaultGetProjectStoragePath,
  getSessionProject: defaultGetSessionProject,
  homedir: os.homedir,
  disabledSharedStoreConfig: DISABLED_SHARED_STORE_CONFIG
});

export const getDefaultMemoryService = defaultRegistry.getDefaultMemoryService;
export const getReadOnlyMemoryService = defaultRegistry.getReadOnlyMemoryService;
export const getMemoryServiceForProject = defaultRegistry.getMemoryServiceForProject;
export const getMemoryServiceForSession = defaultRegistry.getMemoryServiceForSession;
export const getLightweightMemoryService = defaultRegistry.getLightweightMemoryService;
export const getLightweightMemoryServiceForProject = defaultRegistry.getLightweightMemoryServiceForProject;
export const createMemoryService = defaultRegistry.createMemoryService;
