import { describe, expect, it } from 'vitest';

import { importExitCode } from '../../src/apps/cli/import-exit-code.js';
import { FORCE_REIMPORT_LIMIT_REFUSAL } from '../../src/services/session-history-importer.js';

/**
 * #227: a force reimport the --limit could cut short is skipped and the
 * command exits 1; one skipped because the source has nothing to read stays a
 * warning (exit 0). `import`, `codex import` and `hermes import` all end
 * through printImportSummary, which takes its exit code from importExitCode.
 * The importers' own skip decisions are covered without a process in
 * tests/services/*force-reimport* and tests/core/*validation*.
 */

const limitSkip = (source: string) => `Skipped force reimport (${FORCE_REIMPORT_LIMIT_REFUSAL}): ${source}`;
const unreadableSkip = (source: string) => `Skipped force reimport (no parseable records): ${source}`;

describe('import --force exit codes', () => {
  it('exits 0 when every session imported', () => {
    expect(importExitCode({ errors: [] })).toBe(0);
  });

  it('exits 1 when a force reimport was skipped for the message limit', () => {
    expect(importExitCode({ errors: [limitSkip('/sessions/exit-session.jsonl')] })).toBe(1);
  });

  it('exits 0 when a force reimport was skipped for having no parseable records', () => {
    expect(importExitCode({ errors: [unreadableSkip('/sessions/torn-session.jsonl')] })).toBe(0);
  });

  it('exits 0 for other import errors', () => {
    expect(importExitCode({ errors: ['File not found: /sessions/gone.jsonl', 'Failed to import /sessions/a.jsonl: boom'] })).toBe(0);
  });

  it('exits 1 when one limit skip sits among other skips and errors', () => {
    expect(importExitCode({
      errors: [
        unreadableSkip('hermes-tools'),
        'Failed to import /sessions/a.jsonl: boom',
        limitSkip('hermes-exit'),
        unreadableSkip('/sessions/torn-session.jsonl')
      ]
    })).toBe(1);
  });
});
