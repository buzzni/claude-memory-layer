import { describe, it, expect } from 'vitest';
import { RetrievalDisclosureService } from '../src/core/engine/retrieval-disclosure-service.js';
import type { UnifiedRetrievalResult } from '../src/core/retriever.js';
import type { MemoryEvent, SharedTroubleshootingEntry } from '../src/core/types.js';

function event(id: string, content: string, timestamp: string, eventType: MemoryEvent['eventType'] = 'user_prompt'): MemoryEvent {
  return {
    id,
    sessionId: 's1',
    eventType,
    content,
    canonicalKey: `canonical/${id}`,
    dedupeKey: `s1:${id}`,
    timestamp: new Date(timestamp),
    metadata: { filePath: `src/${id}.ts` }
  };
}

const timeline = [
  event('e1', 'Earlier user question about checkout memory', '2026-02-24T00:00:00.000Z'),
  event('e2', 'Target assistant answer with checkout fix details', '2026-02-24T00:01:00.000Z', 'agent_response'),
  event('e3', 'Later tool observation after applying the checkout fix', '2026-02-24T00:02:00.000Z', 'tool_observation')
];

const sharedEntry: SharedTroubleshootingEntry = {
  entryId: 'shared-1',
  sourceProjectHash: 'project-a',
  sourceEntryId: 'e-shared',
  title: 'Shared checkout troubleshooting',
  symptoms: ['checkout fails'],
  rootCause: 'stale cache',
  solution: 'clear cache and retry',
  topics: ['checkout'],
  confidence: 0.88,
  usageCount: 3,
  promotedAt: new Date('2026-02-23T00:00:00.000Z'),
  createdAt: new Date('2026-02-23T00:00:00.000Z')
};

function retrievalResult(sharedMemories: SharedTroubleshootingEntry[] = []): UnifiedRetrievalResult {
  return {
    memories: [{ event: timeline[1], score: 0.93, sessionContext: 'short surrounding context' }],
    matchResult: {
      match: { event: timeline[1], score: 0.93 },
      confidence: 'high'
    },
    totalTokens: 42,
    context: 'Target assistant answer with checkout fix details',
    fallbackTrace: ['stage:primary:fast', 'fallback:deep'],
    selectedDebug: [{ eventId: 'e2', score: 0.93, semanticScore: 0.82, lexicalScore: 0.41, recencyScore: 0.12 }],
    candidateDebug: [{ eventId: 'e2', score: 0.93, semanticScore: 0.82, lexicalScore: 0.41, recencyScore: 0.12 }],
    sharedMemories
  };
}

function service(result: UnifiedRetrievalResult = retrievalResult()) {
  return new RetrievalDisclosureService({
    initialize: async () => {},
    retrievalOrchestrator: {
      retrieveMemories: async () => result
    },
    eventStore: {
      getEvent: async (id: string) => timeline.find((item) => item.id === id) ?? null,
      getSessionEvents: async (sessionId: string) => timeline.filter((item) => item.sessionId === sessionId)
    }
  });
}

describe('RetrievalDisclosureService', () => {
  it('search returns spec-aligned compact envelopes with reasons and source refs', async () => {
    const out = await service().search('checkout fix', { topK: 1, sessionId: 's1' });

    expect(out.meta).toMatchObject({
      total: 1,
      usedVector: true,
      usedKeyword: true,
      fallbackApplied: true
    });
    expect(out.results[0]).toMatchObject({
      id: 'event:e2',
      resultType: 'source',
      score: 0.93,
      snippet: 'Target assistant answer with checkout fix details',
      sourceRef: 'event:e2',
      sessionId: 's1',
      metadata: {
        eventId: 'e2',
        eventType: 'agent_response',
        canonicalKey: 'canonical/e2'
      }
    });
    expect(out.results[0].reasons).toEqual(
      expect.arrayContaining([
        'semantic_match',
        'keyword_match',
        'recent_relevance',
        'continuity_link'
      ])
    );
  });

  it('reports keyword-only fast retrieval without claiming vector usage', async () => {
    const keywordOnly = {
      ...retrievalResult(),
      fallbackTrace: ['stage:primary:fast']
    };

    const out = await service(keywordOnly).search('checkout fix', { strategy: 'fast' });

    expect(out.meta).toMatchObject({
      usedVector: false,
      usedKeyword: true,
      fallbackApplied: false
    });
    expect(out.results[0].reasons).not.toContain('summary_fallback');
  });

  it('search includes shared memories instead of silently dropping them', async () => {
    const out = await service(retrievalResult([sharedEntry])).search('checkout fix', { includeShared: true });

    expect(out.meta.total).toBe(2);
    expect(out.results.find((item) => item.id === 'shared:shared-1')).toMatchObject({
      resultType: 'rule',
      title: 'Shared checkout troubleshooting',
      snippet: 'clear cache and retry',
      sourceRef: 'shared:shared-1',
      reasons: ['semantic_match'],
      metadata: {
        sourceProjectHash: 'project-a',
        sourceEntryId: 'e-shared'
      }
    });
  });

  it('expand returns target envelope, surrounding context, and related source references', async () => {
    const expanded = await service().expand('event:e2', { windowSize: 1 });

    expect(expanded?.target.id).toBe('event:e2');
    expect(expanded?.target.snippet).toContain('checkout fix details');
    expect(expanded?.surroundingFacts?.map((item) => item.id)).toEqual(['event:e1', 'event:e3']);
    expect(expanded?.relatedSources?.[0]).toMatchObject({
      sourceRef: 'event:e1',
      sourceType: 'raw_event',
      eventIds: ['e1']
    });
    expect(expanded?.expandedContext).toContain('[agent_response] Target assistant answer');
  });

  it('source returns a spec-aligned source reference plus raw drill-down events', async () => {
    const source = await service().source('event:e2');

    expect(source).toMatchObject({
      sourceRef: 'event:e2',
      sourceType: 'raw_event',
      eventIds: ['e2']
    });
    expect(source?.rawEvents[0].id).toBe('e2');
    expect(source?.rawEvents[0].metadata).toEqual({ filePath: 'src/e2.ts' });
  });

  it('returns null when expand/source cannot resolve the result id', async () => {
    await expect(service().expand('event:missing')).resolves.toBeNull();
    await expect(service().source('event:missing')).resolves.toBeNull();
  });
});
