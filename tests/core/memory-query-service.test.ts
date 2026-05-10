import { describe, expect, it, vi } from 'vitest';

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
    embedding: { pending: 1, processing: 2, failed: 3, total: 6 },
    vector: { pending: 4, processing: 5, failed: 6, total: 15 }
  };
  const outboxRecovery = {
    embedding: { recoveredProcessing: 1, retriedFailed: 0 },
    vector: { recoveredProcessing: 2, retriedFailed: 1 }
  };
  const queryStore = {
    keywordSearch: vi.fn(async () => [{ event: events[0], rank: -0.5 }]),
    getSessionEvents: vi.fn(async () => events),
    getRecentEvents: vi.fn(async () => events),
    rebuildFtsIndex: vi.fn(async () => 7),
    getOutboxStats: vi.fn(async () => outboxStats),
    recoverStuckOutboxItems: vi.fn(async () => outboxRecovery),
    getEventsByLevel: vi.fn(async () => events),
    getEventLevel: vi.fn(async () => 'working'),
    getSessionTurns: vi.fn(async () => [turn]),
    getEventsByTurn: vi.fn(async () => events),
    countSessionTurns: vi.fn(async () => 11),
    backfillTurnIds: vi.fn(async () => 13),
    deleteSessionEvents: vi.fn(async () => 17)
  };
  const vectorStore = {
    count: vi.fn(async () => 19)
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
    outboxRecovery
  };
}

describe('MemoryQueryService', () => {
  it('delegates read and maintenance methods through the initialized store boundary', async () => {
    const { service, initialize, queryStore, events, turn, outboxStats, outboxRecovery } = createService();

    await expect(service.rebuildFtsIndex()).resolves.toBe(7);
    await expect(service.getOutboxStats()).resolves.toEqual(outboxStats);
    await expect(service.recoverStuckOutboxItems({ stuckThresholdMs: 1234 })).resolves.toEqual(outboxRecovery);
    await expect(service.getEventsByLevel('working', { limit: 2, offset: 3 })).resolves.toEqual(events);
    await expect(service.getEventLevel('event-1')).resolves.toBe('working');
    await expect(service.getSessionTurns('session-1', { limit: 5, offset: 8 })).resolves.toEqual([turn]);
    await expect(service.getEventsByTurn('turn-1')).resolves.toEqual(events);
    await expect(service.countSessionTurns('session-1')).resolves.toBe(11);
    await expect(service.backfillTurnIds()).resolves.toBe(13);
    await expect(service.deleteSessionEvents('session-1')).resolves.toBe(17);

    expect(initialize).toHaveBeenCalledTimes(10);
    expect(queryStore.rebuildFtsIndex).toHaveBeenCalledOnce();
    expect(queryStore.getOutboxStats).toHaveBeenCalledOnce();
    expect(queryStore.recoverStuckOutboxItems).toHaveBeenCalledWith({ stuckThresholdMs: 1234 });
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
      totalEvents: 1,
      vectorCount: 19,
      levelStats: [{ level: 'working', count: 23 }]
    });

    expect(initialize).toHaveBeenCalledOnce();
    expect(queryStore.getRecentEvents).toHaveBeenCalledWith(10000);
    expect(vectorStore.count).toHaveBeenCalledOnce();
    expect(graduation.getStats).toHaveBeenCalledOnce();
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
    expect(queryStore.keywordSearch).toHaveBeenCalledWith('query', 3);
    expect(queryStore.getSessionEvents).toHaveBeenCalledWith('session-1');
    expect(queryStore.getRecentEvents).toHaveBeenCalledWith(2);
  });
});
