/**
 * Regression: the prompt hook's semantic lane asked for memories with its own
 * session id, which the retriever treats as "search this session first". A
 * session's own events match its next prompt best, so every result came from
 * the caller's session and the hook, which injects only other sessions'
 * memories, discarded all of them: 9 of 9 real later-turn prompts returned
 * nothing usable, against 5 results each under an unknown session id.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { Matcher } from '../../src/core/matcher.js';
import { Retriever } from '../../src/core/retriever.js';
import { VectorStore } from '../../src/core/vector-store.js';
import type { MemoryEvent } from '../../src/core/types.js';

function ev(id: string, sessionId: string, content: string): MemoryEvent {
  return {
    id,
    sessionId,
    eventType: 'agent_response',
    content,
    canonicalKey: id,
    dedupeKey: `${sessionId}:${id}`,
    timestamp: new Date('2026-02-24T00:00:00.000Z'),
    metadata: {}
  };
}

const own = ev('own', 'current', 'The release workflow publishes on tag push from the current conversation.');
const past = ev('past', 'earlier', 'The release workflow publishes on tag push: push the tag and watch the run.');
const query = 'How does the release workflow publish on tag push?';

function hit(event: MemoryEvent, score: number) {
  return {
    id: `v-${event.id}`,
    eventId: event.id,
    content: event.content,
    score,
    sessionId: event.sessionId,
    eventType: event.eventType,
    timestamp: event.timestamp.toISOString()
  };
}

function retrieverWith(vectorSearch: ReturnType<typeof vi.fn>) {
  const events = new Map([own, past].map((event) => [event.id, event]));
  const eventStore = {
    async keywordSearch() { return [{ event: own, rank: -9 }, { event: past, rank: -8 }]; },
    async getRecentEvents() { return [own, past]; },
    async getEvent(id: string) { return events.get(id) ?? null; },
    async getSessionEvents(sessionId: string) { return [own, past].filter((event) => event.sessionId === sessionId); }
  };
  const embedder = { async embed() { return { vector: [0.1, 0.2, 0.3] }; } };
  return new Retriever(eventStore as never, { search: vectorSearch } as never, embedder as never, new Matcher());
}

const ids = (out: { memories: Array<{ event: MemoryEvent }> }) => out.memories.map((memory) => memory.event.id);

describe('Retriever excludeSessionId', () => {
  it('asks the vector store to leave the excluded session out of the search', async () => {
    const search = vi.fn(async () => [hit(past, 0.9)]);

    await retrieverWith(search).retrieve(query, { strategy: 'deep', topK: 5, minScore: 0.3, includeSessionContext: false, excludeSessionId: 'current' });

    expect(search).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ excludeSessionId: 'current' }));
    expect(search.mock.calls[0][1].sessionId).toBeUndefined();
  });

  it('never returns an event of the excluded session, even when a lane surfaces one', async () => {
    const search = vi.fn(async () => [hit(own, 0.95), hit(past, 0.9)]);

    const out = await retrieverWith(search).retrieve(query, { strategy: 'deep', topK: 5, minScore: 0.3, includeSessionContext: false, excludeSessionId: 'current' });

    expect(ids(out)).toEqual(['past']);
  });

  it('leaves the excluded session out of the keyword strategy too', async () => {
    const out = await retrieverWith(vi.fn(async () => [])).retrieve(query, { strategy: 'fast', topK: 5, minScore: 0.3, includeSessionContext: false, excludeSessionId: 'current' });

    expect(ids(out)).toEqual(['past']);
  });

  it('returns every session when nothing is excluded', async () => {
    const search = vi.fn(async () => [hit(own, 0.95), hit(past, 0.9)]);

    const out = await retrieverWith(search).retrieve(query, { strategy: 'deep', topK: 5, minScore: 0.3, includeSessionContext: false });

    expect(ids(out)).toEqual(['own', 'past']);
  });
});

describe('VectorStore.search excludeSessionId', () => {
  it('finds neighbours outside the excluded session without letting it use up the limit', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-vector-exclude-'));
    try {
      const store = new VectorStore(path.join(root, 'vectors'));
      const row = (id: string, sessionId: string, vector: number[]) => ({
        id: `vec-${id}`, eventId: id, sessionId, eventType: 'agent_response', content: id, vector,
        timestamp: '2026-08-31T00:00:00.000Z', metadata: {}
      });
      // The caller's own session holds the nearest neighbours, as it does in practice.
      await store.upsertBatch([
        ...Array.from({ length: 6 }, (_, i) => row(`own-${i}`, 'current', [1, 0.001 * i, 0])),
        row('past-near', 'earlier', [0.9, 0.3, 0]),
        row('past-far', 'another', [0.2, 0.9, 0.1])
      ]);

      const all = await store.search([1, 0, 0], { limit: 2, minScore: 0 });
      const outside = await store.search([1, 0, 0], { limit: 2, minScore: 0, excludeSessionId: 'current' });

      expect(all.every((result) => result.sessionId === 'current')).toBe(true);
      expect(outside.map((result) => result.eventId)).toEqual(['past-near', 'past-far']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
