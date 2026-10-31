import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  findIdentifiers,
  identifierExcerptEnabled,
  identifierWindowStart,
  keepCodeBlockIdentifiers
} from '../../src/core/identifier-excerpt.js';

const values = (text: string) => findIdentifiers(text).map((span) => span.value);

describe('findIdentifiers', () => {
  it('finds file paths, PR and issue numbers, commit SHAs, branch names, and versions', () => {
    expect(values(
      'Edited src/core/memory-reference-context.ts:33 and package.json on feat/identifier-anchored-excerpts '
      + '(rebased on origin/main), commit 1faa18a for PR #116, then shipped v2.4.17 after 2.4.16.'
    )).toEqual([
      'src/core/memory-reference-context.ts:33',
      'package.json',
      'feat/identifier-anchored-excerpts',
      'origin/main',
      '1faa18a',
      '#116',
      'v2.4.17',
      '2.4.16'
    ]);
  });

  it('counts a number written after PR or issue as a reference', () => {
    expect(values('PR 167 리뷰와 issue 42 정리')).toEqual(['167', '42']);
  });

  it('strips Korean particles and markdown around an identifier', () => {
    expect(values('**src/a.ts**를 고치고 `#122`에서 `docs/x/y`로 옮겼다')).toEqual(['src/a.ts', '#122', 'docs/x/y']);
  });

  it('reports where each identifier sits in the text', () => {
    const text = 'see #12 now';
    expect(findIdentifiers(text)).toEqual([{ value: '#12', start: 4, end: 7 }]);
  });

  it('ignores prose that only looks path- or hash-like', () => {
    expect(values('A/B test, and/or src/core, /role-context, 2026, 1234567, deadbeef, e.g. v2')).toEqual([]);
  });
});

describe('identifierWindowStart', () => {
  const prose = 'The worker kept running and nothing unusual showed up in the logs. ';

  it('keeps the head when the text fits the budget', () => {
    expect(identifierWindowStart(`short #1 #2`, 400)).toBe(0);
  });

  it('keeps the head when the text has no identifiers', () => {
    expect(identifierWindowStart(prose.repeat(20), 200)).toBe(0);
  });

  it('keeps the head when no later window holds more identifiers', () => {
    const text = `Fixed #1 in src/a.ts. ${prose.repeat(10)}Also see #2.`;
    expect(identifierWindowStart(text, 200)).toBe(0);
  });

  it('moves to the window where identifiers cluster, starting at a sentence boundary', () => {
    const tail = 'Fixed in src/core/mongo-sync-worker.ts (commit b107516, PR #116, v2.4.17).';
    const text = `${prose.repeat(10)}${tail}`;
    const start = identifierWindowStart(text, 200);

    expect(start).toBeGreaterThan(0);
    expect(text.slice(start)).toBe(tail);
  });

  it('counts a repeated identifier once', () => {
    const repeated = '#5 #5 #5 #5 #5. ';
    const distinct = 'Touched #7 and #8. ';
    const text = `${distinct}${prose.repeat(10)}${repeated}`;
    expect(identifierWindowStart(text, 120)).toBe(0);
  });
});

describe('keepCodeBlockIdentifiers', () => {
  it('replaces a code block with the identifiers it contained', () => {
    expect(keepCodeBlockIdentifiers('before\n```bash\ngit checkout fix/x\nvi src/a.ts\ngit show 1faa18a\n```\nafter'))
      .toBe('before\n[code: fix/x src/a.ts 1faa18a]\nafter');
  });

  it('keeps the bare marker when the block has no identifiers', () => {
    expect(keepCodeBlockIdentifiers('```\nconst x = 1;\n```')).toBe('[code]');
  });

  it('keeps at most five distinct identifiers per block', () => {
    expect(keepCodeBlockIdentifiers('```\n#1 #1 #2 #3 #4 #5 #6\n```')).toBe('[code: #1 #2 #3 #4 #5]');
  });
});

describe('identifierExcerptEnabled', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it.each([[undefined, false], ['', false], ['1', false], ['TRUE', false], ['true', true]])(
    'is %j -> %j',
    (value, expected) => {
      vi.stubEnv('CLAUDE_MEMORY_IDENTIFIER_EXCERPT_EXPERIMENT', value);
      expect(identifierExcerptEnabled()).toBe(expected);
    }
  );
});
