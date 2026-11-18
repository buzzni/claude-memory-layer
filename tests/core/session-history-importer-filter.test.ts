import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isHarnessBoilerplate } from '../../src/core/harness-boilerplate.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteAll } from '../../src/core/sqlite-wrapper.js';
import {
  isWorthStoringPrompt,
  SessionHistoryImporter,
  type ImportResult
} from '../../src/services/session-history-importer.js';

const tempDirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cml-session-importer-'));
  tempDirs.push(dir);
  return dir;
}

function makeImportResult(overrides: Partial<ImportResult> = {}): ImportResult {
  return {
    totalSessions: 1,
    totalMessages: 1,
    importedPrompts: 1,
    importedResponses: 0,
    skippedDuplicates: 0,
    errors: [],
    ...overrides
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('session history importer prompt filtering', () => {
  it('drops Claude local-command artifacts that dilute retrieval quality', () => {
    const artifact = `<command-name>/model</command-name>\n<local-command-stdout>Using model opus</local-command-stdout>`;

    expect(isHarnessBoilerplate(artifact)).toBe(true);
    expect(isWorthStoringPrompt(artifact)).toBe(false);
  });

  it('keeps substantive imported user prompts', () => {
    expect(isWorthStoringPrompt('이 프로젝트에서 memory retrieval 구조를 더 가볍게 개선해줘')).toBe(true);
  });

  it('imports only the most recently modified matching Claude session when sessionLimit is set', async () => {
    const dir = tempDir();
    const older = join(dir, 'older.jsonl');
    const newest = join(dir, 'newest.jsonl');
    const oldest = join(dir, 'oldest.jsonl');
    for (const filePath of [older, newest, oldest]) {
      writeFileSync(filePath, '{}\n', 'utf8');
    }
    utimesSync(oldest, new Date('2026-05-01T00:00:00.000Z'), new Date('2026-05-01T00:00:00.000Z'));
    utimesSync(older, new Date('2026-05-02T00:00:00.000Z'), new Date('2026-05-02T00:00:00.000Z'));
    utimesSync(newest, new Date('2026-05-03T00:00:00.000Z'), new Date('2026-05-03T00:00:00.000Z'));

    const importer = new SessionHistoryImporter({} as never) as SessionHistoryImporter & {
      findProjectDirs: ReturnType<typeof vi.fn>;
      findSessionFiles: ReturnType<typeof vi.fn>;
      importSessionFile: ReturnType<typeof vi.fn>;
    };
    importer.findProjectDirs = vi.fn(async () => [dir]);
    importer.findSessionFiles = vi.fn(async () => [older, newest, oldest]);
    importer.importSessionFile = vi.fn(async () => makeImportResult());

    const result = await importer.importProject('/repo/current', { sessionLimit: 1 });

    expect(result.totalSessions).toBe(1);
    expect(importer.importSessionFile).toHaveBeenCalledTimes(1);
    expect(importer.importSessionFile).toHaveBeenCalledWith(newest, expect.objectContaining({ sessionLimit: 1 }));
  });

  it('does not delete existing events on force reimport when the source file is unparseable', async () => {
    const dir = tempDir();
    const file = join(dir, 'corrupt-session.jsonl');
    writeFileSync(file, 'not json at all\n{still not<json\n', 'utf8');

    const deleteSessionEvents = vi.fn(async () => 5);
    const startSession = vi.fn(async () => {});
    const importer = new SessionHistoryImporter({ deleteSessionEvents, startSession } as never);

    const result = await importer.importSessionFile(file, { force: true });

    expect(deleteSessionEvents).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
    expect(result.errors.some((e) => e.includes('Skipped force reimport'))).toBe(true);
  });

  it('deletes before re-importing when a force reimport source file is parseable', async () => {
    const dir = tempDir();
    const file = join(dir, 'valid-session.jsonl');
    writeFileSync(
      file,
      '{"type":"user","timestamp":"2026-05-01T00:00:00Z","message":{"role":"user","content":"hello"}}\n',
      'utf8'
    );

    const calls: string[] = [];
    const evaluateSessionHelpfulness = vi.fn(async () => {});
    const deleteSessionEvents = vi.fn(async (_sessionId: string, _options?: unknown) => { calls.push('delete'); return 2; });
    const importer = new SessionHistoryImporter({
      deleteSessionEvents,
      startSession: vi.fn(async () => { calls.push('start'); }),
      getSessionHistory: vi.fn(async () => []),
      storeUserPrompt: vi.fn(async () => ({ success: true, isDuplicate: false, eventId: 'e1' })),
      storeAgentResponse: vi.fn(async () => ({ success: true, isDuplicate: false, eventId: 'e2' })),
      endSession: vi.fn(async () => {}),
      evaluateSessionHelpfulness
    } as never);

    await importer.importSessionFile(file, { force: true, auditActor: 'cli' });

    // The destructive delete must run, and only after the file passed pre-flight.
    expect(calls[0]).toBe('delete');
    expect(deleteSessionEvents).toHaveBeenCalledWith('valid-session', {
      importedFrom: file,
      audit: { operation: 'session_reimport', actor: 'cli', targetType: 'session', targetId: 'valid-session', beforeJson: { source: 'claude' } }
    });
    expect(calls).toContain('start');
    expect(evaluateSessionHelpfulness).toHaveBeenCalledTimes(1);
  });

  it('a forced reimport leaves one session_reimport audit row in a real store, with the deleted count and no content or path', async () => {
    const dir = tempDir();
    const file = join(dir, 'real-session.jsonl');
    writeFileSync(
      file,
      '{"type":"user","timestamp":"2026-05-01T00:00:00Z","message":{"role":"user","content":"hello"}}\n',
      'utf8'
    );
    const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
    await store.initialize();
    await store.append({ eventType: 'user_prompt', sessionId: 'real-session', timestamp: new Date(), content: 'imported papaya prompt', metadata: { importedFrom: file } });
    await store.append({ eventType: 'agent_response', sessionId: 'real-session', timestamp: new Date(), content: 'imported guava response', metadata: { importedFrom: file } });
    await store.append({ eventType: 'session_summary', sessionId: 'real-session', timestamp: new Date(), content: 'hook summary stays' });

    try {
      const importer = new SessionHistoryImporter({
        deleteSessionEvents: (sessionId: string, options?: Parameters<SQLiteEventStore['deleteSessionEvents']>[1]) =>
          store.deleteSessionEvents(sessionId, options),
        startSession: vi.fn(async () => {}),
        getSessionHistory: vi.fn(async () => []),
        storeUserPrompt: vi.fn(async () => ({ success: true, isDuplicate: false, eventId: 'e1' })),
        storeAgentResponse: vi.fn(async () => ({ success: true, isDuplicate: false, eventId: 'e2' })),
        endSession: vi.fn(async () => {}),
        evaluateSessionHelpfulness: vi.fn(async () => {})
      } as never);

      await importer.importSessionFile(file, { force: true, auditActor: 'mcp' });

      const rows = sqliteAll<Record<string, string>>(store.getDatabase(), `SELECT * FROM memory_governance_audit WHERE operation = 'session_reimport'`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor: 'mcp', target_type: 'session', target_id: 'real-session' });
      expect(JSON.parse(rows[0].before_json)).toEqual({ source: 'claude' });
      expect(JSON.parse(rows[0].after_json)).toEqual({ deletedEvents: 2 });
      expect(JSON.stringify(rows[0])).not.toMatch(/papaya|guava|real-session\.jsonl/);
    } finally {
      await store.close();
    }
  });
});
