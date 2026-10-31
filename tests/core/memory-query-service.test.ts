import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryQueryService } from '../../src/core/engine/memory-query-service.js';
import type { MemoryEvent } from '../../src/core/types.js';

function event(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    eventType: 'user_prompt',
    sessionId: 'session-1',
    timestamp: new Date('2026-05-02T00:00:00.000Z'),
    content: 'default content',
    canonicalKey: 'default-content',
    dedupeKey: 'session-1:default-content',
    metadata: {},
    ...overrides
  };
}

function createService() {
  const initialize = vi.fn(async () => {});
  const events = [event()];
  const turn = {
    turnId: 'turn-1',
    events,
    startedAt: new Date('2026-05-02T00:00:00.000Z'),
    promptPreview: 'default content',
    eventCount: 1,
    toolCount: 0,
    hasResponse: false
  };
  const outboxStats = {
    embedding: { pending: 1, processing: 2, failed: 3, total: 6, stuckProcessing: 1, oldestProcessingAgeMs: 600000 },
    vector: { pending: 4, processing: 5, failed: 6, total: 15, stuckProcessing: 2, oldestProcessingAgeMs: 1200000 }
  };
  const outboxRecovery = {
    embedding: { recoveredProcessing: 1, retriedFailed: 0 },
    vector: { recoveredProcessing: 2, retriedFailed: 1 }
  };
  const projectScopeRepair = {
    dryRun: true,
    projectHash: 'abc12345',
    scanned: 4,
    repaired: 1,
    quarantined: 2,
    alreadyScoped: 1,
    skipped: 0,
    samples: []
  };
  const queryStore = {
    keywordSearch: vi.fn(async () => [{ event: events[0], rank: -0.5 }]),
    getSessionEvents: vi.fn(async () => events),
    getRecentEvents: vi.fn(async () => events),
    rebuildFtsIndex: vi.fn(async () => 7),
    getOutboxStats: vi.fn(async () => outboxStats),
    recoverStuckOutboxItems: vi.fn(async () => outboxRecovery),
    repairLegacyProjectScope: vi.fn(async () => projectScopeRepair),
    getEventsByLevel: vi.fn(async () => events),
    getEventLevel: vi.fn(async () => 'working'),
    getSessionTurns: vi.fn(async () => [turn]),
    getEventsByTurn: vi.fn(async () => events),
    countSessionTurns: vi.fn(async () => 11),
    backfillTurnIds: vi.fn(async () => 13),
    deleteSessionEvents: vi.fn(async () => 17),
    countEvents: vi.fn(async () => 31)
  };
  const vectorStore = {
    count: vi.fn(async () => 19),
    countAll: vi.fn(async () => 99)
  };
  const graduation = {
    getStats: vi.fn(async () => [{ level: 'working', count: 23 }])
  };

  return {
    service: new MemoryQueryService(initialize, queryStore, { vectorStore, graduation }),
    initialize,
    queryStore,
    vectorStore,
    graduation,
    events,
    turn,
    outboxStats,
    outboxRecovery,
    projectScopeRepair
  };
}

describe('MemoryQueryService', () => {
  it('delegates read and maintenance methods through the initialized store boundary', async () => {
    const { service, initialize, queryStore, events, turn, outboxStats, outboxRecovery, projectScopeRepair } = createService();

    await expect(service.rebuildFtsIndex()).resolves.toBe(7);
    await expect(service.getOutboxStats()).resolves.toEqual(outboxStats);
    await expect(service.recoverStuckOutboxItems({ stuckThresholdMs: 1234 })).resolves.toEqual(outboxRecovery);
    await expect(service.repairLegacyProjectScope({ projectPath: '/repo/app', dryRun: true })).resolves.toEqual(projectScopeRepair);
    await expect(service.getEventsByLevel('working', { limit: 2, offset: 3 })).resolves.toEqual(events);
    await expect(service.getEventLevel('event-1')).resolves.toBe('working');
    await expect(service.getSessionTurns('session-1', { limit: 5, offset: 8 })).resolves.toEqual([turn]);
    await expect(service.getEventsByTurn('turn-1')).resolves.toEqual(events);
    await expect(service.countSessionTurns('session-1')).resolves.toBe(11);
    await expect(service.backfillTurnIds()).resolves.toBe(13);
    await expect(service.deleteSessionEvents('session-1')).resolves.toBe(17);

    expect(initialize).toHaveBeenCalledTimes(11);
    expect(queryStore.rebuildFtsIndex).toHaveBeenCalledOnce();
    expect(queryStore.getOutboxStats).toHaveBeenCalledOnce();
    expect(queryStore.recoverStuckOutboxItems).toHaveBeenCalledWith({ stuckThresholdMs: 1234 });
    expect(queryStore.repairLegacyProjectScope).toHaveBeenCalledWith({ projectPath: '/repo/app', dryRun: true });
    expect(queryStore.getEventsByLevel).toHaveBeenCalledWith('working', { limit: 2, offset: 3 });
    expect(queryStore.getEventLevel).toHaveBeenCalledWith('event-1');
    expect(queryStore.getSessionTurns).toHaveBeenCalledWith('session-1', { limit: 5, offset: 8 });
    expect(queryStore.getEventsByTurn).toHaveBeenCalledWith('turn-1');
    expect(queryStore.countSessionTurns).toHaveBeenCalledWith('session-1');
    expect(queryStore.backfillTurnIds).toHaveBeenCalledOnce();
    expect(queryStore.deleteSessionEvents).toHaveBeenCalledWith('session-1');
  });

  it('composes memory statistics from event, vector, and graduation stores', async () => {
    const { service, initialize, queryStore, vectorStore, graduation } = createService();

    await expect(service.getStats()).resolves.toEqual({
      totalEvents: 31,
      vectorCount: 19,
      levelStats: [{ level: 'working', count: 23 }]
    });

    expect(initialize).toHaveBeenCalledOnce();
    // Counted in SQL, not by materializing a capped page of events.
    expect(queryStore.countEvents).toHaveBeenCalledOnce();
    expect(queryStore.getRecentEvents).not.toHaveBeenCalled();
    expect(vectorStore.count).toHaveBeenCalledOnce();
    expect(vectorStore.countAll).not.toHaveBeenCalled();
    expect(graduation.getStats).toHaveBeenCalledOnce();
  });

  it('counts every vector table for maintenance integrity without changing public stats', async () => {
    const { service, vectorStore } = createService();

    await expect(service.countAllVectors()).resolves.toBe(99);

    expect(vectorStore.countAll).toHaveBeenCalledOnce();
    expect(vectorStore.count).not.toHaveBeenCalled();
  });

  it('falls back to scanning recent events for the total when the store cannot count', async () => {
    const { service, queryStore } = createService();
    delete (queryStore as { countEvents?: unknown }).countEvents;

    await expect(service.getStats()).resolves.toMatchObject({ totalEvents: 1 });
    expect(queryStore.getRecentEvents).toHaveBeenCalledWith(10000);
  });

  it('keeps lightweight read methods usable with only the narrow query store', async () => {
    const initialize = vi.fn(async () => {});
    const events = [event({ id: '22222222-2222-4222-8222-222222222222' })];
    const queryStore = {
      keywordSearch: vi.fn(async () => [{ event: events[0], rank: -0.5 }]),
      getSessionEvents: vi.fn(async () => events),
      getRecentEvents: vi.fn(async () => events)
    };
    const service = new MemoryQueryService(initialize, queryStore);

    await expect(service.keywordSearch('query', { topK: 3 })).resolves.toEqual([{ event: events[0], score: 1 }]);
    await expect(service.getSessionHistory('session-1')).resolves.toBe(events);
    await expect(service.getRecentEvents(2)).resolves.toBe(events);

    expect(initialize).toHaveBeenCalledTimes(3);
    expect(queryStore.keywordSearch).toHaveBeenCalledWith('query', 3, { includeToolObservations: undefined });
    expect(queryStore.getSessionEvents).toHaveBeenCalledWith('session-1');
    expect(queryStore.getRecentEvents).toHaveBeenCalledWith(2, undefined);
  });

  it('normalizes ascending FTS ranks with the strongest match at score one', async () => {
    const initialize = vi.fn(async () => {});
    const strongest = event({ id: '11111111-1111-4111-8111-111111111111' });
    const middle = event({ id: '22222222-2222-4222-8222-222222222222' });
    const weakest = event({ id: '33333333-3333-4333-8333-333333333333' });
    const service = new MemoryQueryService(initialize, {
      keywordSearch: vi.fn(async () => [
        { event: strongest, rank: -12 },
        { event: middle, rank: -7 },
        { event: weakest, rank: -2 }
      ]),
      getSessionEvents: vi.fn(async () => []),
      getRecentEvents: vi.fn(async () => [])
    });

    await expect(service.keywordSearch('exact query', { minScore: 0.4 })).resolves.toEqual([
      { event: strongest, score: 1 },
      { event: middle, score: 0.5 }
    ]);
  });

  it('keeps the list-relative FTS scores byte-for-byte', async () => {
    // Golden output of the list-relative normalization. A single weak hit
    // scores 1 here; that is the current contract, not an endorsement.
    const golden: Record<string, { ranks: number[]; scores: string }> = {
      mixed: {
        ranks: [-176.67, -41.71, -13.67, -3.56, -0.000001],
        scores: '[1,0.23608988077256976,0.07737589334564943,0.020150557650707834,0]'
      },
      tied: { ranks: [-3.56, -3.56], scores: '[1,1]' },
      single: { ranks: [-3.56], scores: '[1]' },
      zero: { ranks: [0], scores: '[1]' }
    };

    for (const { ranks, scores } of Object.values(golden)) {
      const service = new MemoryQueryService(vi.fn(async () => {}), {
        keywordSearch: vi.fn(async () => ranks.map((rank) => ({ event: event(), rank }))),
        getSessionEvents: vi.fn(async () => []),
        getRecentEvents: vi.fn(async () => [])
      });
      const results = await service.keywordSearch('query');
      expect(JSON.stringify(results.map((r) => r.score))).toBe(scores);
    }
  });

  describe('with CLAUDE_MEMORY_FTS_ABSOLUTE_SCORE_EXPERIMENT', () => {
    afterEach(() => { vi.unstubAllEnvs(); });

    function serviceReturning(ranks: number[]) {
      const events = ranks.map((_, index) => event({ id: `${index}`.padStart(8, '0') + '-1111-4111-8111-111111111111' }));
      const service = new MemoryQueryService(vi.fn(async () => {}), {
        keywordSearch: vi.fn(async () => ranks.map((rank, index) => ({ event: events[index], rank }))),
        getSessionEvents: vi.fn(async () => []),
        getRecentEvents: vi.fn(async () => [])
      });
      return { service, events };
    }

    it('ignores values other than true', async () => {
      vi.stubEnv('CLAUDE_MEMORY_FTS_ABSOLUTE_SCORE_EXPERIMENT', '1');
      const { service } = serviceReturning([-3.56]);

      await expect(service.keywordSearch('query')).resolves.toMatchObject([{ score: 1 }]);
    });

    it('does not give a lone weak match the top score', async () => {
      vi.stubEnv('CLAUDE_MEMORY_FTS_ABSOLUTE_SCORE_EXPERIMENT', 'true');
      // One common token matched: bm25 stays in single digits on real stores.
      const { service } = serviceReturning([-3.56]);

      const [result] = await service.keywordSearch('query');
      expect(result.score).toBeLessThan(0.3);
    });

    it('scores identifier matches high', async () => {
      vi.stubEnv('CLAUDE_MEMORY_FTS_ABSOLUTE_SCORE_EXPERIMENT', 'true');
      const { service } = serviceReturning([-66.58]);

      const [result] = await service.keywordSearch('query');
      expect(result.score).toBeGreaterThanOrEqual(0.8);
      expect(result.score).toBeLessThan(1);
    });

    it('scores a rank the same regardless of the other results', async () => {
      vi.stubEnv('CLAUDE_MEMORY_FTS_ABSOLUTE_SCORE_EXPERIMENT', 'true');
      const alone = await serviceReturning([-13.67]).service.keywordSearch('query');
      const withStronger = await serviceReturning([-176.67, -13.67]).service.keywordSearch('query');

      expect(withStronger[1].score).toBe(alone[0].score);
      expect(withStronger[0].score).toBeGreaterThan(withStronger[1].score);
    });

    it('applies minScore to the absolute scores', async () => {
      vi.stubEnv('CLAUDE_MEMORY_FTS_ABSOLUTE_SCORE_EXPERIMENT', 'true');
      // List-relative scoring would keep the first weak hit at 1.0.
      const { service } = serviceReturning([-3.56, -3.1]);

      await expect(service.keywordSearch('query', { minScore: 0.4 })).resolves.toEqual([]);
    });

    it('maps bm25 magnitude to x/(x+15)', async () => {
      vi.stubEnv('CLAUDE_MEMORY_FTS_ABSOLUTE_SCORE_EXPERIMENT', 'true');
      const results = await serviceReturning([-45, -15, -10, -6]).service.keywordSearch('query');

      // 0.4 is the hook's default minScore, 0.3 its fallback floor.
      expect(results.map((r) => r.score)).toEqual([0.75, 0.5, 0.4, 6 / 21]);
    });

    it('keeps list-relative scores for LIKE fallback rows without bm25', async () => {
      vi.stubEnv('CLAUDE_MEMORY_FTS_ABSOLUTE_SCORE_EXPERIMENT', 'true');
      // SQLiteEventStore returns rank 0 when the FTS table is unavailable.
      const { service } = serviceReturning([0, 0]);

      await expect(service.keywordSearch('query', { minScore: 0.4 })).resolves.toMatchObject([{ score: 1 }, { score: 1 }]);
    });
  });
});
