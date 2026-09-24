import { describe, expect, it, vi } from 'vitest';
import {
  TOOL_OBSERVATION_VECTOR_AUTO_HEAL_KEY,
  needsToolObservationVectorAutoHeal,
  runToolObservationVectorAutoHeal
} from '../../src/core/operations/tool-observation-vector-auto-heal.js';

function createStore(overrides: { flag?: unknown; eventIds?: string[] } = {}) {
  const config = new Map<string, unknown>();
  if (overrides.flag !== undefined) config.set(TOOL_OBSERVATION_VECTOR_AUTO_HEAL_KEY, overrides.flag);

  return {
    listEventIdsByType: vi.fn(async () => overrides.eventIds ?? ['event-1', 'event-2']),
    removeVectorOutboxRowsForEventIds: vi.fn(async (ids: string[]) => ids.length),
    getEndlessConfig: vi.fn(async (key: string) => config.get(key) ?? null),
    setEndlessConfig: vi.fn(async (key: string, value: unknown) => {
      config.set(key, value);
    })
  };
}

function createVectorStore() {
  return {
    deleteEventEverywhere: vi.fn(async () => {}),
    optimizeAll: vi.fn(async () => {})
  };
}

describe('needsToolObservationVectorAutoHeal', () => {
  it('is true when the flag was never set', async () => {
    const store = createStore();
    await expect(needsToolObservationVectorAutoHeal(store)).resolves.toBe(true);
  });

  it('is false once the flag is stamped, regardless of its content', async () => {
    const store = createStore({ flag: { completedAt: '2026-01-01T00:00:00.000Z', vectorsDeleted: 0, outboxRowsRemoved: 0 } });
    await expect(needsToolObservationVectorAutoHeal(store)).resolves.toBe(false);
  });
});

describe('runToolObservationVectorAutoHeal', () => {
  it('prunes, compacts the Lance tables, and stamps the flag with a timestamped record', async () => {
    const store = createStore({ eventIds: ['event-1', 'event-2', 'event-3'] });
    const vectorStore = createVectorStore();

    const result = await runToolObservationVectorAutoHeal(store, vectorStore);

    expect(result).toEqual({
      dryRun: false,
      scanned: 3,
      vectorsDeleted: 3,
      outboxRowsRemoved: 3,
      sampleEventIds: ['event-1', 'event-2', 'event-3']
    });
    expect(vectorStore.deleteEventEverywhere).toHaveBeenCalledTimes(3);
    // optimizeAll must run after the deletes, since it exists specifically to
    // reclaim the Lance versions those per-event deletes create.
    expect(vectorStore.optimizeAll).toHaveBeenCalledTimes(1);
    const deleteOrder = vectorStore.deleteEventEverywhere.mock.invocationCallOrder[2];
    const optimizeOrder = vectorStore.optimizeAll.mock.invocationCallOrder[0];
    expect(optimizeOrder).toBeGreaterThan(deleteOrder);

    expect(store.setEndlessConfig).toHaveBeenCalledWith(
      TOOL_OBSERVATION_VECTOR_AUTO_HEAL_KEY,
      expect.objectContaining({
        completedAt: expect.any(String),
        vectorsDeleted: 3,
        outboxRowsRemoved: 3
      })
    );
    await expect(needsToolObservationVectorAutoHeal(store)).resolves.toBe(false);
  });

  it('still stamps the flag on a store with nothing to prune, so it never runs again', async () => {
    const store = createStore({ eventIds: [] });
    const vectorStore = createVectorStore();

    const result = await runToolObservationVectorAutoHeal(store, vectorStore);

    expect(result).toEqual({ dryRun: false, scanned: 0, vectorsDeleted: 0, outboxRowsRemoved: 0, sampleEventIds: [] });
    expect(vectorStore.optimizeAll).toHaveBeenCalledTimes(1);
    expect(store.setEndlessConfig).toHaveBeenCalledOnce();
  });
});
