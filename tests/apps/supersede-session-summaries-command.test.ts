import { describe, expect, it } from 'vitest';

import {
  formatSupersedeSessionSummariesFailure,
  formatSupersedeSessionSummariesResult,
  resolveSupersedeSessionSummariesOptions
} from '../../src/apps/cli/supersede-session-summaries-command.js';

describe('repair supersede-session-summaries options', () => {
  it('previews by default and writes only with --apply', () => {
    expect(resolveSupersedeSessionSummariesOptions({}, '/repo/app')).toEqual({ projectPath: '/repo/app', dryRun: true });
    expect(resolveSupersedeSessionSummariesOptions({ project: '/repo/b', apply: true })).toEqual({ projectPath: '/repo/b', dryRun: false });
    expect(() => resolveSupersedeSessionSummariesOptions({ project: '' })).toThrow('--project must not be empty');
  });
});

describe('repair supersede-session-summaries report', () => {
  const samples = [{ sessionId: 's1', keptEventId: 'e3', supersededEventIds: ['e2', 'e1'] }];
  const kinds = { keptByKind: { unlabeled: 2, llm: 1 }, supersededByKind: { 'rule-based': 3, unlabeled: 1 } };

  it('previews what it would hide', () => {
    expect(formatSupersedeSessionSummariesResult({ dryRun: true, sessions: 3, superseded: 4, ...kinds, samples })).toBe([
      'Supersede duplicate session summaries',
      'Mode: dry-run',
      'Sessions with 2+ visible summaries: 3',
      'Would hide: 4 summaries (each session keeps its newest LLM summary, else its newest)',
      'Kept by kind: llm 1, unlabeled 2',
      'Hidden by kind: rule-based 3, unlabeled 1',
      '  s1: keep e3, hide e2, e1',
      '  ... and 2 more sessions',
      'Dry-run only. Re-run with --apply to hide them. Rows are quarantined as superseded, not deleted.'
    ].join('\n'));
  });

  it('reports what it hid', () => {
    expect(formatSupersedeSessionSummariesResult({ dryRun: false, sessions: 1, superseded: 2, ...kinds, samples })).toBe([
      'Supersede duplicate session summaries',
      'Mode: apply',
      'Sessions with 2+ visible summaries: 1',
      'Hidden: 2 summaries (each session keeps its newest LLM summary, else its newest)',
      'Kept by kind: llm 1, unlabeled 2',
      'Hidden by kind: rule-based 3, unlabeled 1',
      '  s1: keep e3, hide e2, e1',
      'Rows are quarantined as superseded, not deleted; each has a governance audit row.'
    ].join('\n'));
  });

  it('says so when there is nothing to hide', () => {
    expect(formatSupersedeSessionSummariesResult({ dryRun: true, sessions: 0, superseded: 0, keptByKind: {}, supersededByKind: {}, samples: [] })).toBe([
      'Supersede duplicate session summaries',
      'Mode: dry-run',
      'No session holds more than one visible summary.'
    ].join('\n'));
  });
});

describe('repair supersede-session-summaries failure', () => {
  it('says nothing changed and to run it again', () => {
    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    expect(formatSupersedeSessionSummariesFailure(busy)).toBe([
      'Supersede session summaries failed: database is locked',
      'Nothing was changed: the summaries are hidden in one transaction, rolled back on failure. Run the command again; '
        + 'if the store was busy, run it when no session is being written.'
    ].join('\n'));
  });
});
