import { describe, expect, it } from 'vitest';

import {
  evaluateReplayFixture,
  formatReplayEvaluationMarkdown
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
      content: 'SECRET vector search recall regression fix uses token overlap baseline'
    },
    {
      id: 'm-noise',
      content: 'unrelated dashboard layout memory'
    }
  ]
};

describe('replay fixture evaluator', () => {
  it('evaluates token-overlap retrieval and returns a sanitized report', () => {
    const report = evaluateReplayFixture(fixture, {
      generatedAt: '2026-05-05T00:00:00.000Z'
    });
    const serialized = JSON.stringify(report);

    expect(report).toMatchObject({
      name: 'private-real-session-qrels',
      evaluator: 'token-overlap-v1',
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
        ndcgAtK: { 1: 1, 3: 1 }
      }
    });
    expect(report.perQuery).toEqual([
      {
        queryId: 'q-secret-1',
        at: {
          1: { precision: 1, recall: 1, hits: 1, ndcg: 1 },
          3: { precision: 1 / 3, recall: 1, hits: 1, ndcg: 1 }
        }
      }
    ]);
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('vector search recall regression');
  });

  it('formats markdown reports without raw query or memory content', () => {
    const report = evaluateReplayFixture(fixture, {
      generatedAt: '2026-05-05T00:00:00.000Z',
      includePerQuery: false
    });

    const markdown = formatReplayEvaluationMarkdown(report, {
      qrelsPath: '.claude-memory/benchmarks/real-session-qrels.json'
    });

    expect(markdown).toContain('# Retrieval Replay Benchmark Report');
    expect(markdown).toContain('private-real-session-qrels');
    expect(markdown).toContain('nDCG@1');
    expect(markdown).toContain('.claude-memory/benchmarks/real-session-qrels.json');
    expect(markdown).not.toContain('SECRET');
    expect(markdown).not.toContain('vector search recall regression');
  });
});
