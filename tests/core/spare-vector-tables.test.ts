/**
 * After repair backfill-vectors, the per-version event_vectors_* tables only
 * duplicate the searched table (on one machine 526 MB across three stores).
 * Dropping one is irreversible, so it is allowed only while every event worth
 * searching has a searchable vector.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  dropSpareEventVectorTables,
  type SpareVectorTablesDeps
} from '../../src/core/operations/spare-vector-tables.js';
import { VectorStore } from '../../src/core/vector-store.js';

function setup(options: { embeddable: string[]; searched: string[]; queued?: string[]; spare?: Record<string, number> }) {
  const spare = new Map(Object.entries(options.spare ?? { event_vectors_v1: 3 }));
  const dropSpareEventTable = vi.fn(async (name: string) => { spare.delete(name); });
  const deps: SpareVectorTablesDeps = {
    eventStore: {
      listEmbeddableEventIds: async () => options.embeddable,
      listPendingEmbeddingEventIds: async () => options.queued ?? []
    },
    vectorStore: {
      listEventIds: async () => options.searched,
      listSpareEventTables: async () => [...spare.keys()],
      countTableRows: async (name) => spare.get(name) ?? 0,
      dropSpareEventTable
    }
  };
  return { deps, dropSpareEventTable };
}

describe('dropSpareEventVectorTables', () => {
  it('lists what it would drop without dropping anything in a dry run', async () => {
    const { deps, dropSpareEventTable } = setup({ embeddable: ['a', 'b'], searched: ['a', 'b'], spare: { event_vectors_v1: 2 } });

    const result = await dropSpareEventVectorTables(deps, { dryRun: true });

    expect(result).toEqual({
      dryRun: true, embeddable: 2, searchable: 2, queued: 0, refused: null,
      tables: [{ name: 'event_vectors_v1', rows: 2 }], dropped: []
    });
    expect(dropSpareEventTable).not.toHaveBeenCalled();
  });

  it('drops the spare tables when every event is searchable', async () => {
    const { deps, dropSpareEventTable } = setup({
      embeddable: ['a', 'b'], searched: ['a', 'b', 'gone'], spare: { event_vectors_v1: 2, event_vectors_v2: 1 }
    });

    const result = await dropSpareEventVectorTables(deps);

    expect(result.dropped).toEqual(['event_vectors_v1', 'event_vectors_v2']);
    expect(dropSpareEventTable.mock.calls.map(([name]) => name)).toEqual(['event_vectors_v1', 'event_vectors_v2']);
  });

  it('refuses while some event is not searchable, since the spare table may be its only vector', async () => {
    const { deps, dropSpareEventTable } = setup({ embeddable: ['a', 'b'], searched: ['a'] });

    const result = await dropSpareEventVectorTables(deps);

    expect(result).toMatchObject({ searchable: 1, refused: 'incomplete-coverage', dropped: [] });
    expect(dropSpareEventTable).not.toHaveBeenCalled();
  });

  it('counts an event waiting for the embedding worker as covered, since it is embedded from its own text', async () => {
    const { deps, dropSpareEventTable } = setup({ embeddable: ['a', 'new'], searched: ['a'], queued: ['new'] });

    const result = await dropSpareEventVectorTables(deps);

    expect(result).toMatchObject({ searchable: 1, queued: 1, refused: null, dropped: ['event_vectors_v1'] });
    expect(dropSpareEventTable).toHaveBeenCalledOnce();
  });

  it('has nothing to do on a store without spare tables', async () => {
    const { deps } = setup({ embeddable: ['a'], searched: ['a'], spare: {} });

    expect(await dropSpareEventVectorTables(deps)).toMatchObject({ tables: [], dropped: [], refused: null });
  });
});

describe('VectorStore.dropSpareEventTable', () => {
  it('drops an event_vectors_* table and refuses any other name', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-spare-drop-'));
    try {
      const store = new VectorStore(path.join(root, 'vectors'));
      const row = (eventId: string, metadata: Record<string, unknown> = {}) => ({
        id: `vec-${eventId}-${Object.keys(metadata).length}`, eventId, sessionId: 's', eventType: 'agent_response',
        content: eventId, vector: [0.1, 0.2, 0.3], timestamp: '2026-08-31T00:00:00.000Z', metadata
      });
      await store.upsertBatch([row('a'), row('a', { itemKind: 'event', embeddingVersion: 'v1' })]);
      expect(await store.countTableRows('event_vectors_v1')).toBe(1);

      await expect(store.dropSpareEventTable('conversations')).rejects.toThrow(/not a spare event vector table/);
      await store.dropSpareEventTable('event_vectors_v1');

      expect(await store.listSpareEventTables()).toEqual([]);
      expect(await store.listEventIds()).toEqual(['a']);
      expect(await store.countTableRows('event_vectors_v1')).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
