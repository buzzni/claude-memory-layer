/**
 * Regression: semantic search reads one vector table. On real stores that had
 * imported their history under 2.5.0-2.5.3, that table held 4-5% of the
 * events worth searching (944 of 20,429; 1,167 of 32,286; 142 of 2,960). The
 * rest had been embedded only into `event_vectors_v1`, a table nothing reads,
 * so months of history were reachable by keyword alone.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  backfillVectorCoverage,
  type VectorCoverageBackfillDeps
} from '../../src/core/operations/vector-coverage-backfill.js';
import type { MemoryEvent } from '../../src/core/types.js';

function ev(id: string, content: string, eventType: MemoryEvent['eventType'] = 'agent_response'): MemoryEvent {
  return {
    id,
    sessionId: `session-of-${id}`,
    eventType,
    content,
    canonicalKey: id,
    dedupeKey: id,
    timestamp: new Date('2026-08-01T00:00:00.000Z'),
    metadata: { scope: { project: { hash: 'abc' } } }
  };
}

/** The "current model": a vector that depends only on the text. */
const embed = (text: string) => [text.length, text.charCodeAt(0) || 0, 1];

interface Fixture {
  events: MemoryEvent[];
  searched?: string[];
  spare?: Record<string, Array<{ eventId: string; content: string; vector: number[] }>>;
  pending?: string[];
}

function setup(fixture: Fixture) {
  const searched = new Set(fixture.searched ?? []);
  const written: Array<{ id: string; eventId: string; sessionId: string; eventType: string; content: string; vector: number[]; timestamp: string; metadata?: Record<string, unknown> }> = [];
  const queued: Array<{ eventId: string; content: string }> = [];
  const deps: VectorCoverageBackfillDeps = {
    eventStore: {
      listEmbeddableEvents: async () => fixture.events.filter((event) => event.eventType !== 'tool_observation'),
      listPendingEmbeddingEventIds: async () => [...(fixture.pending ?? []), ...queued.map((item) => item.eventId)],
      enqueueForEmbedding: async (eventId, content) => { queued.push({ eventId, content }); }
    },
    vectorStore: {
      listEventIds: async () => [...searched],
      listSpareEventTables: async () => Object.keys(fixture.spare ?? {}),
      readRowsByEventIds: async (tableName, eventIds) =>
        (fixture.spare?.[tableName] ?? []).filter((row) => eventIds.includes(row.eventId)),
      upsertBatch: async (records) => {
        for (const record of records) { written.push(record); searched.add(record.eventId); }
      }
    },
    embedder: { embed: vi.fn(async (text: string) => ({ vector: embed(text) })) }
  };
  return { deps, written, queued };
}

const spareRow = (event: MemoryEvent, vector = embed(event.content)) => ({ eventId: event.id, content: event.content, vector });

describe('backfillVectorCoverage', () => {
  const a = ev('a', 'The release workflow publishes on tag push.');
  const b = ev('b', 'Rollback restores the last checkpoint in one transaction.');
  const c = ev('c', 'How do I publish a release?', 'user_prompt');

  it('reports what is missing without writing anything in a dry run', async () => {
    const { deps, written, queued } = setup({ events: [a, b, c], searched: ['a'], spare: { event_vectors_v1: [spareRow(b)] } });

    const result = await backfillVectorCoverage(deps, { dryRun: true });

    expect(result).toMatchObject({ dryRun: true, embeddable: 3, searchable: 1, adopted: 1, queued: 1 });
    expect(written).toEqual([]);
    expect(queued).toEqual([]);
  });

  it('copies a vector the current model already produced instead of embedding the event again', async () => {
    const { deps, written, queued } = setup({ events: [a, b], searched: ['a'], spare: { event_vectors_v1: [spareRow(b)] } });

    const result = await backfillVectorCoverage(deps);

    expect(result).toMatchObject({ dryRun: false, adopted: 1, queued: 0 });
    expect(queued).toEqual([]);
    expect(written).toEqual([{
      id: 'vec_b',
      eventId: 'b',
      sessionId: 'session-of-b',
      eventType: 'agent_response',
      content: b.content,
      vector: embed(b.content),
      timestamp: '2026-08-01T00:00:00.000Z',
      metadata: b.metadata
    }]);
  });

  it('queues the events for embedding when the spare vectors came from another model', async () => {
    const { deps, written, queued } = setup({
      events: [a, b],
      spare: { event_vectors_v1: [spareRow(a, [9, 9, 9]), spareRow(b, [9, 9, 9])] }
    });

    const result = await backfillVectorCoverage(deps);

    expect(result).toMatchObject({ adopted: 0, queued: 2 });
    expect(written).toEqual([]);
    expect(queued.map((item) => item.eventId).sort()).toEqual(['a', 'b']);
  });

  it('does not bring back text that was changed after the spare vector was made', async () => {
    const redacted = ev('b', 'Rollback uses token [REDACTED].');
    const { deps, written, queued } = setup({
      events: [a, redacted],
      spare: { event_vectors_v1: [spareRow(a), { eventId: 'b', content: 'Rollback uses token sk-live-123.', vector: [1, 2, 3] }] }
    });

    await backfillVectorCoverage(deps);

    expect(written.map((record) => record.eventId)).toEqual(['a']);
    expect(queued).toEqual([{ eventId: 'b', content: 'Rollback uses token [REDACTED].' }]);
  });

  it('queues an event that has no vector anywhere, once', async () => {
    const { deps, queued } = setup({ events: [a, b], pending: ['a'] });

    const result = await backfillVectorCoverage(deps);

    expect(result).toMatchObject({ adopted: 0, queued: 1, alreadyQueued: 1 });
    expect(queued).toEqual([{ eventId: 'b', content: b.content }]);
  });

  it('leaves tool observations alone, which are never embedded', async () => {
    const tool = ev('t', '{"toolName":"Bash"}', 'tool_observation');
    const { deps, queued } = setup({ events: [a, tool], searched: ['a'] });

    const result = await backfillVectorCoverage(deps);

    expect(result).toMatchObject({ embeddable: 1, searchable: 1, adopted: 0, queued: 0 });
    expect(queued).toEqual([]);
  });

  it('finds nothing left to do on a second run', async () => {
    const { deps } = setup({ events: [a, b, c], spare: { event_vectors_v1: [spareRow(a), spareRow(b)] } });
    await backfillVectorCoverage(deps);

    const again = await backfillVectorCoverage(deps);

    expect(again).toMatchObject({ searchable: 2, adopted: 0, queued: 0, alreadyQueued: 1 });
  });
});

describe('vector tables behind the backfill', () => {
  it('lists the searched event ids, finds the spare table and reads its rows back', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { VectorStore } = await import('../../src/core/vector-store.js');
    const root = mkdtempSync(path.join(tmpdir(), 'cml-vector-backfill-'));
    try {
      const store = new VectorStore(path.join(root, 'vectors'));
      const row = (eventId: string, metadata: Record<string, unknown> = {}) => ({
        id: `vec-${eventId}-${Object.keys(metadata).length}`, eventId, sessionId: 's', eventType: 'agent_response',
        content: `text of ${eventId}`, vector: [0.1, 0.2, 0.3], timestamp: '2026-08-31T00:00:00.000Z', metadata
      });
      const spare = { itemKind: 'event', embeddingVersion: 'v1' };
      await store.upsertBatch([row('live'), row('live', spare), row("old 'quoted'", spare)]);

      expect(await store.listEventIds()).toEqual(['live']);
      expect(await store.listSpareEventTables()).toEqual(['event_vectors_v1']);
      const rows = await store.readRowsByEventIds('event_vectors_v1', ["old 'quoted'", 'absent']);
      expect(rows).toEqual([{ eventId: "old 'quoted'", content: "text of old 'quoted'", vector: [expect.closeTo(0.1), expect.closeTo(0.2), expect.closeTo(0.3)] }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
