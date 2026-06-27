import { describe, it, expect } from 'vitest';
import { Retriever } from '../../src/core/retriever.js';
import { Matcher } from '../../src/core/matcher.js';
import type { MemoryEvent } from '../../src/core/types.js';

function ev(id: string, content: string): MemoryEvent {
  return {
    id,
    sessionId: 'agent:main:alpha',
    eventType: 'user_prompt',
    content,
    canonicalKey: `pref/${id}`,
    dedupeKey: `s:${id}`,
    timestamp: new Date('2026-02-24T00:00:00.000Z'),
    metadata: {}
  };
}

const e1 = ev('e1', '아침 브리핑 선호');
const e2 = ev('e2', '점심 이후 요약은 잘 안봄');

const fakeVectorStore = {
  async search() {
    return [
      { id: 'v1', eventId: 'e1', content: e1.content, score: 0.9, sessionId: e1.sessionId, eventType: e1.eventType, timestamp: e1.timestamp.toISOString() },
      { id: 'v2', eventId: 'e2', content: e2.content, score: 0.8, sessionId: e2.sessionId, eventType: e2.eventType, timestamp: e2.timestamp.toISOString() }
    ];
  }
};

const fakeEmbedder = {
  async embed() {
    return { vector: [0.1, 0.2, 0.3] };
  }
};

describe('Retriever batch event fetch', () => {
  it('uses the batch getEvents path instead of per-result getEvent', async () => {
    let getEventsCalls = 0;
    let lastBatchSize = 0;
    const store = {
      async keywordSearch() { return [{ event: e1, rank: -0.1 }, { event: e2, rank: -0.2 }]; },
      async getRecentEvents() { return [e1, e2]; },
      async getEvent(id: string) { return id === 'e1' ? e1 : id === 'e2' ? e2 : null; },
      async getEvents(ids: string[]) { getEventsCalls++; lastBatchSize = ids.length; return [e1, e2].filter((x) => ids.includes(x.id)); },
      async getSessionEvents() { return []; }
    };

    const retriever = new Retriever(store as never, fakeVectorStore as never, fakeEmbedder as never, new Matcher());
    const out = await retriever.retrieve('브리핑', { strategy: 'deep', topK: 2, includeSessionContext: false });

    expect(out.memories.length).toBeGreaterThan(0);
    // The scope/enrich phases batch their lookups in a single getEvents call.
    expect(getEventsCalls).toBeGreaterThan(0);
    expect(lastBatchSize).toBeGreaterThan(1);
  });

  it('falls back to getEvent when the store has no batch method', async () => {
    const store = {
      async keywordSearch() { return [{ event: e1, rank: -0.1 }, { event: e2, rank: -0.2 }]; },
      async getRecentEvents() { return [e1, e2]; },
      async getEvent(id: string) { return id === 'e1' ? e1 : id === 'e2' ? e2 : null; },
      async getSessionEvents() { return []; }
    };

    const retriever = new Retriever(store as never, fakeVectorStore as never, fakeEmbedder as never, new Matcher());
    const out = await retriever.retrieve('브리핑', { strategy: 'deep', topK: 2, includeSessionContext: false });

    expect(out.memories.map((m) => m.event.id).sort()).toEqual(['e1', 'e2']);
  });
});
