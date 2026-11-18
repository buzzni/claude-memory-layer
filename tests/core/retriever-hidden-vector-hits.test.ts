import { describe, expect, it } from 'vitest';

import { Retriever } from '../../src/core/retriever.js';
import { Matcher } from '../../src/core/matcher.js';
import type { MemoryEvent } from '../../src/core/types.js';

/**
 * The vector index keeps the rows of events the store hides (a superseded
 * session summary) or no longer has. In a global search with no scope those
 * hits were only dropped after ranking, so a hidden one could take the only
 * topK slot and the match while the summary that replaced it was cut.
 */

function summary(id: string, content: string): MemoryEvent {
  return {
    id,
    sessionId: 'session-a',
    eventType: 'session_summary',
    content,
    canonicalKey: id,
    dedupeKey: id,
    timestamp: new Date('2026-11-17T00:00:00.000Z'),
    metadata: {}
  };
}

const hidden = summary('old-summary', '- 결정: release 태그는 package 버전과 맞춘다');
const current = summary('new-summary', '- 결정: release 태그는 package 버전과 맞추고 배포는 CI가 한다');

function vectorHit(event: MemoryEvent, score: number) {
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

function setup(ranked: ReturnType<typeof vectorHit>[], visible: MemoryEvent[]) {
  const limits: number[] = [];
  const vectorStore = {
    async search(_vector: number[], options: { limit: number }) {
      limits.push(options.limit);
      return ranked.slice(0, options.limit);
    }
  };
  const store = {
    async keywordSearch() { return []; },
    async getRecentEvents() { return []; },
    async getEvent(id: string) { return visible.find((event) => event.id === id) ?? null; },
    async getEvents(ids: string[]) { return visible.filter((event) => ids.includes(event.id)); },
    async getSessionEvents() { return []; }
  };
  const embedder = { async embed() { return { vector: [0.1, 0.2, 0.3] }; } };
  const retriever = new Retriever(store as never, vectorStore as never, embedder as never, new Matcher());
  return { retriever, limits };
}

describe('vector hits of hidden events', () => {
  it('are dropped before topK and the match, so the visible summary behind one is returned', async () => {
    const { retriever } = setup([vectorHit(hidden, 0.95), vectorHit(current, 0.9)], [current]);

    const out = await retriever.retrieve('release 태그 package 버전', {
      strategy: 'deep',
      topK: 1,
      minScore: 0.5,
      includeSessionContext: false
    });

    expect(out.memories.map((memory) => memory.event.id)).toEqual(['new-summary']);
    expect(out.matchResult.match?.event.id).toBe('new-summary');
  });

  it('are made up for by asking the vector index for more hits', async () => {
    const filler = Array.from({ length: 5 }, (_, i) => summary(`hidden-${i}`, `- 결정: release 태그 package 버전 ${i}`));
    const ranked = [...filler.map((event, i) => vectorHit(event, 0.99 - i * 0.001)), vectorHit(current, 0.9)];
    const { retriever, limits } = setup(ranked, [current]);

    const out = await retriever.retrieve('release 태그 package 버전', {
      strategy: 'deep',
      topK: 1,
      minScore: 0.5,
      includeSessionContext: false
    });

    expect(out.memories.map((memory) => memory.event.id)).toEqual(['new-summary']);
    expect(limits).toEqual([5, 10]);
  });
});
