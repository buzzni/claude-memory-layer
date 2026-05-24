import { describe, it, expect, afterEach } from 'vitest';
import { RetrievalOrchestrator, type RetrievalAccessStore } from '../../src/core/engine/retrieval-orchestrator.js';
import type { Retriever, UnifiedRetrievalResult } from '../../src/core/retriever.js';
import type { MemoryEvent } from '../../src/core/types.js';

function event(id: string): MemoryEvent {
  return {
    id,
    sessionId: 's1',
    eventType: 'user_prompt',
    content: 'remembered project context',
    canonicalKey: `test/${id}`,
    dedupeKey: `s1:${id}`,
    timestamp: new Date('2026-02-24T00:00:00.000Z'),
    metadata: {}
  };
}

function retrievalResult(id = 'e1', overrides: Partial<UnifiedRetrievalResult> = {}): UnifiedRetrievalResult {
  const memoryEvent = event(id);
  return {
    memories: [{ event: memoryEvent, score: 0.91 }],
    matchResult: {
      match: { event: memoryEvent, score: 0.91 },
      confidence: 'high'
    },
    totalTokens: 12,
    context: 'remembered project context',
    fallbackTrace: ['stage:primary:fast'],
    selectedDebug: [{ eventId: id, score: 0.91, semanticScore: 0.8, lexicalScore: 0.2, recencyScore: 0.1 }],
    candidateDebug: [{ eventId: id, score: 0.91, semanticScore: 0.8, lexicalScore: 0.2, recencyScore: 0.1 }],
    ...overrides
  };
}

function stats() {
  return {
    avgScore: 0.8,
    totalEvaluated: 30,
    totalRetrievals: 40,
    helpful: 20,
    neutral: 5,
    unhelpful: 5
  };
}

function noopAccessStore(): RetrievalAccessStore {
  return {
    incrementAccessCount: async (_eventIds) => {},
    recordRetrieval: async (_eventId, _sessionId, _score, _query) => {}
  };
}

afterEach(() => {
  delete process.env.MEMORY_RERANK_WEIGHT_SEMANTIC;
  delete process.env.MEMORY_RERANK_WEIGHT_LEXICAL;
  delete process.env.MEMORY_RERANK_WEIGHT_RECENCY;
});

describe('RetrievalOrchestrator', () => {
  it('delegates project retrieval with strict project scope and records a trace', async () => {
    let initialized = 0;
    let retrieveArgs: { query: string; options: Record<string, unknown> } | null = null;
    const traces: Array<Record<string, unknown>> = [];

    const fakeRetriever = {
      setQueryRewriter() {},
      async retrieve(query: string, options: Record<string, unknown>) {
        retrieveArgs = { query, options };
        return retrievalResult('e1');
      }
    } as unknown as Retriever;

    const orchestrator = new RetrievalOrchestrator({
      initialize: async () => { initialized += 1; },
      retriever: fakeRetriever,
      traceStore: {
        getHelpfulnessStats: async () => stats(),
        recordRetrievalTrace: async (input) => { traces.push(input); }
      },
      accessStore: noopAccessStore(),
      getProjectHash: () => 'project-1',
      hasSharedStore: () => false
    });

    const out = await orchestrator.retrieveMemories('project query', { topK: 3, sessionId: 's1' });

    expect(out.memories[0]?.event.id).toBe('e1');
    expect(initialized).toBe(1);
    expect(retrieveArgs?.query).toBe('project query');
    expect(retrieveArgs?.options.projectHash).toBe('project-1');
    expect(retrieveArgs?.options.projectScopeMode).toBe('strict');
    expect(traces[0]).toMatchObject({
      sessionId: 's1',
      projectHash: 'project-1',
      queryText: 'project query',
      queryRewriteKind: 'none',
      strategy: 'auto',
      candidateEventIds: ['e1'],
      selectedEventIds: ['e1'],
      confidence: 'high',
      fallbackTrace: ['stage:primary:fast']
    });
  });

  it('preserves retrieval lane debug metadata in automatic traces', async () => {
    const traces: Array<Record<string, unknown>> = [];
    const fakeRetriever = {
      setQueryRewriter() {},
      async retrieve() {
        return retrievalResult('lane-e1', {
          selectedDebug: [
            {
              eventId: 'lane-e1',
              score: 0.93,
              semanticScore: 0.89,
              lexicalScore: 0.55,
              recencyScore: 0.2,
              lanes: [{ lane: 'raw_event', reason: 'vector_search', score: 0.93 }]
            } as any
          ],
          candidateDebug: [
            {
              eventId: 'lane-e1',
              score: 0.93,
              semanticScore: 0.89,
              lexicalScore: 0.55,
              recencyScore: 0.2,
              lanes: [
                { lane: 'raw_event', reason: 'vector_search', score: 0.93 },
                { lane: 'facet_match', reason: 'workflow=debugging' }
              ]
            } as any
          ]
        });
      }
    } as unknown as Retriever;

    const orchestrator = new RetrievalOrchestrator({
      initialize: async () => {},
      retriever: fakeRetriever,
      traceStore: {
        getHelpfulnessStats: async () => stats(),
        recordRetrievalTrace: async (input) => { traces.push(input); }
      },
      accessStore: noopAccessStore(),
      getProjectHash: () => 'project-1',
      hasSharedStore: () => false
    });

    await orchestrator.retrieveMemories('debug lane query', { topK: 3, sessionId: 's1' });

    expect((traces[0].selectedDetails as any[])[0].lanes).toEqual([
      { lane: 'raw_event', reason: 'vector_search', score: 0.93 }
    ]);
    expect((traces[0].candidateDetails as any[])[0].lanes).toEqual([
      { lane: 'raw_event', reason: 'vector_search', score: 0.93 },
      { lane: 'facet_match', reason: 'workflow=debugging' }
    ]);
  });

  it('forwards facet filters through retrieveMemories without changing default scoping', async () => {
    let retrieveArgs: { query: string; options: Record<string, unknown> } | null = null;
    const facetFilters = [{ dimension: 'workflow' as const, value: 'debugging' }];

    const fakeRetriever = {
      setQueryRewriter() {},
      async retrieve(query: string, options: Record<string, unknown>) {
        retrieveArgs = { query, options };
        return retrievalResult('facet-e1');
      }
    } as unknown as Retriever;

    const orchestrator = new RetrievalOrchestrator({
      initialize: async () => {},
      retriever: fakeRetriever,
      traceStore: {
        getHelpfulnessStats: async () => stats(),
        recordRetrievalTrace: async () => {}
      },
      accessStore: noopAccessStore(),
      getProjectHash: () => 'project-1',
      hasSharedStore: () => false
    });

    await orchestrator.retrieveMemories('facet filtered query', {
      topK: 3,
      facets: facetFilters
    });

    expect(retrieveArgs?.options.facets).toEqual(facetFilters);
    expect(retrieveArgs?.options.projectHash).toBe('project-1');
    expect(retrieveArgs?.options.projectScopeMode).toBe('strict');
  });

  it('records automatic intent-rewrite metadata when retriever rewrites a query', async () => {
    const traces: Array<Record<string, unknown>> = [];
    const fakeRetriever = {
      setQueryRewriter() {},
      async retrieve() {
        return retrievalResult('rewritten-e1', {
          rawQueryText: '그거 계속',
          effectiveQueryText: '그거 계속 previous implementation plan',
          queryRewriteKind: 'intent-rewrite'
        });
      }
    } as unknown as Retriever;

    const orchestrator = new RetrievalOrchestrator({
      initialize: async () => {},
      retriever: fakeRetriever,
      traceStore: {
        getHelpfulnessStats: async () => stats(),
        recordRetrievalTrace: async (input) => { traces.push(input); }
      },
      accessStore: noopAccessStore(),
      getProjectHash: () => 'project-1',
      hasSharedStore: () => false
    });

    await orchestrator.retrieveMemories('그거 계속', { topK: 3, sessionId: 's1', intentRewrite: true, strategy: 'deep' });

    expect(traces[0]).toMatchObject({
      sessionId: 's1',
      projectHash: 'project-1',
      queryText: '그거 계속 previous implementation plan',
      rawQueryText: '그거 계속',
      queryRewriteKind: 'intent-rewrite',
      strategy: 'deep'
    });
  });

  it('can skip automatic trace recording for read-only retrieval callers', async () => {
    const traces: Array<Record<string, unknown>> = [];
    const fakeRetriever = {
      setQueryRewriter() {},
      async retrieve() {
        return retrievalResult('readonly-e1');
      }
    } as unknown as Retriever;

    const orchestrator = new RetrievalOrchestrator({
      initialize: async () => {},
      retriever: fakeRetriever,
      traceStore: {
        getHelpfulnessStats: async () => stats(),
        recordRetrievalTrace: async (input) => { traces.push(input); }
      },
      accessStore: noopAccessStore(),
      getProjectHash: () => 'project-readonly',
      hasSharedStore: () => false
    });

    await orchestrator.retrieveMemories('secret-bearing read-only query', {
      topK: 3,
      recordTrace: false
    });

    expect(traces).toEqual([]);
  });

  it('does not run full runtime initialization for local fast retrieval', async () => {
    let initialized = 0;
    let statsReads = 0;
    let retrieveArgs: { query: string; options: Record<string, unknown> } | null = null;
    const traces: Array<Record<string, unknown>> = [];

    const fakeRetriever = {
      setQueryRewriter() {},
      async retrieve(query: string, options: Record<string, unknown>) {
        retrieveArgs = { query, options };
        return retrievalResult('fast-e1');
      }
    } as unknown as Retriever;

    const orchestrator = new RetrievalOrchestrator({
      initialize: async () => { initialized += 1; },
      retriever: fakeRetriever,
      traceStore: {
        getHelpfulnessStats: async () => { statsReads += 1; return stats(); },
        recordRetrievalTrace: async (input) => { traces.push(input); }
      },
      accessStore: noopAccessStore(),
      getProjectHash: () => 'project-fast',
      hasSharedStore: () => false
    });

    await orchestrator.retrieveMemories('fast keyword query', {
      strategy: 'fast',
      topK: 3,
      minScore: 0.2
    });

    expect(initialized).toBe(0);
    expect(statsReads).toBe(0);
    expect(retrieveArgs?.options.strategy).toBe('fast');
    expect(retrieveArgs?.options.projectHash).toBe('project-fast');
    expect(traces[0]).toMatchObject({
      strategy: 'fast',
      candidateEventIds: ['fast-e1'],
      selectedEventIds: ['fast-e1']
    });
  });

  it('keeps fast retrieval lightweight when shared search is requested but unavailable', async () => {
    let initialized = 0;
    let localRetrieveCalls = 0;
    let unifiedRetrieveCalls = 0;

    const fakeRetriever = {
      setQueryRewriter() {},
      async retrieve(_query: string, options: Record<string, unknown>) {
        localRetrieveCalls += 1;
        expect(options.includeShared).toBe(true);
        expect(options.strategy).toBe('fast');
        return retrievalResult('local-fast-shared-request');
      },
      async retrieveUnified() {
        unifiedRetrieveCalls += 1;
        return retrievalResult('unexpected-unified');
      }
    } as unknown as Retriever;

    const orchestrator = new RetrievalOrchestrator({
      initialize: async () => { initialized += 1; },
      retriever: fakeRetriever,
      traceStore: {
        getHelpfulnessStats: async () => stats(),
        recordRetrievalTrace: async () => {}
      },
      accessStore: noopAccessStore(),
      getProjectHash: () => 'project-fast',
      hasSharedStore: () => false
    });

    const out = await orchestrator.retrieveMemories('fast query without shared store', {
      strategy: 'fast',
      includeShared: true,
      topK: 3
    });

    expect(out.memories[0]?.event.id).toBe('local-fast-shared-request');
    expect(initialized).toBe(0);
    expect(localRetrieveCalls).toBe(1);
    expect(unifiedRetrieveCalls).toBe(0);
  });

  it('initializes the full runtime for fast retrieval when an actual shared store is available', async () => {
    let initialized = 0;
    let retrieveUnifiedArgs: { query: string; options: Record<string, unknown> } | null = null;

    const fakeRetriever = {
      setQueryRewriter() {},
      async retrieveUnified(query: string, options: Record<string, unknown>) {
        retrieveUnifiedArgs = { query, options };
        return retrievalResult('shared-fast');
      }
    } as unknown as Retriever;

    const orchestrator = new RetrievalOrchestrator({
      initialize: async () => { initialized += 1; },
      retriever: fakeRetriever,
      traceStore: {
        getHelpfulnessStats: async () => stats(),
        recordRetrievalTrace: async () => {}
      },
      accessStore: noopAccessStore(),
      getProjectHash: () => 'project-fast',
      hasSharedStore: () => true
    });

    await orchestrator.retrieveMemories('fast shared query', {
      strategy: 'fast',
      includeShared: true,
      topK: 3
    });

    expect(initialized).toBe(1);
    expect(retrieveUnifiedArgs?.query).toBe('fast shared query');
    expect(retrieveUnifiedArgs?.options.includeShared).toBe(true);
  });

  it('uses unified retrieval and normalized configured rerank weights when shared search is enabled', async () => {
    process.env.MEMORY_RERANK_WEIGHT_SEMANTIC = '3';
    process.env.MEMORY_RERANK_WEIGHT_LEXICAL = '1';
    process.env.MEMORY_RERANK_WEIGHT_RECENCY = '1';

    let retrieveUnifiedArgs: { query: string; options: Record<string, unknown> } | null = null;

    const fakeRetriever = {
      setQueryRewriter() {},
      async retrieveUnified(query: string, options: Record<string, unknown>) {
        retrieveUnifiedArgs = { query, options };
        return retrievalResult('shared-e1');
      }
    } as unknown as Retriever;

    const orchestrator = new RetrievalOrchestrator({
      initialize: async () => {},
      retriever: fakeRetriever,
      traceStore: {
        getHelpfulnessStats: async () => stats(),
        recordRetrievalTrace: async () => {}
      },
      accessStore: noopAccessStore(),
      getProjectHash: () => 'project-2',
      hasSharedStore: () => true
    });

    await orchestrator.retrieveMemories('shared query', {
      includeShared: true,
      intentRewrite: true,
      adaptiveRerank: true
    });

    expect(retrieveUnifiedArgs?.query).toBe('shared query');
    expect(retrieveUnifiedArgs?.options.includeShared).toBe(true);
    expect(retrieveUnifiedArgs?.options.intentRewrite).toBe(true);
    expect(retrieveUnifiedArgs?.options.rerankWeights).toEqual({
      semantic: 0.6,
      lexical: 0.2,
      recency: 0.2
    });
  });

  it('formats high-confidence context through the orchestrator facade', () => {
    const fakeRetriever = {
      setQueryRewriter() {}
    } as unknown as Retriever;
    const orchestrator = new RetrievalOrchestrator({
      initialize: async () => {},
      retriever: fakeRetriever,
      traceStore: {
        getHelpfulnessStats: async () => stats(),
        recordRetrievalTrace: async () => {}
      },
      accessStore: noopAccessStore(),
      getProjectHash: () => null,
      hasSharedStore: () => false
    });

    expect(orchestrator.formatAsContext(retrievalResult())).toContain('High-confidence memory match');
  });

  it('records prompt memory access through the orchestrator access port without full initialization', async () => {
    let initialized = 0;
    const accessCalls: string[][] = [];
    const fakeRetriever = {
      setQueryRewriter() {}
    } as unknown as Retriever;

    const orchestrator = new RetrievalOrchestrator({
      initialize: async () => { initialized += 1; },
      retriever: fakeRetriever,
      traceStore: {
        getHelpfulnessStats: async () => stats(),
        recordRetrievalTrace: async () => {}
      },
      accessStore: {
        incrementAccessCount: async (eventIds) => { accessCalls.push(eventIds); },
        recordRetrieval: async () => {}
      },
      getProjectHash: () => null,
      hasSharedStore: () => false
    });

    await orchestrator.incrementMemoryAccess(['e1', 'e2']);

    expect(initialized).toBe(0);
    expect(accessCalls).toEqual([['e1', 'e2']]);
  });

  it('skips prompt memory access tracking for empty event id lists', async () => {
    let initialized = 0;
    let accessCalls = 0;
    const fakeRetriever = {
      setQueryRewriter() {}
    } as unknown as Retriever;

    const orchestrator = new RetrievalOrchestrator({
      initialize: async () => { initialized += 1; },
      retriever: fakeRetriever,
      traceStore: {
        getHelpfulnessStats: async () => stats(),
        recordRetrievalTrace: async () => {}
      },
      accessStore: {
        incrementAccessCount: async () => { accessCalls += 1; },
        recordRetrieval: async () => {}
      },
      getProjectHash: () => null,
      hasSharedStore: () => false
    });

    await orchestrator.incrementMemoryAccess([]);

    expect(initialized).toBe(0);
    expect(accessCalls).toBe(0);
  });

  it('records retrieval helpfulness events through the orchestrator access port', async () => {
    let initialized = 0;
    const retrievalCalls: Array<{ eventId: string; sessionId: string; score: number; query: string }> = [];
    const fakeRetriever = {
      setQueryRewriter() {}
    } as unknown as Retriever;

    const orchestrator = new RetrievalOrchestrator({
      initialize: async () => { initialized += 1; },
      retriever: fakeRetriever,
      traceStore: {
        getHelpfulnessStats: async () => stats(),
        recordRetrievalTrace: async () => {}
      },
      accessStore: {
        incrementAccessCount: async () => {},
        recordRetrieval: async (eventId, sessionId, score, query) => {
          retrievalCalls.push({ eventId, sessionId, score, query });
        }
      },
      getProjectHash: () => 'project-1',
      hasSharedStore: () => false
    });

    await orchestrator.recordRetrieval('e1', 's1', 0.82, 'thin core');

    expect(initialized).toBe(1);
    expect(retrievalCalls).toEqual([
      { eventId: 'e1', sessionId: 's1', score: 0.82, query: 'thin core' }
    ]);
  });
});
