import { describe, expect, it } from 'vitest';

import {
  evaluateReplayFixture,
  formatReplayEvaluationMarkdown,
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
});
