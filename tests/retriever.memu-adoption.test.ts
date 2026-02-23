import { describe, it, expect } from 'vitest';
import { Retriever } from '../src/core/retriever.js';
import type { MemoryEvent, MatchResult } from '../src/core/types.js';
import type { SearchResult } from '../src/core/vector-store.js';

class FakeEventStore {
  constructor(private readonly events: Record<string, MemoryEvent>) {}

  async getEvent(id: string): Promise<MemoryEvent | null> {
    return this.events[id] || null;
  }

  async getSessionEvents(sessionId: string): Promise<MemoryEvent[]> {
    return Object.values(this.events).filter((e) => e.sessionId === sessionId);
  }

  async getRecentEvents(): Promise<MemoryEvent[]> {
    return Object.values(this.events);
  }

  async keywordSearch(query: string): Promise<Array<{ event: MemoryEvent; rank: number }>> {
    const lowered = query.toLowerCase();
    const matches = Object.values(this.events)
      .filter((event) => event.content.toLowerCase().includes(lowered))
      .map((event, index) => ({ event, rank: -(index + 1) }));
    return matches;
  }
}

class FakeVectorStore {
  constructor(private readonly results: SearchResult[]) {}

  async search(): Promise<SearchResult[]> {
    return this.results;
  }
}

class FakeEmbedder {
  async embed(): Promise<{ vector: number[] }> {
    return { vector: [0.1, 0.2, 0.3] };
  }
}

class FakeMatcher {
  matchSearchResults(results: SearchResult[]): MatchResult {
    if (results.length === 0) {
      return { match: null, confidence: 'none' };
    }

    const top = results[0];
    return {
      match: {
        event: {
          id: top.eventId,
          eventType: top.eventType as MemoryEvent['eventType'],
          sessionId: top.sessionId,
          timestamp: new Date(top.timestamp),
          content: top.content,
          canonicalKey: top.eventId,
          dedupeKey: top.eventId,
          metadata: {}
        },
        score: top.score
      },
      confidence: 'suggested'
    };
  }
}

function makeEvent(id: string, content: string, metadata?: Record<string, unknown>): MemoryEvent {
  return {
    id,
    eventType: 'user_prompt',
    sessionId: 's1',
    timestamp: new Date('2026-01-01T00:00:00.000Z'),
    content,
    canonicalKey: id,
    dedupeKey: id,
    metadata
  };
}

describe('Retriever memU-inspired enhancements', () => {
  it('applies metadata scope filter with hierarchical key path', async () => {
    const e1 = makeEvent('e1', 'first memory', { scope: { project: { id: 'alpha' } } });
    const e2 = makeEvent('e2', 'second memory', { scope: { project: { id: 'beta' } } });

    const retriever = new Retriever(
      new FakeEventStore({ e1, e2 }) as any,
      new FakeVectorStore([
        { id: '1', eventId: 'e1', content: e1.content, score: 0.9, sessionId: 's1', eventType: e1.eventType, timestamp: e1.timestamp.toISOString() },
        { id: '2', eventId: 'e2', content: e2.content, score: 0.89, sessionId: 's1', eventType: e2.eventType, timestamp: e2.timestamp.toISOString() }
      ]) as any,
      new FakeEmbedder() as any,
      new FakeMatcher() as any
    );

    const result = await retriever.retrieve('memory', {
      scope: { metadata: { 'scope.project.id': 'alpha' } }
    });

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0].event.id).toBe('e1');
  });

  it('uses fast strategy keyword retrieval when requested', async () => {
    const e1 = makeEvent('e1', 'fix deployment issue with nginx');
    const e2 = makeEvent('e2', 'random unrelated text');

    const retriever = new Retriever(
      new FakeEventStore({ e1, e2 }) as any,
      new FakeVectorStore([]) as any,
      new FakeEmbedder() as any,
      new FakeMatcher() as any
    );

    const result = await retriever.retrieve('deployment', { strategy: 'fast', topK: 5 });

    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.memories[0].event.id).toBe('e1');
  });
});
