import type {
  MemoryEvent,
  OutboxStats,
  OutboxStatsOptions,
  OutboxRecoveryOptions,
  OutboxRecoveryResult,
  ProjectScopeRepairOptions,
  ProjectScopeRepairResult
} from '../types.js';

interface RankedKeywordResult {
  event: MemoryEvent;
  rank: number;
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
  keywordSearch(query: string, topK: number): Promise<RankedKeywordResult[]>;
  getEvent(id: string): Promise<MemoryEvent | null>;
  getSessionEvents(sessionId: string): Promise<MemoryEvent[]>;
  getRecentEvents(limit: number): Promise<MemoryEvent[]>;
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
  countSessionTurns(sessionId: string): Promise<number>;
  backfillTurnIds(): Promise<number>;
  deleteSessionEvents(sessionId: string): Promise<number>;
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

  async keywordSearch(
    query: string,
    options?: { topK?: number; minScore?: number }
  ): Promise<Array<{ event: MemoryEvent; score: number }>> {
    await this.initialize();

    const results = await this.queryStore.keywordSearch(query, options?.topK ?? 10);
    if (results.length === 0) return [];

    const maxRank = Math.min(...results.map((r) => r.rank), -0.001);
    const minRank = Math.max(...results.map((r) => r.rank), -1000);
    const rankRange = maxRank - minRank || 1;

    return results
      .map((r) => ({
        event: r.event,
        score: 1 - (r.rank - minRank) / rankRange
      }))
      .filter((r) => !options?.minScore || r.score >= options.minScore);
  }

  async getEvent(id: string): Promise<MemoryEvent | null> {
    await this.initialize();
    return this.queryStore.getEvent(id);
  }

  async getSessionHistory(sessionId: string): Promise<MemoryEvent[]> {
    await this.initialize();
    return this.queryStore.getSessionEvents(sessionId);
  }

  async getRecentEvents(limit: number = 100): Promise<MemoryEvent[]> {
    await this.initialize();
    return this.queryStore.getRecentEvents(limit);
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
    const recentEvents = await this.queryStore.getRecentEvents(10000);
    const vectorCount = await deps.vectorStore.count();
    const levelStats = await deps.graduation.getStats();

    return {
      totalEvents: recentEvents.length,
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
