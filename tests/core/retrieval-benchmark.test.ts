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

    expect(queryMetrics).toEqual([
      {
        queryId: 'q1',
        at: {
          1: { precision: 1, recall: 0.5, hits: 1 },
          3: { precision: 2 / 3, recall: 1, hits: 2 }
        }
      },
      {
        queryId: 'q2',
        at: {
          1: { precision: 0, recall: 0, hits: 0 },
          3: { precision: 0, recall: 0, hits: 0 }
        }
      }
    ]);

    expect(summarizeReplayMetrics(queryMetrics, [1, 3])).toEqual({
      queryCount: 2,
      precisionAtK: { 1: 0.5, 3: 1 / 3 },
      recallAtK: { 1: 0.25, 3: 0.5 }
    });
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
          1: { precision: 1, recall: 1, hits: 1 },
          3: { precision: 1 / 3, recall: 1, hits: 1 }
        }
      }
    ]);
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
          0: { precision: 0, recall: 0, hits: 0 },
          1: { precision: 0, recall: 0, hits: 0 },
          3: { precision: 0, recall: 0, hits: 0 }
        }
      }
    ]);

    expect(summarizeReplayMetrics(queryMetrics, [3.9, 1, 1, -2])).toEqual({
      queryCount: 1,
      precisionAtK: { 0: 0, 1: 0, 3: 0 },
      recallAtK: { 0: 0, 1: 0, 3: 0 }
    });
  });
});
