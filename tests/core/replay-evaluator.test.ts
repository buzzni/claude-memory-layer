import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  evaluateReplayFixture,
  formatReplayEvaluationMarkdown,
  type ReplayEvaluationFixture,
  type ReplayRetrievalRunner
} from '../../src/core/replay-evaluator.js';

const fixture = {
  name: 'private-real-session-qrels',
  description: 'contains raw real session text that reports must not leak',
  ks: [1, 3],
  queries: [
    {
      queryId: 'q-secret-1',
      query: 'SECRET vector search recall regression',
      expectedIds: ['m-secret-1'],
      expectedRelevance: { 'm-secret-1': 2 }
    }
  ],
  memories: [
    {
      id: 'm-secret-1',
      content: 'SECRET vector search recall regression fix uses retriever pipeline replay'
    },
    {
      id: 'm-noise',
      content: 'unrelated dashboard layout memory'
    }
  ]
};

describe('replay fixture evaluator', () => {
  it('evaluates through the retriever pipeline runner and returns a sanitized report', async () => {
    const calls: Array<{ query: string; queryId: string; topK: number }> = [];
    const retrievalRunner: ReplayRetrievalRunner = async (query, input) => {
      calls.push({ query, queryId: input.query.queryId, topK: input.topK });
      return {
        retrievedIds: ['m-secret-1', 'm-noise'],
        candidateIds: ['m-secret-1', 'm-noise'],
        confidence: 'high',
        fallbackTrace: ['stage:primary:fast']
      };
    };

    const report = await evaluateReplayFixture(fixture, {
      generatedAt: '2026-05-05T00:00:00.000Z',
      retrievalRunner
    });
    const serialized = JSON.stringify(report);

    expect(calls).toEqual([
      { query: 'SECRET vector search recall regression', queryId: 'q-secret-1', topK: 3 }
    ]);
    expect(report).toMatchObject({
      name: 'private-real-session-qrels',
      evaluator: 'retriever-pipeline-v1',
      generatedAt: '2026-05-05T00:00:00.000Z',
      fixtureStats: {
        queryCount: 1,
        memoryCount: 2,
        ks: [1, 3]
      },
      summary: {
        queryCount: 1,
        precisionAtK: { 1: 1, 3: 1 / 3 },
        recallAtK: { 1: 1, 3: 1 },
        ndcgAtK: { 1: 1, 3: 1 },
        hitAtK: { 1: 1, 3: 1 },
        mrr: 1,
        failedQueryCount: 0
      }
    });
    expect(report.perQuery).toEqual([
      {
        queryId: 'q-secret-1',
        expectedIds: ['m-secret-1'],
        retrievedIds: ['m-secret-1', 'm-noise'],
        candidateIds: ['m-secret-1', 'm-noise'],
        confidence: 'high',
        fallbackTrace: ['stage:primary:fast'],
        reciprocalRank: 1,
        at: {
          1: { precision: 1, recall: 1, hits: 1, ndcg: 1 },
          3: { precision: 1 / 3, recall: 1, hits: 1, ndcg: 1 }
        }
      }
    ]);
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('vector search recall regression');
  });

  it('uses the real in-memory Retriever/RetrievalOrchestrator pipeline by default', async () => {
    const report = await evaluateReplayFixture(fixture, {
      generatedAt: '2026-05-05T00:00:00.000Z',
      retrievalOptions: { strategy: 'fast' }
    });

    expect(report.evaluator).toBe('retriever-pipeline-v1');
    expect(report.perQuery[0]).toMatchObject({
      queryId: 'q-secret-1',
      retrievedIds: expect.arrayContaining(['m-secret-1']),
      candidateIds: expect.arrayContaining(['m-secret-1']),
      fallbackTrace: expect.arrayContaining(['stage:primary:fast'])
    });
    expect(report.summary.hitAtK[1]).toBe(1);
  });

  it('uses optional searchContent as a private retrieval-only key without exposing it in reports', async () => {
    const report = await evaluateReplayFixture({
      name: 'search-content-key-fixture',
      ks: [1],
      queries: [
        {
          queryId: 'q-search-key',
          query: 'atlas zephyr codename',
          expectedIds: ['m-search-key']
        }
      ],
      memories: [
        {
          id: 'm-search-key',
          content: 'VISIBLE_ORIGINAL_READER_TEXT should remain the answer context only.',
          searchContent: 'atlas zephyr codename'
        },
        {
          id: 'm-noise',
          content: 'unrelated dashboard layout memory'
        }
      ]
    }, {
      generatedAt: '2026-05-05T00:00:00.000Z',
      retrievalOptions: { strategy: 'fast' }
    });

    expect(report.perQuery[0]).toMatchObject({
      queryId: 'q-search-key',
      retrievedIds: ['m-search-key'],
      candidateIds: ['m-search-key'],
      fallbackTrace: expect.arrayContaining(['stage:primary:fast'])
    });
    expect(report.summary.hitAtK[1]).toBe(1);
    expect(JSON.stringify(report)).not.toContain('atlas zephyr codename');
    expect(JSON.stringify(report)).not.toContain('VISIBLE_ORIGINAL_READER_TEXT');
  });

  it('counts no-match qrels separately from positive retrieval misses', async () => {
    const report = await evaluateReplayFixture({
      name: 'negative-qrels-fixture',
      ks: [1, 3],
      queries: [
        {
          queryId: 'q-positive',
          query: 'retriever pipeline replay answer',
          expectation: 'match',
          expectedIds: ['m-positive'],
          expectedRelevance: { 'm-positive': 2 },
          knownAnswer: 'Retriever pipeline replay answer should be found.'
        },
        {
          queryId: 'q-command-artifact-no-match',
          query: 'local-command-stdout command-name opus',
          expectation: 'no_match',
          expectedIds: [],
          expectedRelevance: {},
          forbiddenIds: ['m-positive']
        }
      ],
      memories: [
        {
          id: 'm-positive',
          content: 'Retriever pipeline replay answer should be found.'
        }
      ]
    }, {
      generatedAt: '2026-05-05T00:00:00.000Z',
      retrievalOptions: { strategy: 'auto' }
    });

    expect(report.summary).toMatchObject({
      queryCount: 2,
      positiveQueryCount: 1,
      noMatchQueryCount: 1,
      noMatchCorrect: 1,
      noMatchAccuracy: 1,
      failedQueryCount: 0,
      precisionAtK: { 1: 1, 3: 1 / 3 },
      recallAtK: { 1: 1, 3: 1 },
      hitAtK: { 1: 1, 3: 1 }
    });
    expect(report.perQuery[1]).toMatchObject({
      queryId: 'q-command-artifact-no-match',
      expectation: 'no_match',
      retrievedIds: [],
      forbiddenHitIds: [],
      noMatchSatisfied: true,
      confidence: 'none'
    });
  });

  it('fails no-match qrels when low-confidence candidates would still be injected', async () => {
    const retrievalRunner: ReplayRetrievalRunner = async (_query, input) => {
      if (input.query.queryId === 'q-no-match') {
        return { retrievedIds: ['m-noise'], candidateIds: ['m-noise'], confidence: 'none' };
      }
      return { retrievedIds: ['m-positive'], candidateIds: ['m-positive'], confidence: 'high' };
    };

    const report = await evaluateReplayFixture({
      name: 'strict-no-match-fixture',
      ks: [1],
      queries: [
        {
          queryId: 'q-positive',
          query: 'positive replay answer',
          expectation: 'match',
          expectedIds: ['m-positive'],
          expectedRelevance: { 'm-positive': 2 }
        },
        {
          queryId: 'q-no-match',
          query: 'unrelated topic should not inject context',
          expectation: 'no_match',
          expectedIds: [],
          expectedRelevance: {},
          forbiddenIds: []
        }
      ],
      memories: [
        { id: 'm-positive', content: 'positive replay answer' },
        { id: 'm-noise', content: 'low confidence unrelated candidate' }
      ]
    }, {
      generatedAt: '2026-05-05T00:00:00.000Z',
      retrievalRunner
    });

    expect(report.summary).toMatchObject({
      noMatchCorrect: 0,
      noMatchAccuracy: 0,
      failedQueryCount: 1
    });
    expect(report.perQuery[1]).toMatchObject({
      queryId: 'q-no-match',
      retrievedIds: ['m-noise'],
      forbiddenHitIds: [],
      noMatchSatisfied: false,
      confidence: 'none'
    });
    expect(report.summary.failedQueries).toEqual([
      {
        queryId: 'q-no-match',
        expectedIds: [],
        retrievedIds: ['m-noise'],
        expectation: 'no_match',
        reason: 'unexpected_match'
      }
    ]);
  });

  it('applies temporal date boost only to entity-overlapping candidates', async () => {
    const retrievalRunner: ReplayRetrievalRunner = async () => ({
      retrievedIds: ['m-same-date-no-entity', 'm-answer', 'm-far-entity'],
      candidateIds: ['m-same-date-no-entity', 'm-answer', 'm-far-entity'],
      confidence: 'high',
      fallbackTrace: ['stage:primary:fast']
    });

    const report = await evaluateReplayFixture({
      name: 'temporal-date-boost-fixture',
      ks: [1, 3],
      queries: [
        {
          queryId: 'q-temporal-boost',
          category: 'temporal-reasoning',
          query: 'What did I do 12 days ago at the museum exhibit?',
          expectedIds: ['m-answer'],
          expectedRelevance: { 'm-answer': 3 },
          temporalDateBoost: {
            referenceDate: '2023-02-01',
            targetDate: '2023-01-20',
            toleranceDays: 1,
            entityTerms: ['museum', 'exhibit']
          }
        }
      ],
      memories: [
        {
          id: 'm-same-date-no-entity',
          timestamp: '2023-01-20',
          content: 'I renewed my passport and reviewed the calendar.'
        },
        {
          id: 'm-answer',
          timestamp: '2023-01-21',
          content: 'I attended the museum exhibit with Maya.'
        },
        {
          id: 'm-far-entity',
          timestamp: '2022-12-01',
          content: 'I read about a museum exhibit online.'
        }
      ]
    }, {
      generatedAt: '2026-05-05T00:00:00.000Z',
      retrievalRunner
    });

    expect(report.perQuery[0].retrievedIds).toEqual([
      'm-answer',
      'm-same-date-no-entity',
      'm-far-entity'
    ]);
    expect(report.perQuery[0].fallbackTrace).toContain('temporal-date-boost:applied');
    expect(report.summary.hitAtK[1]).toBe(1);
  });

  it('formats markdown reports without raw query or memory content', async () => {
    const report = await evaluateReplayFixture(fixture, {
      generatedAt: '2026-05-05T00:00:00.000Z',
      includePerQuery: false
    });

    const markdown = formatReplayEvaluationMarkdown(report, {
      qrelsPath: '.claude-memory/benchmarks/real-session-qrels.json'
    });

    expect(markdown).toContain('# Retrieval Replay Benchmark Report');
    expect(markdown).toContain('private-real-session-qrels');
    expect(markdown).toContain('nDCG@1');
    expect(markdown).toContain('Hit@1');
    expect(markdown).toContain('MRR');
    expect(markdown).toContain('.claude-memory/benchmarks/real-session-qrels.json');
    expect(markdown).not.toContain('SECRET');
    expect(markdown).not.toContain('vector search recall regression');
  });

  it('summarizes query yield and category breakdown for golden replay safety gates', async () => {
    const categoryFixture = {
      name: 'category-golden-replay',
      ks: [1, 3],
      queries: [
        {
          queryId: 'q-continuation',
          category: 'continuation',
          query: 'PRIVATE_CONTINUE_PROMPT_SHOULD_NOT_LEAK',
          expectation: 'match',
          expectedIds: ['m-continuation'],
          expectedRelevance: { 'm-continuation': 3 }
        },
        {
          queryId: 'q-debugging',
          category: 'debugging',
          query: 'PRIVATE_DEBUG_PROMPT_SHOULD_NOT_LEAK',
          expectation: 'match',
          expectedIds: ['m-debugging'],
          expectedRelevance: { 'm-debugging': 2 }
        },
        {
          queryId: 'q-cross-project',
          category: 'cross-project-contamination',
          query: 'PRIVATE_OTHER_PROJECT_PROMPT_SHOULD_NOT_LEAK',
          expectation: 'no_match',
          expectedIds: [],
          expectedRelevance: {},
          forbiddenIds: ['m-debugging']
        }
      ],
      memories: [
        { id: 'm-continuation', content: 'PRIVATE_CONTINUE_MEMORY_SHOULD_NOT_LEAK' },
        { id: 'm-debugging', content: 'PRIVATE_DEBUG_MEMORY_SHOULD_NOT_LEAK' }
      ]
    };
    const retrievalRunner: ReplayRetrievalRunner = async (_query, input) => {
      if (input.query.queryId === 'q-continuation') {
        return { retrievedIds: ['m-continuation'], candidateIds: ['m-continuation'], confidence: 'high' };
      }
      return { retrievedIds: [], candidateIds: [], confidence: 'none' };
    };

    const report = await evaluateReplayFixture(categoryFixture, {
      generatedAt: '2026-05-05T00:00:00.000Z',
      retrievalRunner
    });
    const markdown = formatReplayEvaluationMarkdown(report);

    expect(report.summary).toMatchObject({
      positiveQueryCount: 2,
      noMatchQueryCount: 1,
      failedQueryCount: 1,
      queryYieldRate: 0.5,
      categoryBreakdown: {
        continuation: {
          queryCount: 1,
          positiveQueryCount: 1,
          failedQueryCount: 0,
          queryYieldRate: 1,
          recallAtK: { 1: 1, 3: 1 }
        },
        debugging: {
          queryCount: 1,
          positiveQueryCount: 1,
          failedQueryCount: 1,
          queryYieldRate: 0,
          recallAtK: { 1: 0, 3: 0 }
        },
        'cross-project-contamination': {
          queryCount: 1,
          noMatchQueryCount: 1,
          noMatchAccuracy: 1,
          forbiddenHitCount: 0
        }
      }
    });
    expect(markdown).toContain('Query yield rate');
    expect(markdown).toContain('## Category breakdown');
    expect(markdown).toContain('cross-project-contamination');
    expect(JSON.stringify(report)).not.toContain('PRIVATE_');
    expect(markdown).not.toContain('PRIVATE_');
  });

  it('meets the golden usefulness noise-reduction gate with the default retriever', async () => {
    const goldenFixture = JSON.parse(
      readFileSync('benchmarks/replay/golden-memory-usefulness-v1.json', 'utf8')
    ) as ReplayEvaluationFixture;

    const report = await evaluateReplayFixture(goldenFixture, {
      generatedAt: '2026-05-09T00:00:00.000Z',
      includePerQuery: false,
      retrievalOptions: { strategy: 'auto' }
    });

    expect(report.summary.queryYieldRate).toBe(1);
    expect(report.summary.noMatchAccuracy).toBe(1);
    expect(report.summary.forbiddenHitCount).toBe(0);
    expect(report.summary.failedQueryCount).toBe(0);
    expect(report.summary.categoryBreakdown['korean-short-follow-up']?.queryYieldRate).toBe(1);
    expect(report.summary.categoryBreakdown['stale-memory-trap']?.noMatchAccuracy).toBe(1);
    expect(report.summary.categoryBreakdown['stale-continuation-trap']?.noMatchAccuracy).toBe(1);
    expect(report.summary.categoryBreakdown['cross-project-contamination']?.forbiddenHitCount).toBe(0);
    expect(report.summary.categoryBreakdown['compaction-handoff-noise']?.noMatchAccuracy).toBe(1);
    expect(report.summary.categoryBreakdown['compaction-handoff-noise']?.forbiddenHitCount).toBe(0);
  });

  it('recalls privacy/dashboard decision memories in the golden replay set', async () => {
    const goldenFixture = JSON.parse(
      readFileSync('benchmarks/replay/golden-memory-usefulness-v1.json', 'utf8')
    ) as ReplayEvaluationFixture;

    const report = await evaluateReplayFixture(goldenFixture, {
      generatedAt: '2026-05-09T00:00:00.000Z',
      retrievalOptions: { strategy: 'auto' }
    });
    const decisionRecall = report.perQuery.find(
      (query) => query.queryId === 'q-decision-recall-privacy-dashboard'
    );

    expect(decisionRecall?.retrievedIds).toEqual(expect.arrayContaining([
      'm-retrieval-telemetry-privacy',
      'm-dashboard-safe-trace-metadata'
    ]));
    expect(decisionRecall?.reciprocalRank).toBeGreaterThan(0);
    expect(report.summary.failedQueries.map((query) => query.queryId)).not.toContain(
      'q-decision-recall-privacy-dashboard'
    );
  });

  it('ships operations replay fixture categories for operation-layer retrieval and privacy gates', async () => {
    const operationsFixture = JSON.parse(
      readFileSync('benchmarks/replay/memory-operations-v1.json', 'utf8')
    ) as ReplayEvaluationFixture;
    const requiredCategories = [
      'facet-filter-positive',
      'facet-filter-no-match',
      'graph-path-explanation',
      'retention-quarantine-suppression',
      'source-ref-redaction',
      'action-frontier-relevance'
    ];
    const categories = new Set(operationsFixture.queries.map((query) => query.category));
    const serializedFixture = JSON.stringify(operationsFixture);

    expect(operationsFixture.name).toBe('memory-operations-v1');
    expect(operationsFixture.metadata).toMatchObject({ rawContentIncluded: false });
    expect(operationsFixture.queries.length).toBeGreaterThanOrEqual(requiredCategories.length);
    expect(operationsFixture.memories.length).toBeGreaterThanOrEqual(requiredCategories.length);
    expect([...categories]).toEqual(expect.arrayContaining(requiredCategories));
    for (const category of requiredCategories) {
      expect(operationsFixture.queries.some((query) => query.category === category)).toBe(true);
    }
    expect(operationsFixture.queries.some(
      (query) => query.category === 'facet-filter-no-match' && query.expectation === 'no_match'
    )).toBe(true);
    expect(serializedFixture).not.toMatch(/\/Users\//);
    expect(serializedFixture).not.toMatch(/PRIVATE_|SECRET|TOKEN|PASSWORD/i);

    const report = await evaluateReplayFixture(operationsFixture, {
      generatedAt: '2026-05-21T00:00:00.000Z',
      includePerQuery: false,
      retrievalOptions: { strategy: 'auto' }
    });
    const markdown = formatReplayEvaluationMarkdown(report, {
      qrelsPath: 'benchmarks/replay/memory-operations-v1.json'
    });

    expect(report.summary.queryYieldRate).toBe(1);
    expect(report.summary.noMatchAccuracy).toBe(1);
    expect(report.summary.forbiddenHitCount).toBe(0);
    expect(report.summary.failedQueryCount).toBe(0);
    for (const category of requiredCategories) {
      expect(report.summary.categoryBreakdown[category]).toBeDefined();
    }
    expect(markdown).toContain('memory-operations-v1');
    expect(markdown).toContain('facet-filter-positive');
    expect(markdown).not.toMatch(/PRIVATE_|SECRET|TOKEN|PASSWORD/i);
  });

  it('ships a privacy-safe golden replay fixture and npm eval script', () => {
    const fixture = JSON.parse(
      readFileSync('benchmarks/replay/golden-memory-usefulness-v1.json', 'utf8')
    ) as ReplayEvaluationFixture;
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const categories = new Set(fixture.queries.map((query) => query.category));
    const serialized = JSON.stringify(fixture);

    expect(fixture.name).toBe('golden-memory-usefulness-v1');
    expect(fixture.metadata).toMatchObject({ rawContentIncluded: false });
    expect(fixture.queries.length).toBeGreaterThanOrEqual(12);
    expect(fixture.memories.length).toBeGreaterThanOrEqual(12);
    expect([...categories]).toEqual(expect.arrayContaining([
      'korean-short-follow-up',
      'continuation',
      'project-code-task',
      'debugging',
      'decision-recall',
      'topic-shift-no-match',
      'stale-memory-trap',
      'stale-continuation-trap',
      'cross-project-contamination',
      'compaction-handoff-noise'
    ]));
    const compactionTrap = fixture.queries.find(
      (query) => query.queryId === 'q-compaction-handoff-trap-active-task'
    );
    expect(compactionTrap).toMatchObject({
      category: 'compaction-handoff-noise',
      expectation: 'no_match',
      expectedIds: [],
      forbiddenIds: ['m-compaction-handoff-summary', 'm-compressed-todo-state']
    });
    const staleContinuationTrap = fixture.queries.find(
      (query) => query.queryId === 'q-stale-continuation-trap-compacted-next-step'
    );
    expect(staleContinuationTrap).toMatchObject({
      category: 'stale-continuation-trap',
      expectation: 'no_match',
      expectedIds: [],
      forbiddenIds: ['m-stale-compacted-next-step']
    });
    expect(packageJson.scripts?.['eval:retrieval-replay']).toBe(
      'tsx scripts/replay-retrieval-benchmark.ts --fixture benchmarks/replay/golden-memory-usefulness-v1.json --format markdown --no-per-query --min-query-yield 1 --min-no-match-accuracy 1 --max-forbidden-hits 0 --max-failed-queries 0'
    );
    expect(packageJson.scripts?.['eval:retrieval-replay:report']).toBe(
      'tsx scripts/replay-retrieval-benchmark.ts --fixture benchmarks/replay/golden-memory-usefulness-v1.json --format markdown --no-per-query'
    );
    expect(packageJson.scripts?.['benchmark:replay:promote-review']).toBe(
      'tsx scripts/promote-retrieval-review-queue.ts'
    );
    expect(packageJson.scripts?.['benchmark:replay:validate-promotion']).toBe(
      'tsx scripts/validate-replay-promotion-candidates.ts'
    );
    expect(serialized).not.toMatch(/\/Users\//);
    expect(serialized).not.toMatch(/PRIVATE_|SECRET|TOKEN|PASSWORD/i);
  });
});
