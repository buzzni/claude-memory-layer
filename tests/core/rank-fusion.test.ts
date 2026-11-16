import { describe, expect, it } from 'vitest';

import { reciprocalRankFusion, rerankHead } from '../../src/core/rank-fusion.js';

describe('reciprocalRankFusion', () => {
  it('ranks an id found by several lanes above ids found by one', () => {
    expect(reciprocalRankFusion([['a', 'b', 'c'], ['c', 'd']])).toEqual(['c', 'a', 'b', 'd']);
  });

  it('scores 1/(k + rank) per lane, so a lower k favors the top ranks more', () => {
    // a is ranked 1st and 4th, b 2nd twice. k=60: b = 2/62 beats a = 1/61 + 1/64.
    // k=0: a = 1 + 1/4 beats b = 1/2 + 1/2.
    const lanes = [['a', 'b'], ['x', 'b', 'y', 'a']];
    expect(reciprocalRankFusion(lanes)).toEqual(['b', 'a', 'x', 'y']);
    expect(reciprocalRankFusion(lanes, 0)).toEqual(['a', 'b', 'x', 'y']);
  });

  it('breaks ties by first appearance and counts a repeated id once per lane', () => {
    expect(reciprocalRankFusion([['a', 'a', 'b'], ['b', 'a']])).toEqual(['a', 'b']);
    expect(reciprocalRankFusion([['p'], ['q']])).toEqual(['p', 'q']);
  });

  it('returns nothing for no lanes or empty lanes', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });
});

describe('rerankHead', () => {
  it('reorders the scored head by score and keeps the unscored tail in place', () => {
    expect(rerankHead(['a', 'b', 'c', 'd'], [0.1, 0.9, 0.5])).toEqual(['b', 'c', 'a', 'd']);
  });

  it('keeps the input order between equal scores', () => {
    expect(rerankHead(['a', 'b', 'c'], [1, 1, 2])).toEqual(['c', 'a', 'b']);
  });

  it('rejects more scores than ids', () => {
    expect(() => rerankHead(['a'], [1, 2])).toThrow(/2 scores for 1 ids/);
  });
});
