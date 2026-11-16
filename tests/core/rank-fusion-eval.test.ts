import { describe, expect, it } from 'vitest';

import { latencySummary, pairedBootstrap, summarizeRankArms, truncateToBaseline } from '../../src/core/rank-fusion-eval.js';

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

describe('truncateToBaseline', () => {
  it('cuts every arm to the number of ids the baseline returned for that query', () => {
    expect(truncateToBaseline([
      { current: ['m1'], rrf: ['m2', 'm1'] },
      { current: [], rrf: ['m3'] }
    ], 'current')).toEqual([
      { current: ['m1'], rrf: ['m2'] },
      { current: [], rrf: [] }
    ]);
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
