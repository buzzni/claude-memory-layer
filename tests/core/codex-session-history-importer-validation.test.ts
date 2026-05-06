import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCodexSessionHistoryImporter, validateCodexSessions } from '../../src/services/codex-session-history-importer.js';

const tempDirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cml-codex-validation-'));
  tempDirs.push(dir);
  return dir;
}

function writeJsonl(filePath: string, records: Array<string | Record<string, unknown>>) {
  writeFileSync(
    filePath,
    records.map((record) => typeof record === 'string' ? record : JSON.stringify(record)).join('\n') + '\n',
    'utf8'
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Codex session validation replay', () => {
  it('dry-runs matching sessions by cwd without exposing transcript content', async () => {
    const sessionsDir = tempDir();
    const projectA = join(sessionsDir, 'project-a');
    const projectB = join(sessionsDir, 'project-b');

    writeJsonl(join(sessionsDir, 'rollout-2026-05-05T00-00-00-session-a.jsonl'), [
      { type: 'session_meta', payload: { id: 'session-a', cwd: projectA, timestamp: '2026-05-05T00:00:00.000Z' } },
      { type: 'response_item', timestamp: '2026-05-05T00:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'please implement the Codex validation replay flow' }] } },
      { type: 'response_item', timestamp: '2026-05-05T00:00:02.000Z', payload: { type: 'function_call', name: 'shell', arguments: '{}' } },
      { type: 'response_item', timestamp: '2026-05-05T00:00:03.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'validated answer that should never appear in aggregate reports' }] } },
      { type: 'response_item', timestamp: '2026-05-05T00:00:04.000Z', payload: { type: 'message', role: 'assistant', content: [] } },
      '{not valid json'
    ]);

    writeJsonl(join(sessionsDir, 'rollout-2026-05-05T00-00-00-session-b.jsonl'), [
      { type: 'session_meta', payload: { id: 'session-b', cwd: projectB } },
      { type: 'response_item', timestamp: '2026-05-05T00:01:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'this should not match project a' }] } }
    ]);

    writeJsonl(join(sessionsDir, 'rollout-2026-05-05T00-00-00-session-missing-cwd.jsonl'), [
      { type: 'session_meta', payload: { id: 'session-missing-cwd' } },
      { type: 'response_item', timestamp: '2026-05-05T00:02:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'missing cwd should be scanned but not project matched' }] } }
    ]);

    const report = await validateCodexSessions({ sessionsDir, projectPath: projectA });

    expect(report.dryRun).toBe(true);
    expect(report.willMutate).toBe(false);
    expect(report.source.sessionsDir).toBe(sessionsDir);
    expect(report.source.projectPath).toBe(projectA);
    expect(report.totals.sessionsScanned).toBe(3);
    expect(report.totals.sessionsMatched).toBe(1);
    expect(report.totals.userMessages).toBe(1);
    expect(report.totals.assistantMessages).toBe(1);
    expect(report.totals.messagesNormalized).toBe(2);
    expect(report.totals.turnsNormalized).toBe(1);
    expect(report.totals.skippedUnsupportedRecords).toBe(1);
    expect(report.totals.emptyAssistantMessages).toBe(1);
    expect(report.totals.malformedLines).toBe(1);
    expect(report.totals.missingProjectCwd).toBe(1);
    expect(report.topProjects[0]).toMatchObject({ sessions: 1, userMessages: 1, assistantMessages: 1 });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('please implement the Codex validation replay flow');
    expect(serialized).not.toContain('validated answer that should never appear');
    expect(serialized).not.toContain('this should not match project a');
  });

  it('summarizes all sessions and counts malformed, unsupported, empty, and truncated content', async () => {
    const sessionsDir = tempDir();
    const projectA = join(sessionsDir, 'project-a');
    const largeAssistantContent = 'A'.repeat(12_050);

    writeJsonl(join(sessionsDir, 'rollout-2026-05-05T00-00-00-session-a.jsonl'), [
      { type: 'session_meta', payload: { id: 'session-a', cwd: projectA } },
      { type: 'response_item', timestamp: '2026-05-05T00:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'normalize all Codex sessions' }] } },
      { type: 'response_item', timestamp: '2026-05-05T00:00:02.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: largeAssistantContent }] } },
      { type: 'response_item', timestamp: '2026-05-05T00:00:03.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }] } },
      { type: 'response_item', timestamp: '2026-05-05T00:00:04.000Z', payload: { type: 'reasoning', summary: [] } },
      'not-json'
    ]);

    writeJsonl(join(sessionsDir, 'rollout-2026-05-05T00-00-00-session-unknown.jsonl'), [
      { type: 'session_meta', payload: { id: 'session-unknown' } },
      { type: 'response_item', timestamp: '2026-05-05T00:01:01.000Z', payload: { type: 'message', role: 'user', content: 'string content from real-world Codex JSONL' } }
    ]);

    const report = await validateCodexSessions({ sessionsDir, maxContentChars: 10_000 });

    expect(report.totals.sessionsScanned).toBe(2);
    expect(report.totals.sessionsMatched).toBe(2);
    expect(report.totals.userMessages).toBe(2);
    expect(report.totals.assistantMessages).toBe(1);
    expect(report.totals.messagesNormalized).toBe(3);
    expect(report.totals.turnsNormalized).toBe(2);
    expect(report.totals.truncatedMessages).toBe(1);
    expect(report.totals.emptyAssistantMessages).toBe(1);
    expect(report.totals.skippedUnsupportedRecords).toBe(1);
    expect(report.totals.malformedLines).toBe(1);
    expect(report.totals.missingProjectCwd).toBe(1);
    expect(report.topProjects).toHaveLength(2);
    expect(report.warnings.some((warning) => warning.includes('missing cwd'))).toBe(true);
  });

  it('imports only the most recently modified matching Codex session when sessionLimit is set', async () => {
    const sessionsDir = tempDir();
    const projectA = join(sessionsDir, 'project-a');
    const oldFile = join(sessionsDir, 'rollout-2026-05-05T00-00-00-session-old.jsonl');
    const latestFile = join(sessionsDir, 'rollout-2026-05-05T00-10-00-session-latest.jsonl');

    writeJsonl(oldFile, [
      { type: 'session_meta', payload: { id: 'session-old', cwd: projectA } },
      { type: 'response_item', timestamp: '2026-05-05T00:00:01.000Z', payload: { type: 'message', role: 'user', content: 'old Codex project session should not be imported now' } }
    ]);
    writeJsonl(latestFile, [
      { type: 'session_meta', payload: { id: 'session-latest', cwd: projectA } },
      { type: 'response_item', timestamp: '2026-05-05T00:10:01.000Z', payload: { type: 'message', role: 'user', content: 'latest Codex project session should be imported now' } }
    ]);
    utimesSync(oldFile, new Date('2026-05-05T00:00:00.000Z'), new Date('2026-05-05T00:00:00.000Z'));
    utimesSync(latestFile, new Date('2026-05-05T00:10:00.000Z'), new Date('2026-05-05T00:10:00.000Z'));

    const memoryService = {
      startSession: vi.fn(async (_sessionId: string, _projectPath?: string) => undefined),
      endSession: vi.fn(async (_sessionId: string) => undefined),
      deleteSessionEvents: vi.fn(async (_sessionId: string) => 0),
      storeUserPrompt: vi.fn(async () => ({ success: true, isDuplicate: false })),
      storeAgentResponse: vi.fn(async () => ({ success: true, isDuplicate: false }))
    };
    const importer = createCodexSessionHistoryImporter(memoryService as never, { sessionsDir });

    const result = await importer.importProject(projectA, { sessionLimit: 1 });

    expect(result.totalSessions).toBe(1);
    expect(memoryService.startSession).toHaveBeenCalledTimes(1);
    expect(memoryService.startSession).toHaveBeenCalledWith('session-latest', projectA);
    expect(memoryService.storeUserPrompt).toHaveBeenCalledTimes(1);
  });

  it('applies Codex import limit across selected matching sessions', async () => {
    const sessionsDir = tempDir();
    const projectA = join(sessionsDir, 'project-a');
    const oldFile = join(sessionsDir, 'rollout-2026-05-05T00-00-00-session-old.jsonl');
    const latestFile = join(sessionsDir, 'rollout-2026-05-05T00-10-00-session-latest.jsonl');

    writeJsonl(oldFile, [
      { type: 'session_meta', payload: { id: 'session-old', cwd: projectA } },
      { type: 'response_item', timestamp: '2026-05-05T00:00:01.000Z', payload: { type: 'message', role: 'user', content: 'old prompt should remain outside the global Codex import limit' } },
      { type: 'response_item', timestamp: '2026-05-05T00:00:02.000Z', payload: { type: 'message', role: 'assistant', content: 'old assistant should remain outside the global Codex import limit' } }
    ]);
    writeJsonl(latestFile, [
      { type: 'session_meta', payload: { id: 'session-latest', cwd: projectA } },
      { type: 'response_item', timestamp: '2026-05-05T00:10:01.000Z', payload: { type: 'message', role: 'user', content: 'latest prompt should be imported first' } },
      { type: 'response_item', timestamp: '2026-05-05T00:10:02.000Z', payload: { type: 'message', role: 'assistant', content: 'latest assistant should be imported first' } }
    ]);
    utimesSync(oldFile, new Date('2026-05-05T00:00:00.000Z'), new Date('2026-05-05T00:00:00.000Z'));
    utimesSync(latestFile, new Date('2026-05-05T00:10:00.000Z'), new Date('2026-05-05T00:10:00.000Z'));

    const memoryService = {
      startSession: vi.fn(async (_sessionId: string, _projectPath?: string) => undefined),
      endSession: vi.fn(async (_sessionId: string) => undefined),
      deleteSessionEvents: vi.fn(async (_sessionId: string) => 0),
      storeUserPrompt: vi.fn(async () => ({ success: true, isDuplicate: false })),
      storeAgentResponse: vi.fn(async () => ({ success: true, isDuplicate: false }))
    };
    const importer = createCodexSessionHistoryImporter(memoryService as never, { sessionsDir });

    const result = await importer.importProject(projectA, { sessionLimit: 2, limit: 2 });

    expect(result.totalSessions).toBe(1);
    expect(memoryService.startSession).toHaveBeenCalledTimes(1);
    expect(memoryService.startSession).toHaveBeenCalledWith('session-latest', projectA);
    expect(memoryService.storeUserPrompt).toHaveBeenCalledTimes(1);
    expect(memoryService.storeAgentResponse).toHaveBeenCalledTimes(1);
  });
});
