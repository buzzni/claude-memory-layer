import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isClaudeLocalCommandArtifact,
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

    expect(isClaudeLocalCommandArtifact(artifact)).toBe(true);
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
    const importer = new SessionHistoryImporter({
      deleteSessionEvents: vi.fn(async () => { calls.push('delete'); return 2; }),
      startSession: vi.fn(async () => { calls.push('start'); }),
      storeUserPrompt: vi.fn(async () => ({ success: true, isDuplicate: false, eventId: 'e1' })),
      storeAgentResponse: vi.fn(async () => ({ success: true, isDuplicate: false, eventId: 'e2' })),
      endSession: vi.fn(async () => {})
    } as never);

    await importer.importSessionFile(file, { force: true });

    // The destructive delete must run, and only after the file passed pre-flight.
    expect(calls[0]).toBe('delete');
    expect(calls).toContain('start');
  });
});
