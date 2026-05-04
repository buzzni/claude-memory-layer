import { describe, expect, it } from 'vitest';
import {
  createRetrievalServices,
  type RetrievalEventStore
} from '../../src/core/engine/retrieval-services.js';
import type { Embedder } from '../../src/core/embedder.js';
import type { Matcher } from '../../src/core/matcher.js';
import type { Retriever, UnifiedRetrievalResult } from '../../src/core/retriever.js';
import type { MemoryEvent } from '../../src/core/types.js';
import type { VectorStore } from '../../src/core/vector-store.js';

function event(id: string): MemoryEvent {
  return {
    id,
    sessionId: 's1',
    eventType: 'agent_response',
    content: 'retrieval factory keeps MemoryService thin',
    canonicalKey: `test/${id}`,
    dedupeKey: `s1:${id}`,
    timestamp: new Date('2026-02-25T00:00:00.000Z'),
    metadata: {}
  };
}

function retrievalResult(id = 'e1'): UnifiedRetrievalResult {
  const memoryEvent = event(id);
  return {
    memories: [{ event: memoryEvent, score: 0.92, sessionContext: 'nearby context' }],
    matchResult: {
      match: { event: memoryEvent, score: 0.92 },
      confidence: 'high'
    },
    totalTokens: 10,
    context: memoryEvent.content,
    fallbackTrace: ['stage:primary:fast'],
    selectedDebug: [{ eventId: id, score: 0.92, semanticScore: 0.8, lexicalScore: 0.4, recencyScore: 0.1 }],
    candidateDebug: [{ eventId: id, score: 0.92, semanticScore: 0.8, lexicalScore: 0.4, recencyScore: 0.1 }]
  };
}

describe('createRetrievalServices', () => {
  it('builds one retriever and wires the retrieval service bundle to shared ports', async () => {
    let initializeCalls = 0;
    const traceInputs: Array<Record<string, unknown>> = [];
    const retrieveCalls: Array<{ query: string; options: Record<string, unknown> }> = [];
    const traceStats = {
      totalQueries: 2,
      avgCandidateCount: 1,
      avgSelectedCount: 1,
      selectionRate: 1
    };
    const vectorStore = { marker: 'vector' } as unknown as VectorStore;
    const embedder = { marker: 'embedder' } as unknown as Embedder;
    const matcher = { marker: 'matcher' } as unknown as Matcher;
    const store = {
      getHelpfulnessStats: async () => ({
        avgScore: 0.8,
        totalEvaluated: 25,
        totalRetrievals: 30,
        helpful: 20,
        neutral: 3,
        unhelpful: 2
      }),
      recordRetrievalTrace: async (input: Record<string, unknown>) => { traceInputs.push(input); },
      incrementAccessCount: async (_eventIds: string[]) => {},
      recordRetrieval: async (_eventId: string, _sessionId: string, _score: number, _query: string) => {},
      getEvent: async (id: string) => event(id),
      getSessionEvents: async (_sessionId: string) => [event('e1')],
      getRecentEvents: async (_limit?: number) => [event('e1')],
      getRetrievalTraceStats: async () => traceStats,
      getRecentRetrievalTraces: async () => [],
      getMostAccessed: async () => [],
      evaluateSessionHelpfulness: async (_sessionId: string) => {},
      getUnevaluatedSessions: async () => [],
      getHelpfulMemories: async () => []
    };
    let createArgs: {
      eventStore: unknown;
      vectorStore: unknown;
      embedder: unknown;
      matcher: unknown;
    } | null = null;
    let registeredRewriter: ((query: string) => Promise<string | null>) | null = null;
    const fakeRetriever = {
      setQueryRewriter(rewriter: (query: string) => Promise<string | null>) {
        registeredRewriter = rewriter;
      },
      async retrieve(query: string, options: Record<string, unknown>) {
        retrieveCalls.push({ query, options });
        return retrievalResult('e1');
      }
    } as unknown as Retriever;

    const services = createRetrievalServices({
      initialize: async () => { initializeCalls += 1; },
      eventStore: store,
      vectorStore,
      embedder,
      matcher,
      getProjectHash: () => 'project-1',
      hasSharedStore: () => false,
      createRetriever: (eventStore, vectorStoreArg, embedderArg, matcherArg) => {
        createArgs = {
          eventStore,
          vectorStore: vectorStoreArg,
          embedder: embedderArg,
          matcher: matcherArg
        };
        return fakeRetriever;
      }
    });

    expect(services.retriever).toBe(fakeRetriever);
    expect(createArgs).toEqual({ eventStore: store, vectorStore, embedder, matcher });
    expect(registeredRewriter).toEqual(expect.any(Function));

    await services.retrievalOrchestrator.retrieveMemories('thin core', { sessionId: 's1', topK: 2 });

    expect(retrieveCalls[0]).toMatchObject({
      query: 'thin core',
      options: {
        topK: 2,
        projectHash: 'project-1',
        projectScopeMode: 'strict'
      }
    });
    expect(traceInputs[0]).toMatchObject({
      sessionId: 's1',
      projectHash: 'project-1',
      queryText: 'thin core',
      selectedEventIds: ['e1'],
      candidateEventIds: ['e1'],
      confidence: 'high'
    });

    const disclosure = await services.retrievalDisclosureService.search('thin core disclosure', { topK: 1 });
    expect(disclosure.results[0]).toMatchObject({
      id: 'event:e1',
      sourceRef: 'event:e1',
      sessionId: 's1'
    });

    await expect(services.retrievalAnalyticsService.getRetrievalTraceStats()).resolves.toEqual(traceStats);
    expect(initializeCalls).toBe(3);
  });

  it('rejects default retriever stores that lack retriever read methods', () => {
    const incompleteStore = {
      recordRetrievalTrace: async (_input: Record<string, unknown>) => {},
      incrementAccessCount: async (_eventIds: string[]) => {},
      recordRetrieval: async (_eventId: string, _sessionId: string, _score: number, _query: string) => {},
      getEvent: async (id: string) => event(id),
      getSessionEvents: async (_sessionId: string) => [event('e1')],
      getRetrievalTraceStats: async () => ({
        totalQueries: 0,
        avgCandidateCount: 0,
        avgSelectedCount: 0,
        selectionRate: 0
      }),
      getRecentRetrievalTraces: async () => [],
      getMostAccessed: async () => [],
      evaluateSessionHelpfulness: async (_sessionId: string) => {},
      getUnevaluatedSessions: async () => [],
      getHelpfulMemories: async () => [],
      getHelpfulnessStats: async () => ({
        avgScore: 0,
        totalEvaluated: 0,
        totalRetrievals: 0,
        helpful: 0,
        neutral: 0,
        unhelpful: 0
      })
    } as unknown as RetrievalEventStore;

    expect(() => createRetrievalServices({
      initialize: async () => {},
      eventStore: incompleteStore,
      vectorStore: { marker: 'vector' } as unknown as VectorStore,
      embedder: { marker: 'embedder' } as unknown as Embedder,
      matcher: { marker: 'matcher' } as unknown as Matcher,
      getProjectHash: () => null,
      hasSharedStore: () => false
    })).toThrow(/getRecentEvents/);
  });
});
