import { describe, expect, it, vi } from 'vitest';
import { pruneToolObservationVectors } from '../../src/core/operations/tool-observation-vector-backfill.js';

function makeStore(eventIds: string[]) {
  return {
    listEventIdsByType: vi.fn().mockResolvedValue(eventIds),
    removeVectorOutboxRowsForEventIds: vi.fn().mockResolvedValue(eventIds.length)
  };
}

function makeVectorStore() {
  return {
    deleteEventEverywhere: vi.fn().mockResolvedValue(undefined)
  };
}

describe('pruneToolObservationVectors', () => {
  it('dry-run reports counts without deleting anything', async () => {
    const store = makeStore(['tool-1', 'tool-2']);
    const vectorStore = makeVectorStore();

    const result = await pruneToolObservationVectors(store, vectorStore, { dryRun: true });

    expect(result).toEqual({
      dryRun: true,
      scanned: 2,
      vectorsDeleted: 0,
      outboxRowsRemoved: 0,
      sampleEventIds: ['tool-1', 'tool-2']
    });
    expect(vectorStore.deleteEventEverywhere).not.toHaveBeenCalled();
    expect(store.removeVectorOutboxRowsForEventIds).not.toHaveBeenCalled();
  });

  it('apply mode deletes every tool_observation vector and removes their outbox rows', async () => {
    const store = makeStore(['tool-1', 'tool-2', 'tool-3']);
    const vectorStore = makeVectorStore();

    const result = await pruneToolObservationVectors(store, vectorStore, { dryRun: false });

    expect(vectorStore.deleteEventEverywhere).toHaveBeenCalledTimes(3);
    expect(vectorStore.deleteEventEverywhere).toHaveBeenNthCalledWith(1, 'tool-1');
    expect(vectorStore.deleteEventEverywhere).toHaveBeenNthCalledWith(2, 'tool-2');
    expect(vectorStore.deleteEventEverywhere).toHaveBeenNthCalledWith(3, 'tool-3');
    expect(store.removeVectorOutboxRowsForEventIds).toHaveBeenCalledWith(['tool-1', 'tool-2', 'tool-3']);
    expect(result).toEqual({
      dryRun: false,
      scanned: 3,
      vectorsDeleted: 3,
      outboxRowsRemoved: 3,
      sampleEventIds: ['tool-1', 'tool-2', 'tool-3']
    });
  });

  it('apply mode is a no-op when there is nothing to prune', async () => {
    const store = makeStore([]);
    const vectorStore = makeVectorStore();

    const result = await pruneToolObservationVectors(store, vectorStore, { dryRun: false });

    expect(vectorStore.deleteEventEverywhere).not.toHaveBeenCalled();
    expect(store.removeVectorOutboxRowsForEventIds).not.toHaveBeenCalled();
    expect(result).toEqual({
      dryRun: false,
      scanned: 0,
      vectorsDeleted: 0,
      outboxRowsRemoved: 0,
      sampleEventIds: []
    });
  });

  it('caps the reported sample at 20 event ids even when more are scanned', async () => {
    const eventIds = Array.from({ length: 25 }, (_, i) => `tool-${i}`);
    const store = makeStore(eventIds);
    const vectorStore = makeVectorStore();

    const result = await pruneToolObservationVectors(store, vectorStore, { dryRun: true });

    expect(result.scanned).toBe(25);
    expect(result.sampleEventIds).toHaveLength(20);
    expect(result.sampleEventIds).toEqual(eventIds.slice(0, 20));
  });
});
