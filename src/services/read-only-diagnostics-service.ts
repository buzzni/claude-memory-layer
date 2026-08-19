/**
 * Uncached, read-only composition for status, stats, audit, and dashboard reads.
 *
 * Unlike MemoryService this composition owns no embedder, background worker, or
 * process-level cache entry. Missing stores are represented by the same service
 * with empty aggregate results, so callers do not need to initialize storage to
 * render a no-store response.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  resolveExistingStore,
  type ExistingStoreResolution,
  type ExistingStoreResolverOptions,
  type ExistingStoreStatus
} from '../core/registry/existing-store.js';
import {
  SQLiteEventStore,
  type DerivationLiveness,
  type RecentEventsReadOptions
} from '../core/sqlite-event-store.js';
import { VectorStore } from '../core/vector-store.js';
import { sqliteGet, toDateFromSQLite } from '../core/sqlite-wrapper.js';
import type { RetrievalTelemetryStats } from '../core/retrieval-telemetry.js';
import type {
  MemoryEvent,
  EndlessModeStatus,
  OutboxQueueStats,
  OutboxRecoveryOptions,
  OutboxRecoveryResult,
  OutboxStats,
  OutboxStatsOptions
} from '../core/types.js';
import type {
  AccessedMemory,
  DailyHelpfulnessStats,
  HelpfulMemory,
  HelpfulnessStats,
  RetrievalTrace,
  RetrievalTraceStats,
  UsefulnessHistoryEntry,
  UsefulnessHistoryOptions
} from '../core/engine/retrieval-analytics-service.js';

export interface DiagnosticsStats {
  totalEvents: number;
  vectorCount: number;
  levelStats: Array<{ level: string; count: number }>;
}

export class MemoryStoreResolutionError extends Error {
  constructor(readonly storeStatus: Exclude<ExistingStoreStatus, 'existing' | 'missing'>) {
    super(`Memory store is ${storeStatus}`);
    this.name = 'MemoryStoreResolutionError';
  }
}

export class ReadOnlyDiagnosticsService {
  readonly storeStatus: ExistingStoreStatus;
  private readonly resolution: ExistingStoreResolution;
  private readonly sqliteStore: SQLiteEventStore | null;
  private initialized = false;
  private closed = false;

  constructor(resolution: ExistingStoreResolution) {
    this.resolution = resolution;
    this.storeStatus = resolution.status;
    this.sqliteStore = resolution.status === 'existing' && resolution.databasePath
      ? new SQLiteEventStore(resolution.databasePath, { readonly: true, snapshot: true, vectorOutbox: false })
      : null;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.sqliteStore?.initialize();
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.sqliteStore?.close();
  }

  async getStats(): Promise<DiagnosticsStats> {
    const store = await this.store();
    if (!store) return emptyDiagnosticsStats();
    const [totalEvents, vectorCount, levelStats] = await Promise.all([
      store.countEvents(),
      this.countVectors(),
      tolerateMissingTable(() => store.getLevelStats(), [])
    ]);
    return { totalEvents, vectorCount, levelStats };
  }

  async getOutboxStats(options?: OutboxStatsOptions): Promise<OutboxStats> {
    const store = await this.store();
    if (!store) return emptyOutboxStats();
    return tolerateMissingTable(() => store.getOutboxStats(options), emptyOutboxStats());
  }

  async previewOutboxRecovery(options?: OutboxRecoveryOptions): Promise<OutboxRecoveryResult> {
    const store = await this.store();
    if (!store) return emptyOutboxRecoveryResult();
    return tolerateMissingTable(
      () => store.recoverStuckOutboxItems({ ...options, dryRun: true }),
      emptyOutboxRecoveryResult()
    );
  }

  async getDerivationLiveness(): Promise<DerivationLiveness> {
    const store = await this.store();
    if (!store) return emptyDerivationLiveness();
    return tolerateMissingTable(
      () => store.getDerivationLiveness(this.resolution.projectHash),
      emptyDerivationLiveness()
    );
  }

  async getEventTypeCounts(): Promise<Array<{ eventType: string; count: number }>> {
    return (await this.store())?.getEventTypeCounts() ?? [];
  }

  async getDistinctSessionCount(): Promise<number> {
    return (await this.store())?.getDistinctSessionCount() ?? 0;
  }

  async getDailyEventCounts(
    sinceIso: string
  ): Promise<Array<{ day: string; total: number; prompts: number; responses: number; tools: number }>> {
    return (await this.store())?.getDailyEventCounts(sinceIso) ?? [];
  }

  async getRecentEvents(limit: number = 100, options?: RecentEventsReadOptions): Promise<MemoryEvent[]> {
    return (await this.store())?.getRecentEvents(limit, options) ?? [];
  }

  async getSessionHistory(sessionId: string): Promise<MemoryEvent[]> {
    return (await this.store())?.getSessionEvents(sessionId) ?? [];
  }

  async getSessionTurns(sessionId: string, options?: { limit?: number; offset?: number }) {
    return (await this.store())?.getSessionTurns(sessionId, options) ?? [];
  }

  async getEventsByTurn(turnId: string): Promise<MemoryEvent[]> {
    return (await this.store())?.getEventsByTurn(turnId) ?? [];
  }

  async countSessionTurns(sessionId: string): Promise<number> {
    return (await this.store())?.countSessionTurns(sessionId) ?? 0;
  }

  async getEvent(id: string): Promise<MemoryEvent | null> {
    return (await this.store())?.getEvent(id) ?? null;
  }

  async getEventByCitationId(citationId: string): Promise<MemoryEvent | null> {
    return (await this.store())?.getEventByCitationId(citationId) ?? null;
  }

  async getEventsByLevel(level: string, options?: { limit?: number; offset?: number }): Promise<MemoryEvent[]> {
    const store = await this.store();
    if (!store) return [];
    return tolerateMissingTable(() => store.getEventsByLevel(level, options), []);
  }

  async getEventsAfter(sinceIso: string): Promise<MemoryEvent[]> {
    return (await this.store())?.getEventsAfter(sinceIso) ?? [];
  }

  async getRetrievalTraceStats(): Promise<RetrievalTraceStats> {
    const store = await this.store();
    if (!store) return emptyRetrievalTraceStats();
    return tolerateMissingTable(() => store.getRetrievalTraceStats(), emptyRetrievalTraceStats());
  }

  async getRetrievalTelemetryStats(): Promise<RetrievalTelemetryStats> {
    const store = await this.store();
    if (!store) return emptyRetrievalTelemetryStats();
    return tolerateMissingTable(
      () => store.getRetrievalTelemetryStats(),
      emptyRetrievalTelemetryStats()
    );
  }

  async getRecentRetrievalTraces(limit: number = 50): Promise<RetrievalTrace[]> {
    const store = await this.store();
    if (!store) return [];
    return tolerateMissingTable(() => store.getRecentRetrievalTraces(limit), []);
  }

  async getMostAccessedMemories(limit: number = 10): Promise<AccessedMemory[]> {
    const store = await this.store();
    if (!store) return [];
    const events = await store.getMostAccessed(limit);
    return events.map((event) => {
      const access = event as MemoryEvent & { access_count?: number; last_accessed_at?: string | null };
      return {
        memoryId: event.id,
        summary: event.content.substring(0, 200) + (event.content.length > 200 ? '...' : ''),
        topics: extractTopics(event.content),
        accessCount: access.access_count || 0,
        lastAccessed: access.last_accessed_at || null,
        confidence: 1,
        createdAt: event.timestamp
      };
    });
  }

  async getHelpfulMemories(limit: number = 10): Promise<HelpfulMemory[]> {
    const store = await this.store();
    if (!store) return [];
    return tolerateMissingTable(() => store.getHelpfulMemories(limit), []);
  }

  async getHelpfulnessStats(since?: Date, until?: Date): Promise<HelpfulnessStats> {
    const store = await this.store();
    if (!store) return emptyHelpfulnessStats();
    return tolerateMissingTable(() => store.getHelpfulnessStats(since, until), emptyHelpfulnessStats());
  }

  async getHelpfulnessStatsByDay(since: Date, until: Date): Promise<DailyHelpfulnessStats[]> {
    const store = await this.store();
    if (!store) return [];
    return tolerateMissingTable(() => store.getHelpfulnessStatsByDay(since, until), []);
  }

  async getUsefulnessHistory(options: UsefulnessHistoryOptions = {}): Promise<UsefulnessHistoryEntry[]> {
    const store = await this.store();
    if (!store) return [];
    return tolerateMissingTable(() => store.getUsefulnessHistory(options), []);
  }

  async getSharedStoreStats(): Promise<{
    total: number;
    averageConfidence: number;
    topTopics: Array<{ topic: string; count: number }>;
    totalUsageCount: number;
  } | null> {
    return null;
  }

  async getEndlessModeStatus(): Promise<EndlessModeStatus> {
    const store = await this.store();
    if (!store) return emptyEndlessModeStatus();
    const mode = await tolerateMissingTable(() => store.getEndlessConfig('mode'), null);
    const db = store.getDatabase();
    const aggregates = await tolerateMissingTable(async () => ({
      workingSetSize: Number(sqliteGet<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM working_set')?.count ?? 0),
      consolidatedCount: Number(sqliteGet<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM consolidated_memories')?.count ?? 0),
      lastConsolidation: sqliteGet<{ value: string | null }>(
        db,
        'SELECT MAX(created_at) AS value FROM consolidated_memories'
      )?.value ?? null,
      continuityScore: sqliteGet<{ value: number | null }>(
        db,
        'SELECT continuity_score AS value FROM continuity_log ORDER BY created_at DESC LIMIT 1'
      )?.value ?? null
    }), null);
    if (!aggregates) return { ...emptyEndlessModeStatus(), mode: mode === 'endless' ? 'endless' : 'session' };
    return {
      mode: mode === 'endless' ? 'endless' : 'session',
      workingSetSize: aggregates.workingSetSize,
      continuityScore: aggregates.continuityScore ?? 0.5,
      consolidatedCount: aggregates.consolidatedCount,
      lastConsolidation: aggregates.lastConsolidation
        ? toDateFromSQLite(aggregates.lastConsolidation)
        : null
    };
  }

  private async store(): Promise<SQLiteEventStore | null> {
    await this.initialize();
    return this.sqliteStore;
  }

  private async countVectors(): Promise<number> {
    const storagePath = this.resolution.storagePath;
    if (!storagePath) return 0;
    const vectorsPath = path.join(storagePath, 'vectors');
    if (!isLocalDirectory(vectorsPath)) return 0;
    return vectorStoreFor(vectorsPath).count();
  }
}

/**
 * LanceDB connections have no close/disconnect, so a per-request VectorStore
 * would leak native handles on every dashboard poll. One store per vectors
 * path for the process lifetime — bounded by the number of projects on the
 * machine — keeps the count query cheap and leak-free.
 */
const vectorStoreCache = new Map<string, VectorStore>();

function vectorStoreFor(vectorsPath: string): VectorStore {
  let store = vectorStoreCache.get(vectorsPath);
  if (!store) {
    store = new VectorStore(vectorsPath);
    vectorStoreCache.set(vectorsPath, store);
  }
  return store;
}

export function createReadOnlyDiagnosticsService(
  projectOrHash?: string,
  options: ExistingStoreResolverOptions = {}
): ReadOnlyDiagnosticsService {
  const resolution = resolveExistingStore(projectOrHash, options);
  if (resolution.status !== 'existing' && resolution.status !== 'missing') {
    throw new MemoryStoreResolutionError(resolution.status);
  }
  return new ReadOnlyDiagnosticsService(resolution);
}

export function emptyDiagnosticsStats(): DiagnosticsStats {
  return { totalEvents: 0, vectorCount: 0, levelStats: [] };
}

export function emptyOutboxStats(): OutboxStats {
  return { embedding: emptyOutboxQueue(), vector: emptyOutboxQueue() };
}

export function emptyDerivationLiveness(): DerivationLiveness {
  return {
    graduation: {
      attempts: 0,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastStatus: null,
      lastErrorCategory: null
    },
    sources: { graduatedEvents: 0, curatedLessons: 0 }
  };
}

function emptyOutboxQueue(): OutboxQueueStats {
  return {
    pending: 0,
    processing: 0,
    failed: 0,
    retryableFailed: 0,
    quarantinedFailed: 0,
    total: 0,
    stuckProcessing: 0,
    oldestProcessingAgeMs: null
  };
}

function emptyOutboxRecoveryResult(): OutboxRecoveryResult {
  return {
    embedding: { recoveredProcessing: 0, retriedFailed: 0 },
    vector: { recoveredProcessing: 0, retriedFailed: 0 }
  };
}

function emptyRetrievalTraceStats(): RetrievalTraceStats {
  return {
    totalQueries: 0,
    avgCandidateCount: 0,
    avgSelectedCount: 0,
    selectionRate: 0
  };
}

function emptyRetrievalTelemetryStats(): RetrievalTelemetryStats {
  return {
    deliveries: {
      totalTraces: 0,
      totalItems: 0,
      byPresentation: [],
      byTrigger: [],
      legacyUnknownRows: 0
    },
    evidenceGrounding: {
      evaluatedDeliveries: 0,
      groundedDeliveries: 0,
      groundingRate: 0,
      averageContentOverlap: 0
    },
    referenceNavigation: {
      eligibleTraces: 0,
      navigatedTraces: 0,
      navigationRate: 0,
      attributedOpenCount: 0,
      ambiguousOpenCount: 0,
      unattributedOpenCount: 0
    }
  };
}

function emptyHelpfulnessStats(): HelpfulnessStats {
  return {
    avgScore: 0,
    totalEvaluated: 0,
    totalRetrievals: 0,
    helpful: 0,
    neutral: 0,
    unhelpful: 0
  };
}

function emptyEndlessModeStatus(): EndlessModeStatus {
  return {
    mode: 'session',
    workingSetSize: 0,
    continuityScore: 0.5,
    consolidatedCount: 0,
    lastConsolidation: null
  };
}

async function tolerateMissingTable<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (/no such table/i.test(error instanceof Error ? error.message : String(error))) return fallback;
    throw error;
  }
}

function isLocalDirectory(targetPath: string): boolean {
  try {
    const stat = fs.lstatSync(targetPath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function extractTopics(content: string): string[] {
  const topics = new Set<string>();
  for (const heading of content.match(/^#{1,3}\s+(.+)$/gm) ?? []) {
    const text = heading.replace(/^#+\s+/, '').replace(/[*_`#]/g, '').trim();
    if (text.length > 2 && text.length < 50) topics.add(text);
    if (topics.size >= 5) return Array.from(topics);
  }
  for (const boldTerm of content.match(/\*\*([^*]+)\*\*/g) ?? []) {
    const text = boldTerm.replace(/\*\*/g, '').trim();
    if (text.length > 2 && text.length < 30) topics.add(text);
    if (topics.size >= 5) break;
  }
  return Array.from(topics);
}
