import { describe, expect, it } from 'vitest';

import {
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

  it('previews what it would hide', () => {
    expect(formatSupersedeSessionSummariesResult({ dryRun: true, sessions: 3, superseded: 4, samples })).toBe([
      'Supersede duplicate session summaries',
      'Mode: dry-run',
      'Sessions with 2+ visible summaries: 3',
      'Would hide: 4 summaries (each session keeps its newest LLM summary, else its newest)',
      '  s1: keep e3, hide e2, e1',
      '  ... and 2 more sessions',
      'Dry-run only. Re-run with --apply to hide them. Rows are quarantined as superseded, not deleted.'
    ].join('\n'));
  });

  it('reports what it hid', () => {
    expect(formatSupersedeSessionSummariesResult({ dryRun: false, sessions: 1, superseded: 2, samples })).toBe([
      'Supersede duplicate session summaries',
      'Mode: apply',
      'Sessions with 2+ visible summaries: 1',
      'Hidden: 2 summaries (each session keeps its newest LLM summary, else its newest)',
      '  s1: keep e3, hide e2, e1',
      'Rows are quarantined as superseded, not deleted; each has a governance audit row.'
    ].join('\n'));
  });

  it('says so when there is nothing to hide', () => {
    expect(formatSupersedeSessionSummariesResult({ dryRun: true, sessions: 0, superseded: 0, samples: [] })).toBe([
      'Supersede duplicate session summaries',
      'Mode: dry-run',
      'No session holds more than one visible summary.'
    ].join('\n'));
  });
});
