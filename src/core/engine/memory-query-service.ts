import type { MemoryEvent } from '../types.js';

interface RankedKeywordResult {
  event: MemoryEvent;
  rank: number;
}

interface QueryStore {
  keywordSearch(query: string, topK: number): Promise<RankedKeywordResult[]>;
  getSessionEvents(sessionId: string): Promise<MemoryEvent[]>;
  getRecentEvents(limit: number): Promise<MemoryEvent[]>;
}

/**
 * Thin-core query service for lightweight read paths.
 *
 * Higher-level retrieval orchestration lives in RetrievalOrchestrator;
 * this service keeps lightweight read responsibilities separate.
 */
export class MemoryQueryService {
  constructor(
    private readonly initialize: () => Promise<void>,
    private readonly queryStore: QueryStore
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

  async getSessionHistory(sessionId: string): Promise<MemoryEvent[]> {
    await this.initialize();
    return this.queryStore.getSessionEvents(sessionId);
  }

  async getRecentEvents(limit: number = 100): Promise<MemoryEvent[]> {
    await this.initialize();
    return this.queryStore.getRecentEvents(limit);
  }
}
