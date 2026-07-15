import { describe, expect, it } from 'vitest';
import {
  computeMemoryUsageEvidence,
  extractMemorySnippets
} from '../../src/core/usefulness-evidence.js';

describe('extractMemorySnippets', () => {
  it('splits memory content into meaningful line snippets', () => {
    const snippets = extractMemorySnippets(
      'The deploy port is 37777.\n\n- release script: scripts/release-npm.sh\nok'
    );
    expect(snippets).toContain('The deploy port is 37777.');
    expect(snippets).toContain('release script: scripts/release-npm.sh');
    // Too-short fragments are dropped.
    expect(snippets).not.toContain('ok');
  });

  it('deduplicates repeated lines', () => {
    const snippets = extractMemorySnippets('same fact repeated here\nsame fact repeated here');
    expect(snippets).toHaveLength(1);
  });
});

describe('computeMemoryUsageEvidence', () => {
  it('detects exact reuse of memory content in a response', () => {
    const result = computeMemoryUsageEvidence(
      'The deploy port is 37777 and the release script is scripts/release-npm.sh.',
      [{ id: 'resp-1', content: 'Sure — the deploy port is 37777 and the release script is scripts/release-npm.sh, so run that.' }]
    );

    expect(result.contentOverlapScore).toBeGreaterThan(0.6);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]).toMatchObject({
      matchType: 'exact',
      responseEventId: 'resp-1',
      similarity: 1
    });
  });

  it('detects rephrased reuse through term overlap', () => {
    const result = computeMemoryUsageEvidence(
      'Use npm publish --otp with the claude-memory-layer package after running typecheck.',
      [{ id: 'resp-2', content: 'First run typecheck, then publish the claude-memory-layer package via npm publish --otp.' }]
    );

    expect(result.contentOverlapScore).toBeGreaterThan(0.3);
    expect(result.matches[0].matchType).toBe('term-overlap');
    expect(result.matches[0].responseEventId).toBe('resp-2');
  });

  it('scores unrelated responses near zero', () => {
    const result = computeMemoryUsageEvidence(
      'The deploy port is 37777 and the release script is scripts/release-npm.sh.',
      [{ id: 'resp-3', content: 'Completely unrelated discussion about weather patterns and marine biology today.' }]
    );

    expect(result.contentOverlapScore).toBeLessThan(0.2);
    expect(result.matches).toHaveLength(0);
  });

  it('handles Korean content via character bigrams', () => {
    const result = computeMemoryUsageEvidence(
      '배포 포트는 37777이고 릴리즈 스크립트는 release-npm.sh 입니다.',
      [{ id: 'resp-4', content: '네, 배포 포트는 37777이고 릴리즈 스크립트는 release-npm.sh 입니다. 실행할게요.' }]
    );

    expect(result.contentOverlapScore).toBeGreaterThan(0.5);
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it('returns empty evidence when there are no responses', () => {
    const result = computeMemoryUsageEvidence('some memory content here', []);
    expect(result).toEqual({ contentOverlapScore: 0, coverage: 0, matches: [] });
  });

  it('does not treat a shared markdown heading as grounding evidence', () => {
    const result = computeMemoryUsageEvidence(
      '## Configuration',
      [{ id: 'resp-h', content: 'You can change the configuration in the settings file.' }]
    );

    expect(result.contentOverlapScore).toBe(0);
    expect(result.matches).toHaveLength(0);
  });

  it('ignores snippets with too few informative tokens', () => {
    // "the configuration" carries a single informative token — matching it
    // in an answer proves nothing about memory reuse.
    const result = computeMemoryUsageEvidence(
      'the configuration',
      [{ id: 'resp-t', content: 'Update the configuration now.' }]
    );

    expect(result.contentOverlapScore).toBe(0);
    expect(result.matches).toHaveLength(0);
  });

  it('skips heading lines but still matches factual lines below them', () => {
    const result = computeMemoryUsageEvidence(
      '## Deploy\nThe deploy port is 37777 and the release script is scripts/release-npm.sh.',
      [{ id: 'resp-d', content: 'Deploy info: the deploy port is 37777 and the release script is scripts/release-npm.sh.' }]
    );

    expect(result.contentOverlapScore).toBeGreaterThan(0.6);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].memorySnippet).toContain('deploy port');
  });
});
