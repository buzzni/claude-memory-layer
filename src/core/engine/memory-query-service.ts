import type {
  CoreMemoryBlock,
  MemoryEvent,
  MemoryLesson,
  OutboxStats,
  OutboxStatsOptions,
  OutboxRecoveryOptions,
  OutboxRecoveryResult,
  ProjectScopeRepairOptions,
  ProjectScopeRepairResult
} from '../types.js';
import type { DerivationLiveness, RecentEventsReadOptions } from '../sqlite-event-store.js';
import type { SQLiteDatabase } from '../sqlite-wrapper.js';
import { LessonRepository } from '../operations/lesson-repository.js';
import { CoreMemoryBlockRepository } from '../operations/core-memory-block-repository.js';
import {
  CanonicalMemoryInjectionService,
  type CanonicalMemoryInjection
} from '../operations/canonical-memory-injection-service.js';

interface RankedKeywordResult {
  event: MemoryEvent;
  rank: number;
}

export interface GraduatedEvidenceResult extends RankedKeywordResult {
  level: string;
  accessCount: number;
}

export interface MemorySessionTurn {
  turnId: string;
  events: MemoryEvent[];
  startedAt: Date;
  promptPreview: string;
  eventCount: number;
  toolCount: number;
  hasResponse: boolean;
}

export type MemoryOutboxStats = OutboxStats;

export interface MemoryStats {
  totalEvents: number;
  vectorCount: number;
  levelStats: Array<{ level: string; count: number }>;
}

interface QueryStore {
  keywordSearch(query: string, topK: number, options?: { includeToolObservations?: boolean }): Promise<RankedKeywordResult[]>;
  searchGraduatedEvidence?(query: string, limit: number): Promise<GraduatedEvidenceResult[]>;
  getEvent(id: string): Promise<MemoryEvent | null>;
  getSessionEvents(sessionId: string): Promise<MemoryEvent[]>;
  getRecentEvents(limit: number, options?: RecentEventsReadOptions): Promise<MemoryEvent[]>;
  countEvents?(): Promise<number>;
  /** Present on the SQLite store; lessons live outside the events table. */
  getDatabase?(): SQLiteDatabase;
}

interface QueryMaintenanceStore extends QueryStore {
  rebuildFtsIndex(): Promise<number>;
  getOutboxStats(options?: OutboxStatsOptions): Promise<MemoryOutboxStats>;
  recoverStuckOutboxItems(options?: OutboxRecoveryOptions): Promise<OutboxRecoveryResult>;
  repairLegacyProjectScope(options?: ProjectScopeRepairOptions): Promise<ProjectScopeRepairResult>;
  getEventsByLevel(level: string, options?: { limit?: number; offset?: number }): Promise<MemoryEvent[]>;
  getEventLevel(eventId: string): Promise<string | null>;
  getSessionTurns(sessionId: string, options?: { limit?: number; offset?: number }): Promise<MemorySessionTurn[]>;
  getEventsByTurn(turnId: string): Promise<MemoryEvent[]>;
  getEventByCitationId(citationId: string): Promise<MemoryEvent | null>;
  getEventsAfter(sinceIso: string): Promise<MemoryEvent[]>;
  getEventTypeCounts(): Promise<Array<{ eventType: string; count: number }>>;
  getDistinctSessionCount(): Promise<number>;
  getDailyEventCounts(sinceIso: string): Promise<Array<{ day: string; total: number; prompts: number; responses: number; tools: number }>>;
  countSessionTurns(sessionId: string): Promise<number>;
  backfillTurnIds(): Promise<number>;
  deleteSessionEvents(sessionId: string): Promise<number>;
  getDerivationLiveness(projectHash?: string): Promise<DerivationLiveness>;
}

interface MemoryQueryServiceDeps {
  vectorStore: { count(): Promise<number> };
  graduation: { getStats(): Promise<Array<{ level: string; count: number }>> };
}

/**
 * Thin-core query service for lightweight read and maintenance paths.
 *
 * Higher-level retrieval orchestration lives in RetrievalOrchestrator;
 * this service keeps storage-backed read models and maintenance delegates separate.
 */
export class MemoryQueryService {
  constructor(
    private readonly initialize: () => Promise<void>,
    private readonly queryStore: QueryStore,
    private readonly deps?: MemoryQueryServiceDeps
  ) {}

  /**
   * Curated lessons for prompt injection.
   *
   * Lessons are stored outside the events table, so they never appear in
   * semantic or keyword retrieval. Without this lookup the whole lesson feature
   * is write-only: an agent can save runbooks that nothing will ever surface.
   */
  async listProjectLessons(projectHash: string, limit = 25): Promise<MemoryLesson[]> {
    await this.initialize();
    const db = this.queryStore.getDatabase?.();
    if (!db || !projectHash) return [];
    try {
      return await new LessonRepository(db).list({ projectHash, limit });
    } catch {
      // Lesson retrieval is supplementary: never fail a prompt over it.
      return [];
    }
  }

  async listProjectLessonInjections(
    projectHash: string,
    actorId: string | undefined,
    limit = 25
  ): Promise<CanonicalMemoryInjection<MemoryLesson>[]> {
    await this.initialize();
    const db = this.queryStore.getDatabase?.();
    if (!db || !projectHash) return [];
    try {
      const lessons = await new LessonRepository(db).list({ projectHash, limit });
      return new CanonicalMemoryInjectionService(db).select({
        projectHash,
        actorId,
        lane: 'prompt',
        candidates: lessons.map((lesson) => ({
          canonicalType: 'lesson',
          canonicalId: lesson.lessonId,
          value: lesson
        }))
      }).items;
    } catch {
      // Injection is supplementary: a missing actor in an enforcement mode
      // must fail closed without breaking the surrounding hook.
      return [];
    }
  }

  /**
   * Core memory blocks (project/user) for legacy unconditional session-start
   * injection. Stored outside the events table, same reasoning as lessons:
   * without this lookup, agent self-edits via mem-core-block-update would
   * never resurface anywhere.
   */
  async getCoreMemoryBlocks(projectHash: string): Promise<CoreMemoryBlock[]> {
    await this.initialize();
    const db = this.queryStore.getDatabase?.();
    if (!db || !projectHash) return [];
    try {
      return await new CoreMemoryBlockRepository(db).listByProject(projectHash);
    } catch {
      // Core memory block injection is supplementary: never fail a prompt over it.
      return [];
    }
  }

  async getCoreMemoryBlockInjections(
    projectHash: string,
    actorId: string | undefined
  ): Promise<CanonicalMemoryInjection<CoreMemoryBlock>[]> {
    await this.initialize();
    const db = this.queryStore.getDatabase?.();
    if (!db || !projectHash) return [];
    try {
      const blocks = await new CoreMemoryBlockRepository(db).listByProject(projectHash);
      return new CanonicalMemoryInjectionService(db).select({
        projectHash,
        actorId,
        lane: 'session_start',
        candidates: blocks.map((block) => ({
          canonicalType: 'core_memory_block',
          canonicalId: block.blockKey,
          value: block
        }))
      }).items;
    } catch {
      // Same fail-closed hook behavior as curated lessons above.
      return [];
    }
  }

  async keywordSearch(
    query: string,
    options?: { topK?: number; minScore?: number; includeToolObservations?: boolean }
  ): Promise<Array<{ event: MemoryEvent; score: number }>> {
    await this.initialize();

    const results = await this.queryStore.keywordSearch(query, options?.topK ?? 10, {
      includeToolObservations: options?.includeToolObservations
    });
    if (results.length === 0) return [];

    // FTS5/BM25 ranks are ordered ascending: the smallest value is the best.
    // Normalize best->1 and worst->0. The previous formula inverted this and
    // filtered exact matches while retaining the weakest tail results.
    const bestRank = Math.min(...results.map((r) => r.rank));
    const worstRank = Math.max(...results.map((r) => r.rank));
    const rankRange = worstRank - bestRank;

    return results
      .map((r) => ({
        event: r.event,
        score: rankRange === 0 ? 1 : 1 - (r.rank - bestRank) / rankRange
      }))
      .filter((r) => !options?.minScore || r.score >= options.minScore);
  }

  async searchGraduatedEvidence(query: string, limit: number = 10): Promise<GraduatedEvidenceResult[]> {
    await this.initialize();
    if (!this.queryStore.searchGraduatedEvidence) return [];
    return this.queryStore.searchGraduatedEvidence(query, limit);
  }

  async getEvent(id: string): Promise<MemoryEvent | null> {
    await this.initialize();
    return this.queryStore.getEvent(id);
  }

  async getEventByCitationId(citationId: string): Promise<MemoryEvent | null> {
    await this.initialize();
    return this.getMaintenanceStore('getEventByCitationId').getEventByCitationId(citationId);
  }

  async getEventsAfter(sinceIso: string): Promise<MemoryEvent[]> {
    await this.initialize();
    return this.getMaintenanceStore('getEventsAfter').getEventsAfter(sinceIso);
  }

  async getEventTypeCounts(): Promise<Array<{ eventType: string; count: number }>> {
    await this.initialize();
    return this.getMaintenanceStore('getEventTypeCounts').getEventTypeCounts();
  }

  async getDistinctSessionCount(): Promise<number> {
    await this.initialize();
    return this.getMaintenanceStore('getDistinctSessionCount').getDistinctSessionCount();
  }

  async getDailyEventCounts(
    sinceIso: string
  ): Promise<Array<{ day: string; total: number; prompts: number; responses: number; tools: number }>> {
    await this.initialize();
    return this.getMaintenanceStore('getDailyEventCounts').getDailyEventCounts(sinceIso);
  }

  async getSessionHistory(sessionId: string): Promise<MemoryEvent[]> {
    await this.initialize();
    return this.queryStore.getSessionEvents(sessionId);
  }

  async getRecentEvents(limit: number = 100, options?: RecentEventsReadOptions): Promise<MemoryEvent[]> {
    await this.initialize();
    return this.queryStore.getRecentEvents(limit, options);
  }

  async rebuildFtsIndex(): Promise<number> {
    await this.initialize();
    return this.getMaintenanceStore('rebuildFtsIndex').rebuildFtsIndex();
  }

  async getOutboxStats(options?: OutboxStatsOptions): Promise<MemoryOutboxStats> {
    await this.initialize();
    return this.getMaintenanceStore('getOutboxStats').getOutboxStats(options);
  }

  async recoverStuckOutboxItems(options?: OutboxRecoveryOptions): Promise<OutboxRecoveryResult> {
    await this.initialize();
    return this.getMaintenanceStore('recoverStuckOutboxItems').recoverStuckOutboxItems(options);
  }

  async repairLegacyProjectScope(options?: ProjectScopeRepairOptions): Promise<ProjectScopeRepairResult> {
    await this.initialize();
    return this.getMaintenanceStore('repairLegacyProjectScope').repairLegacyProjectScope(options);
  }

  async getStats(): Promise<MemoryStats> {
    await this.initialize();

    const deps = this.getStatsDeps();
    // Counting via SQL, not by materializing rows: the old
    // getRecentEvents(10000).length both capped the reported total at 10k and
    // loaded every event body into memory to produce a single number.
    const totalEvents = this.queryStore.countEvents
      ? await this.queryStore.countEvents()
      : (await this.queryStore.getRecentEvents(10000)).length;
    const vectorCount = await deps.vectorStore.count();
    const levelStats = await deps.graduation.getStats();

    return {
      totalEvents,
      vectorCount,
      levelStats
    };
  }

  async getEventsByLevel(level: string, options?: { limit?: number; offset?: number }): Promise<MemoryEvent[]> {
    await this.initialize();
    return this.getMaintenanceStore('getEventsByLevel').getEventsByLevel(level, options);
  }

  async getEventLevel(eventId: string): Promise<string | null> {
    await this.initialize();
    return this.getMaintenanceStore('getEventLevel').getEventLevel(eventId);
  }

  async getDerivationLiveness(projectHash?: string): Promise<DerivationLiveness> {
    await this.initialize();
    return this.getMaintenanceStore('getDerivationLiveness').getDerivationLiveness(projectHash);
  }

  async getSessionTurns(
    sessionId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<MemorySessionTurn[]> {
    await this.initialize();
    return this.getMaintenanceStore('getSessionTurns').getSessionTurns(sessionId, options);
  }

  async getEventsByTurn(turnId: string): Promise<MemoryEvent[]> {
    await this.initialize();
    return this.getMaintenanceStore('getEventsByTurn').getEventsByTurn(turnId);
  }

  async countSessionTurns(sessionId: string): Promise<number> {
    await this.initialize();
    return this.getMaintenanceStore('countSessionTurns').countSessionTurns(sessionId);
  }

  async backfillTurnIds(): Promise<number> {
    await this.initialize();
    return this.getMaintenanceStore('backfillTurnIds').backfillTurnIds();
  }

  async deleteSessionEvents(sessionId: string): Promise<number> {
    await this.initialize();
    return this.getMaintenanceStore('deleteSessionEvents').deleteSessionEvents(sessionId);
  }

  private getMaintenanceStore(method: keyof QueryMaintenanceStore): QueryMaintenanceStore {
    const store = this.queryStore as QueryStore & Partial<QueryMaintenanceStore>;
    if (typeof store[method] !== 'function') {
      throw new Error(`MemoryQueryService requires queryStore.${String(method)}() for this operation`);
    }
    return store as QueryMaintenanceStore;
  }

  private getStatsDeps(): MemoryQueryServiceDeps {
    if (!this.deps) {
      throw new Error('MemoryQueryService requires vectorStore and graduation dependencies for getStats()');
    }
    return this.deps;
  }
}
