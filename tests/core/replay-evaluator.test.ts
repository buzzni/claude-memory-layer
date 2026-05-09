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
      'cross-project-contamination'
    ]));
    expect(packageJson.scripts?.['eval:retrieval-replay']).toBe(
      'tsx scripts/replay-retrieval-benchmark.ts --fixture benchmarks/replay/golden-memory-usefulness-v1.json --format markdown --no-per-query'
    );
    expect(serialized).not.toMatch(/\/Users\//);
    expect(serialized).not.toMatch(/PRIVATE_|SECRET|TOKEN|PASSWORD/i);
  });
});
