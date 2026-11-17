import { describe, expect, it } from 'vitest';

import { summarizeLanes, summarizeLongMemEval } from '../../benchmarks/public/run.js';

describe('benchmark:public summaries', () => {
  it('keeps the LongMemEval analysis scalars at four decimals and drops per-category rows', () => {
    const report = {
      fixtureStats: { memoryCount: 22419 },
      longMemEvalAnalysis: {
        k: 10, queryCount: 470, recallAnyAtK: 0.7553191489361702, recallAllAtK: 0.48936170212765956,
        fractionalRecallAtK: 0.625, ndcgAtK: 0.5559992586505385, mrr: 0.6094098277608916, byCategory: [{ category: 'x' }]
      }
    };

    expect(summarizeLongMemEval(report)).toEqual({
      k: 10, queryCount: 470, memoryCount: 22419, recallAnyAtK: 0.7553, recallAllAtK: 0.4894,
      fractionalRecallAtK: 0.625, ndcgAtK: 0.556, mrr: 0.6094
    });
  });

  it('reports each lane at k=10 and at current budget with confidence intervals kept as arrays', () => {
    const arm = (recall: number) => ({ recallAtK: { 10: recall }, ndcgAtK: { 10: 0.5 }, hitAtK: { 10: 1 }, mrr: 0.25 });
    const report = {
      queries: 2, memories: 9, rerunMaxAbsDelta: 0, models: { embedder: { model: 'e5' } },
      pipeline: { arms: { current: arm(0.6), keyword: arm(0.4) } },
      pipelineAtBudget: { arms: { current: { recall: 0.6, ndcg: 0.8 }, keyword: { recall: 0.4, ndcg: 0.5, vsBaseline: { recall: { mean: -0.2, ci: [-0.35123, -0.05] } } } } }
    };

    expect(summarizeLanes(report)).toEqual({
      queries: 2, memories: 9, rerunMaxAbsDelta: 0, embedder: { model: 'e5' },
      at10: { current: { recall: 0.6, ndcg: 0.5, hit: 1, mrr: 0.25 }, keyword: { recall: 0.4, ndcg: 0.5, hit: 1, mrr: 0.25 } },
      atBudget: {
        current: { recall: 0.6, ndcg: 0.8 },
        keyword: { recall: 0.4, ndcg: 0.5, vsCurrent: { recall: { mean: -0.2, ci: [-0.3512, -0.05] } } }
      }
    });
  });
});
