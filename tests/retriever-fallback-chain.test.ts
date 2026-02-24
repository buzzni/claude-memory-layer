import { describe, it, expect } from 'vitest';
import { Retriever } from '../src/core/retriever.js';
import { Matcher } from '../src/core/matcher.js';
import type { MemoryEvent } from '../src/core/types.js';

function ev(id: string, content: string): MemoryEvent {
  return {
    id,
    eventType: 'user_prompt',
    sessionId: 's1',
    timestamp: new Date('2026-02-24T00:00:00.000Z'),
    content,
    canonicalKey: id,
    dedupeKey: id,
    metadata: {}
  };
}

describe('Retriever fallback chain', () => {
  it('falls back from fast to deep when fast has no result', async () => {
    const e = ev('e1', 'deep result memory');
    let vectorCalls = 0;

    const fakeEventStore = {
      async keywordSearch() {
        return [];
      },
      async getRecentEvents() {
        return [e];
      },
      async getEvent(id: string) {
        return id === 'e1' ? e : null;
      },
      async getSessionEvents() {
        return [e];
      }
    };

    const fakeVectorStore = {
      async search() {
        vectorCalls += 1;
        return [{ id: 'v1', eventId: 'e1', content: e.content, score: 0.9, sessionId: 's1', eventType: e.eventType, timestamp: e.timestamp.toISOString() }];
      }
    };

    const fakeEmbedder = { async embed() { return { vector: [0.1, 0.2] }; } };

    const retriever = new Retriever(fakeEventStore as any, fakeVectorStore as any, fakeEmbedder as any, new Matcher());
    const out = await retriever.retrieve('result', { strategy: 'auto', topK: 3, includeSessionContext: false });

    expect(out.memories.length).toBeGreaterThan(0);
    expect(vectorCalls).toBeGreaterThan(0);
    expect(out.fallbackTrace).toContain('fallback:deep');
  });

  it('applies custom rerank weights when provided', async () => {
    const e1 = ev('a', 'keyword hit exact');
    const e2 = ev('b', 'less related');

    const fakeEventStore = {
      async keywordSearch() { return []; },
      async getRecentEvents() { return [e1, e2]; },
      async getEvent(id: string) { return id === 'a' ? e1 : id === 'b' ? e2 : null; },
      async getSessionEvents() { return [e1, e2]; }
    };

    const fakeVectorStore = {
      async search() {
        return [
          { id: 'v1', eventId: 'b', content: e2.content, score: 0.95, sessionId: 's1', eventType: e2.eventType, timestamp: e2.timestamp.toISOString() },
          { id: 'v2', eventId: 'a', content: e1.content, score: 0.7, sessionId: 's1', eventType: e1.eventType, timestamp: e1.timestamp.toISOString() },
        ];
      }
    };

    const fakeEmbedder = { async embed() { return { vector: [0.1, 0.2] }; } };
    const retriever = new Retriever(fakeEventStore as any, fakeVectorStore as any, fakeEmbedder as any, new Matcher());

    const out = await retriever.retrieve('keyword hit', {
      strategy: 'deep',
      topK: 3,
      includeSessionContext: false,
      rerankWeights: { semantic: 0.2, lexical: 0.7, recency: 0.1 }
    });

    expect(out.memories[0]?.event.id).toBe('a');
  });

  it('applies TTL/decay penalty for stale low-overlap memories', async () => {
    const old = {
      ...ev('old', 'generic memory'),
      timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24 * 120),
    };
    const fresh = {
      ...ev('fresh', 'generic memory'),
      timestamp: new Date(),
    };

    const fakeEventStore = {
      async keywordSearch() { return []; },
      async getRecentEvents() { return [old, fresh]; },
      async getEvent(id: string) { return id === 'old' ? old : id === 'fresh' ? fresh : null; },
      async getSessionEvents() { return [old, fresh]; }
    };

    const fakeVectorStore = {
      async search() {
        return [
          { id: 'v1', eventId: 'old', content: old.content, score: 0.9, sessionId: old.sessionId, eventType: old.eventType, timestamp: old.timestamp.toISOString() },
          { id: 'v2', eventId: 'fresh', content: fresh.content, score: 0.85, sessionId: fresh.sessionId, eventType: fresh.eventType, timestamp: fresh.timestamp.toISOString() },
        ];
      }
    };

    const fakeEmbedder = { async embed() { return { vector: [0.1, 0.2] }; } };
    const retriever = new Retriever(fakeEventStore as any, fakeVectorStore as any, fakeEmbedder as any, new Matcher());

    const out = await retriever.retrieve('different query', {
      strategy: 'deep',
      topK: 2,
      includeSessionContext: false,
      decayPolicy: { enabled: true, windowDays: 30, maxPenalty: 0.3 }
    });

    expect(out.memories[0]?.event.id).toBe('fresh');
  });

  it('merges rewritten deep query results when intentRewrite is enabled', async () => {
    const a = ev('a', '원문 질의에서는 약한 결과');
    const b = ev('b', '재작성 질의에서 강한 결과');

    const fakeEventStore = {
      async keywordSearch() { return []; },
      async getRecentEvents() { return [a, b]; },
      async getEvent(id: string) { return id === 'a' ? a : id === 'b' ? b : null; },
      async getSessionEvents() { return [a, b]; }
    };

    let call = 0;
    const fakeVectorStore = {
      async search() {
        call += 1;
        if (call === 1) {
          return [{ id: 'v1', eventId: 'a', content: a.content, score: 0.8, sessionId: 's1', eventType: a.eventType, timestamp: a.timestamp.toISOString() }];
        }
        return [{ id: 'v2', eventId: 'b', content: b.content, score: 0.95, sessionId: 's1', eventType: b.eventType, timestamp: b.timestamp.toISOString() }];
      }
    };

    const fakeEmbedder = { async embed() { return { vector: [0.1, 0.2] }; } };
    const retriever = new Retriever(fakeEventStore as any, fakeVectorStore as any, fakeEmbedder as any, new Matcher());
    retriever.setQueryRewriter(async () => '확장된 재작성 질의');

    const out = await retriever.retrieve('원문 질의', {
      strategy: 'deep',
      topK: 3,
      includeSessionContext: false,
      intentRewrite: true,
    });

    expect(out.memories[0]?.event.id).toBe('b');
  });

  it('expands related events with graph-hop retrieval', async () => {
    const seed = ev('seed', 'seed event');
    const neighbor = {
      ...ev('neighbor', 'related artifact memory'),
      metadata: { relatedEventIds: ['seed'] },
    };
    const seedWithEdge = { ...seed, metadata: { relatedEventIds: ['neighbor'] } };

    const fakeEventStore = {
      async keywordSearch() { return []; },
      async getRecentEvents() { return [seedWithEdge, neighbor]; },
      async getEvent(id: string) {
        if (id === 'seed') return seedWithEdge;
        if (id === 'neighbor') return neighbor;
        return null;
      },
      async getSessionEvents() { return [seedWithEdge, neighbor]; }
    };

    const fakeVectorStore = {
      async search() {
        return [{ id: 'v1', eventId: 'seed', content: seedWithEdge.content, score: 0.95, sessionId: 's1', eventType: seedWithEdge.eventType, timestamp: seedWithEdge.timestamp.toISOString() }];
      }
    };

    const fakeEmbedder = { async embed() { return { vector: [0.1, 0.2] }; } };
    const retriever = new Retriever(fakeEventStore as any, fakeVectorStore as any, fakeEmbedder as any, new Matcher());

    const out = await retriever.retrieve('seed event', {
      strategy: 'deep',
      topK: 5,
      includeSessionContext: false,
      graphHop: { enabled: true, maxHops: 1, hopPenalty: 0.1 }
    });

    const ids = out.memories.map((m) => m.event.id);
    expect(ids).toContain('seed');
    expect(ids).toContain('neighbor');
  });

  it('uses summary fallback when both fast and deep fail', async () => {
    const e = ev('e2', 'keyword overlap fallback candidate');

    const fakeEventStore = {
      async keywordSearch() { return []; },
      async getRecentEvents() { return [e]; },
      async getEvent(id: string) { return id === 'e2' ? e : null; },
      async getSessionEvents() { return [e]; }
    };

    const fakeVectorStore = { async search() { return []; } };
    const fakeEmbedder = { async embed() { return { vector: [0.1, 0.2] }; } };

    const retriever = new Retriever(fakeEventStore as any, fakeVectorStore as any, fakeEmbedder as any, new Matcher());
    const out = await retriever.retrieve('fallback candidate', { strategy: 'auto', topK: 3, includeSessionContext: false });

    expect(out.fallbackTrace).toContain('fallback:summary');
    expect(out.memories[0]?.event.id).toBe('e2');
  });
});
