import { describe, expect, it } from 'vitest';

import {
  formatBackfillVectorsResult,
  resolveBackfillVectorsOptions
} from '../../src/apps/cli/backfill-vectors-command.js';

describe('repair backfill-vectors options', () => {
  it('previews by default, for the current directory', () => {
    expect(resolveBackfillVectorsOptions({}, '/repo/app')).toEqual({ projectPath: '/repo/app', dryRun: true });
  });

  it('writes only with --apply', () => {
    expect(resolveBackfillVectorsOptions({ project: '/repo/other', apply: true }, '/repo/app'))
      .toEqual({ projectPath: '/repo/other', dryRun: false });
  });

  it('rejects an empty project path', () => {
    expect(() => resolveBackfillVectorsOptions({ project: ' ' })).toThrow('--project must not be empty');
  });
});

describe('repair backfill-vectors report', () => {
  const result = { embeddable: 20429, searchable: 944, adopted: 19485, queued: 3, alreadyQueued: 0 };

  it('says how much of the store search reaches and what a run would change', () => {
    expect(formatBackfillVectorsResult({ dryRun: true, ...result })).toBe([
      'Backfill searchable vectors',
      'Mode: dry-run',
      'Events worth searching: 20429',
      'Searchable now: 944 (4.6%)',
      'Would copy from an unread vector table: 19485',
      'Would queue for embedding: 3',
      'Already queued for embedding: 0',
      'Dry-run only. Re-run with --apply to write these vectors.'
    ].join('\n'));
  });

  it('reports what an applied run did and what is left to the embedding worker', () => {
    expect(formatBackfillVectorsResult({ dryRun: false, ...result })).toBe([
      'Backfill searchable vectors',
      'Mode: apply',
      'Events worth searching: 20429',
      'Searchable before: 944 (4.6%)',
      'Copied from an unread vector table: 19485',
      'Queued for embedding: 3',
      'Already queued for embedding: 0',
      'Searchable now: 20429 (100.0%)',
      'Queued events become searchable once embedded: claude-memory-layer process'
    ].join('\n'));
  });

  it('does not divide by zero on an empty store', () => {
    expect(formatBackfillVectorsResult({ dryRun: true, embeddable: 0, searchable: 0, adopted: 0, queued: 0, alreadyQueued: 0 }))
      .toContain('Searchable now: 0 (100.0%)');
  });
});
