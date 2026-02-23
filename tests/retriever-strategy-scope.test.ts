import { describe, it, expect } from 'vitest';
import { Retriever } from '../src/core/retriever.js';
import { Matcher } from '../src/core/matcher.js';
import type { MemoryEvent } from '../src/core/types.js';

function ev(id: string, sessionId: string, eventType: MemoryEvent['eventType'], content: string, canonicalKey: string): MemoryEvent {
  return {
    id,
    sessionId,
    eventType,
    content,
    canonicalKey,
    dedupeKey: `${sessionId}:${id}`,
    timestamp: new Date('2026-02-24T00:00:00.000Z'),
    metadata: {}
  };
}

describe('Retriever strategy/scope', () => {
  const e1 = ev('e1', 'agent:main:alpha', 'user_prompt', '아침 브리핑 선호', 'pref/briefing/morning');
  const e2 = ev('e2', 'agent:main:beta', 'agent_response', '점심 이후 요약은 잘 안봄', 'pref/briefing/lunch');

  const fakeEventStore = {
    async keywordSearch() {
      return [
        { event: e1, rank: -0.1 },
        { event: e2, rank: -0.2 }
      ];
    },
    async getRecentEvents() {
      return [e1, e2];
    },
    async getEvent(id: string) {
      return id === 'e1' ? e1 : id === 'e2' ? e2 : null;
    },
    async getSessionEvents(sessionId: string) {
      return [e1, e2].filter((x) => x.sessionId === sessionId);
    }
  };

  const fakeVectorStore = {
    async search() {
      return [
        {
          id: 'v1',
          eventId: 'e2',
          content: e2.content,
          score: 0.92,
          sessionId: e2.sessionId,
          eventType: e2.eventType,
          timestamp: e2.timestamp.toISOString()
        },
        {
          id: 'v2',
          eventId: 'e1',
          content: e1.content,
          score: 0.8,
          sessionId: e1.sessionId,
          eventType: e1.eventType,
          timestamp: e1.timestamp.toISOString()
        }
      ];
    }
  };

  const fakeEmbedder = {
    async embed() {
      return { vector: [0.1, 0.2, 0.3] };
    }
  };

  it('uses fast strategy keyword path', async () => {
    const retriever = new Retriever(fakeEventStore as any, fakeVectorStore as any, fakeEmbedder as any, new Matcher());
    const out = await retriever.retrieve('브리핑', { strategy: 'fast', topK: 2, includeSessionContext: false });

    expect(out.memories.length).toBe(2);
    expect(out.memories[0].event.id).toBe('e1');
  });

  it('applies scoped filters (session prefix + canonical prefix + includes)', async () => {
    const retriever = new Retriever(fakeEventStore as any, fakeVectorStore as any, fakeEmbedder as any, new Matcher());

    const out = await retriever.retrieve('브리핑', {
      strategy: 'deep',
      topK: 5,
      includeSessionContext: false,
      scope: {
        sessionIdPrefix: 'agent:main:alpha',
        canonicalKeyPrefix: 'pref/briefing/morning',
        contentIncludes: ['아침']
      }
    });

    expect(out.memories.length).toBe(1);
    expect(out.memories[0].event.id).toBe('e1');
  });
});
