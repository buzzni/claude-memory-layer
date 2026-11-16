import { describe, expect, it } from 'vitest';

import { describeLessonExtraction } from '../../src/extensions/mcp/handlers.js';

const stats = (overrides = {}) => ({
  cacheHits: 0,
  freshAttempts: 0,
  failures: 0,
  noLesson: 0,
  skippedNoExtractor: 0,
  skippedByBudget: 0,
  ...overrides
});

describe('describeLessonExtraction', () => {
  it('counts calls the open provider circuit skipped apart from attempts and failures', () => {
    const result = describeLessonExtraction(0, stats({ freshAttempts: 5, failures: 4 }), 3, {
      reason: 'provider-rate-limit',
      nextProbeAt: '2026-01-01T00:05:00.000Z'
    });
    expect(result.extraction).toMatchObject({ freshAttempts: 2, failures: 1, skippedByCircuit: 3 });
    expect(result.note).toBe(
      'The lesson provider circuit is open (provider-rate-limit): 3 group(s) were skipped without calling the provider, '
      + 'and nothing was cached. Call again after the next probe at 2026-01-01T00:05:00.000Z.'
    );
  });

  it('still names the skips when the circuit closed in the meantime', () => {
    expect(describeLessonExtraction(0, stats({ freshAttempts: 1, failures: 1 }), 1, null).note)
      .toContain('1 group(s) were skipped without calling the provider');
  });

  it('keeps the provider-unavailable note for real failures', () => {
    const result = describeLessonExtraction(0, stats({ freshAttempts: 2, failures: 2 }), 0, null);
    expect(result.extraction).toMatchObject({ freshAttempts: 2, failures: 2, skippedByCircuit: 0 });
    expect(result.note).toMatch(/^Extraction failed for every uncached group/);
  });

  it('keeps the plain note when nothing failed', () => {
    expect(describeLessonExtraction(2, stats({ freshAttempts: 2 }), 0, null).note)
      .toBe('Read-only detection. Review a candidate and call mem-lesson-save to promote it into a curated lesson.');
  });
});
