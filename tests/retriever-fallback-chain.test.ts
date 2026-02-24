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
