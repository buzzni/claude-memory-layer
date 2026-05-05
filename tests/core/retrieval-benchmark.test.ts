import { describe, expect, it } from 'vitest';

import { computePrecisionRecallAtK, summarizeReplayMetrics } from '../../src/core/retrieval-benchmark.js';

describe('retrieval replay benchmark metrics', () => {
  it('computes Precision@k and Recall@k for replay queries', () => {
    const queryMetrics = computePrecisionRecallAtK(
      [
        { queryId: 'q1', expectedIds: ['a', 'b'], retrievedIds: ['a', 'x', 'b'] },
        { queryId: 'q2', expectedIds: ['c'], retrievedIds: ['x', 'y', 'z'] }
      ],
      [1, 3]
    );

    expect(queryMetrics[0].at[1]).toMatchObject({ precision: 1, recall: 0.5, hits: 1 });
    expect(queryMetrics[0].at[3]).toMatchObject({ precision: 2 / 3, recall: 1, hits: 2 });
    expect(queryMetrics[0].at[1].ndcg).toBe(1);
    expect(queryMetrics[0].at[3].ndcg).toBeCloseTo(0.91972, 4);
    expect(queryMetrics[1].at[1]).toMatchObject({ precision: 0, recall: 0, hits: 0 });
    expect(queryMetrics[1].at[3]).toMatchObject({ precision: 0, recall: 0, hits: 0 });

    const summary = summarizeReplayMetrics(queryMetrics, [1, 3]);
    expect(summary).toMatchObject({
      queryCount: 2,
      precisionAtK: { 1: 0.5, 3: 1 / 3 },
      recallAtK: { 1: 0.25, 3: 0.5 }
    });
    expect(summary.ndcgAtK[1]).toBe(0.5);
    expect(summary.ndcgAtK[3]).toBeCloseTo(0.45986, 4);
  });

  it('computes graded nDCG@k from qrels relevance labels', () => {
    const [queryMetrics] = computePrecisionRecallAtK(
      [
        {
          queryId: 'q-graded',
          expectedIds: ['a', 'b'],
          expectedRelevance: { a: 3, b: 1 },
          retrievedIds: ['b', 'a', 'noise']
        }
      ],
      [2]
    );

    expect(queryMetrics.at[2]).toMatchObject({ precision: 1, recall: 1, hits: 2 });
    expect(queryMetrics.at[2].ndcg).toBeCloseTo(0.70981, 4);
  });

  it('deduplicates retrieved ids so replay metrics cannot over-count repeated hits', () => {
    const queryMetrics = computePrecisionRecallAtK(
      [
        { queryId: 'q-duplicate', expectedIds: ['a'], retrievedIds: ['a', 'a', 'a', 'x'] }
      ],
      [1, 3]
    );

    expect(queryMetrics).toEqual([
      {
        queryId: 'q-duplicate',
        at: {
          1: { precision: 1, recall: 1, hits: 1, ndcg: 1 },
          3: { precision: 1 / 3, recall: 1, hits: 1, ndcg: 1 }
        }
      }
    ]);
    expect(queryMetrics[0].at[3].ndcg).toBe(1);
  });

  it('normalizes k values without losing zero-result replay rows', () => {
    const queryMetrics = computePrecisionRecallAtK(
      [{ queryId: 'q-empty', expectedIds: ['a'], retrievedIds: [] }],
      [3.9, 1, 1, -2]
    );

    expect(queryMetrics).toEqual([
      {
        queryId: 'q-empty',
        at: {
          0: { precision: 0, recall: 0, hits: 0, ndcg: 0 },
          1: { precision: 0, recall: 0, hits: 0, ndcg: 0 },
          3: { precision: 0, recall: 0, hits: 0, ndcg: 0 }
        }
      }
    ]);

    expect(summarizeReplayMetrics(queryMetrics, [3.9, 1, 1, -2])).toEqual({
      queryCount: 1,
      precisionAtK: { 0: 0, 1: 0, 3: 0 },
      recallAtK: { 0: 0, 1: 0, 3: 0 },
      ndcgAtK: { 0: 0, 1: 0, 3: 0 }
    });
  });
});
