import { describe, expect, it } from 'vitest';
import { lessonRecallGate } from '../../scripts/evaluate-lesson-hybrid-heldout.js';

const passing = { recallAt3: .8, precisionAt3: .9, negativeFalseInjection: .05, identifierRetention: 1, p95Ms: 300 };

describe('held-out ranking gate', () => {
  it('accepts the specified boundaries without relaxing them', () => {
    expect(lessonRecallGate(passing)).toEqual({ passed: true, failures: [] });
  });
  it('rejects the observed held-out result despite perfect precision', () => {
    expect(lessonRecallGate({ ...passing, recallAt3: 41 / 60, precisionAt3: 1, negativeFalseInjection: 0, p95Ms: 42.8 }))
      .toEqual({ passed: false, failures: ['recallAt3'] });
  });
  it.each([
    ['recallAt3', .799], ['precisionAt3', .899], ['negativeFalseInjection', .051],
    ['identifierRetention', .99], ['p95Ms', 301],
  ])('rejects a failing %s independently', (field, value) => {
    expect(lessonRecallGate({ ...passing, [field]: value })).toEqual({ passed: false, failures: [field] });
  });
  it.each([null, undefined, NaN, Infinity, -1, '1'])('does not certify missing or invalid observations: %s', (value) => {
    expect(lessonRecallGate({ ...passing, identifierRetention: value }).passed).toBe(false);
  });
  it('rejects out-of-range rates and invalid latency', () => {
    expect(lessonRecallGate({ ...passing, recallAt3: 1.1, p95Ms: -1 })).toEqual({ passed: false, failures: ['recallAt3', 'p95Ms'] });
  });
});
