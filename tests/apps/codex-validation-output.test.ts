import { describe, expect, it } from 'vitest';

import { formatCodexValidationReport } from '../../src/apps/cli/codex-validation-output.js';
import type { CodexSessionValidationReport } from '../../src/services/codex-session-history-importer.js';

function makeReport(): CodexSessionValidationReport {
  return {
    generatedAt: '2026-05-05T12:00:00.000Z',
    dryRun: true,
    willMutate: false,
    source: {
      sessionsDir: '/tmp/codex-sessions',
      projectPath: '/tmp/project-a',
      projectFilterApplied: true,
      sourcePaths: ['/tmp/codex-sessions']
    },
    limits: {
      sessionLimit: 10,
      maxContentChars: 10_000
    },
    totals: {
      sessionsScanned: 3,
      sessionsMatched: 2,
      filesRead: 2,
      recordsRead: 9,
      messagesNormalized: 4,
      turnsNormalized: 2,
      userMessages: 2,
      assistantMessages: 2,
      malformedLines: 1,
      skippedUnsupportedRecords: 2,
      emptyAssistantMessages: 1,
      truncatedMessages: 1,
      missingProjectCwd: 1,
      warnings: 2
    },
    topProjects: [
      {
        projectHash: 'abc12345',
        pathLabel: '/tmp/project-a',
        sessions: 2,
        messagesNormalized: 4,
        turnsNormalized: 2,
        userMessages: 2,
        assistantMessages: 2,
        malformedLines: 1,
        skippedUnsupportedRecords: 2,
        truncatedMessages: 1,
        emptyAssistantMessages: 1
      }
    ],
    sessions: [
      {
        sessionId: 'session-a',
        filePath: '/tmp/codex-sessions/session-a.jsonl',
        projectHash: 'abc12345',
        pathLabel: '/tmp/project-a',
        matched: true,
        recordsRead: 9,
        messagesNormalized: 4,
        turnsNormalized: 2,
        userMessages: 2,
        assistantMessages: 2,
        malformedLines: 1,
        skippedUnsupportedRecords: 2,
        emptyAssistantMessages: 1,
        truncatedMessages: 1,
        missingProjectCwd: false,
        warnings: ['sample warning']
      }
    ],
    warnings: ['1 session(s) missing cwd', '1 malformed JSONL line(s) skipped']
  };
}

describe('Codex validation CLI output helpers', () => {
  it('formats JSON reports without transcript text', () => {
    const json = formatCodexValidationReport(makeReport(), 'json');
    const parsed = JSON.parse(json) as CodexSessionValidationReport;

    expect(parsed.dryRun).toBe(true);
    expect(parsed.willMutate).toBe(false);
    expect(parsed.totals.sessionsScanned).toBe(3);
    expect(json).not.toContain('please implement');
    expect(json).not.toContain('assistant response');
  });

  it('formats markdown totals, top projects, and safety status', () => {
    const markdown = formatCodexValidationReport(makeReport(), 'markdown');

    expect(markdown).toContain('# Codex dry-run validation report');
    expect(markdown).toContain('Dry-run: yes');
    expect(markdown).toContain('Sessions scanned: 3');
    expect(markdown).toContain('Sessions matched: 2');
    expect(markdown).toContain('Malformed lines: 1');
    expect(markdown).toContain('Skipped/unsupported records: 2');
    expect(markdown).toContain('abc12345');
    expect(markdown).toContain('/tmp/project-a');
  });
});
