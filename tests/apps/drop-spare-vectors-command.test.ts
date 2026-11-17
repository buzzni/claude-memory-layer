import { describe, expect, it } from 'vitest';

import {
  formatDropSpareVectorsResult,
  resolveDropSpareVectorsOptions
} from '../../src/apps/cli/drop-spare-vectors-command.js';

describe('repair drop-spare-vectors options', () => {
  it('previews by default and writes only with --apply', () => {
    expect(resolveDropSpareVectorsOptions({}, '/repo/app')).toEqual({ projectPath: '/repo/app', dryRun: true });
    expect(resolveDropSpareVectorsOptions({ project: '/repo/b', apply: true })).toEqual({ projectPath: '/repo/b', dryRun: false });
    expect(() => resolveDropSpareVectorsOptions({ project: '' })).toThrow('--project must not be empty');
  });
});

describe('repair drop-spare-vectors report', () => {
  const tables = [{ name: 'event_vectors_v1', rows: 20111 }];

  it('previews the tables it would drop', () => {
    expect(formatDropSpareVectorsResult({ dryRun: true, embeddable: 20434, searchable: 20433, queued: 1, refused: null, tables, dropped: [] })).toBe([
      'Drop spare event vector tables',
      'Mode: dry-run',
      'Searchable: 20433 of 20434 events (1 waiting for embedding)',
      'Would drop: event_vectors_v1 (20111 rows)',
      'Dry-run only. Re-run with --apply to drop these tables. This cannot be undone.'
    ].join('\n'));
  });

  it('reports what was dropped', () => {
    expect(formatDropSpareVectorsResult({ dryRun: false, embeddable: 20434, searchable: 20434, queued: 0, refused: null, tables, dropped: ['event_vectors_v1'] })).toBe([
      'Drop spare event vector tables',
      'Mode: apply',
      'Searchable: 20434 of 20434 events',
      'Dropped: event_vectors_v1 (20111 rows)'
    ].join('\n'));
  });

  it('explains a refusal and how to clear it', () => {
    expect(formatDropSpareVectorsResult({ dryRun: false, embeddable: 20434, searchable: 949, queued: 0, refused: 'incomplete-coverage', tables, dropped: [] })).toBe([
      'Drop spare event vector tables',
      'Mode: apply',
      'Searchable: 949 of 20434 events',
      'Refused: some events are neither searchable nor waiting for embedding, and a spare table may hold their only vector.',
      'Run claude-memory-layer repair backfill-vectors --apply first.'
    ].join('\n'));
  });

  it('says when there is nothing to drop', () => {
    expect(formatDropSpareVectorsResult({ dryRun: true, embeddable: 5, searchable: 5, queued: 0, refused: null, tables: [], dropped: [] }))
      .toContain('No spare event vector tables.');
  });
});
