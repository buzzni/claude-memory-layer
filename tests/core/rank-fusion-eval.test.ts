import { describe, expect, it } from 'vitest';

import { latencySummary, pairedBootstrap, summarizeAtBaselineBudget, summarizeRankArms } from '../../src/core/rank-fusion-eval.js';

const queries = [
  { queryId: 'q1', expectedIds: ['m1'] },
  { queryId: 'q2', expectedIds: ['m2', 'm3'] }
];

describe('summarizeRankArms', () => {
  it('scores every arm with recall, nDCG, hit and MRR at each k', () => {
    const summary = summarizeRankArms(queries, [
      { current: ['m9', 'm1'], rrf: ['m1', 'm9'] },
      { current: ['m2'], rrf: ['m3', 'm2'] }
    ], { ks: [1, 2], baseline: 'current' });

    expect(summary.queryCount).toBe(2);
    expect(summary.arms.current.recallAtK[1]).toBeCloseTo((0 + 0.5) / 2);
    expect(summary.arms.current.hitAtK[2]).toBe(1);
    expect(summary.arms.current.mrr).toBeCloseTo((0.5 + 1) / 2);
    expect(summary.arms.rrf.recallAtK[2]).toBe(1);
    expect(summary.arms.rrf.ndcgAtK[2]).toBe(1);
    expect(summary.arms.rrf.mrr).toBe(1);
  });

  it('reports the paired difference against the baseline with a bootstrap interval', () => {
    const summary = summarizeRankArms(queries, [
      { current: ['m9', 'm1'], rrf: ['m1', 'm9'] },
      { current: ['m2'], rrf: ['m3', 'm2'] }
    ], { ks: [2], baseline: 'current', bootstrapSamples: 200 });

    const diff = summary.arms.rrf.vsBaseline!.recallAtK[2];
    expect(diff.mean).toBeCloseTo((0 + 0.5) / 2);
    expect(diff.ci[0]).toBeGreaterThanOrEqual(0);
    expect(diff.ci[1]).toBeLessThanOrEqual(0.5);
    expect(summary.arms.current.vsBaseline).toBeUndefined();
  });

  it('gives the same interval on every run', () => {
    const runs = [{ current: ['m1'], rrf: ['m9'] }, { current: ['m9'], rrf: ['m2'] }];
    const first = summarizeRankArms(queries, runs, { ks: [1], baseline: 'current' });
    const second = summarizeRankArms(queries, runs, { ks: [1], baseline: 'current' });
    expect(second.arms.rrf.vsBaseline).toEqual(first.arms.rrf.vsBaseline);
  });

  it('rejects runs that do not cover every query or the baseline', () => {
    expect(() => summarizeRankArms(queries, [{ current: [] }], { ks: [1], baseline: 'current' })).toThrow(/2 queries but 1 runs/);
    expect(() => summarizeRankArms(queries, [{ rrf: [] }, { rrf: [] }], { ks: [1], baseline: 'current' })).toThrow(/baseline arm current/);
  });
});

describe('summarizeAtBaselineBudget', () => {
  it("scores every arm at the baseline's list length for each query, with nDCG normalized at that k", () => {
    const summary = summarizeAtBaselineBudget([
      { queryId: 'q1', expectedIds: ['m1', 'm2'] },
      { queryId: 'q2', expectedIds: ['m3'] },
      { queryId: 'q3', expectedIds: ['m4'] }
    ], [
      { current: ['m1'], rrf: ['m9', 'm1'] },
      { current: ['m9', 'm3'], rrf: ['m3', 'm9'] },
      { current: [], rrf: ['m4'] }
    ], { baseline: 'current', bootstrapSamples: 100 });

    // q3 has no budget: the baseline abstained, so nothing is ranked there.
    expect(summary.queryCount).toBe(2);
    expect(summary.emptyBaseline).toBe(1);
    // q1 at k=1: current finds 1 of 2 with ideal DCG over one slot (nDCG 1); rrf's slot is a miss.
    // q2 at k=2: current has the hit at rank 2, rrf at rank 1.
    expect(summary.arms.current.recall).toBeCloseTo((0.5 + 1) / 2);
    expect(summary.arms.current.ndcg).toBeCloseTo((1 + 1 / Math.log2(3)) / 2);
    expect(summary.arms.rrf.recall).toBeCloseTo((0 + 1) / 2);
    expect(summary.arms.rrf.ndcg).toBeCloseTo((0 + 1) / 2);
    expect(summary.arms.rrf.vsBaseline!.recall.mean).toBeCloseTo(-0.25);
    expect(summary.arms.current.vsBaseline).toBeUndefined();
  });
});

describe('pairedBootstrap', () => {
  it('brackets the mean difference and collapses to it when every difference is equal', () => {
    expect(pairedBootstrap([0.2, 0.2, 0.2], 100)).toEqual({ mean: expect.closeTo(0.2), ci: [expect.closeTo(0.2), expect.closeTo(0.2)] });
    const spread = pairedBootstrap([-0.1, 0, 0.1, 0.3], 500);
    expect(spread.ci[0]).toBeLessThanOrEqual(spread.mean);
    expect(spread.ci[1]).toBeGreaterThanOrEqual(spread.mean);
  });
});

describe('latencySummary', () => {
  it('reports nearest-rank percentiles', () => {
    expect(latencySummary([5, 1, 4, 2, 3, 10, 6, 7, 8, 9])).toEqual({ n: 10, p50: 5, p90: 9, max: 10, mean: 5.5 });
  });

  it('is empty for no samples', () => {
    expect(latencySummary([])).toEqual({ n: 0, p50: null, p90: null, max: null, mean: null });
  });
});
