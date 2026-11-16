import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SessionHistoryImporter } from '../../src/services/session-history-importer.js';
import type { MemoryService } from '../../src/services/memory-service.js';

/**
 * #230: every summary or lesson provider run (`claude -p` in the scratch cwd
 * <tmpdir>/cml-summary or <tmpdir>/cml-lesson) leaves a transcript under
 * ~/.claude/projects/<encoded scratch cwd>/. Its prompt is another session's
 * content, so `import --all` must not store it as a session of its own.
 */

let home = '';
let previousHome: string | undefined;

function writeTranscript(projectDirName: string, sessionId: string): string {
  const dir = path.join(home, '.claude', 'projects', projectDirName);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  writeFileSync(filePath, `${JSON.stringify({ type: 'user', sessionId, message: { role: 'user', content: 'Summarize this session transcript please.' } })}\n`);
  return filePath;
}

describe('SessionHistoryImporter.importAll provider transcripts', () => {
  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(path.join(tmpdir(), 'cml-import-provider-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('skips the summary and lesson provider scratch projects and imports every other project', async () => {
    const userSession = writeTranscript('-Users-dev-workspace-app', 'user-session');
    writeTranscript('-private-var-folders-bh-abc123-T-cml-summary', 'summary-run');
    writeTranscript('-tmp-cml-lesson', 'lesson-run');

    const importer = new SessionHistoryImporter({} as MemoryService);
    const importSessionFile = vi.spyOn(importer, 'importSessionFile').mockResolvedValue({
      totalSessions: 1,
      totalMessages: 1,
      importedPrompts: 1,
      importedResponses: 0,
      skippedDuplicates: 0,
      errors: []
    });

    const result = await importer.importAll();

    expect(importSessionFile.mock.calls.map(([filePath]) => filePath)).toEqual([userSession]);
    expect(result.totalSessions).toBe(1);
  });

  it('never resolves a project import or listing to a provider scratch project', async () => {
    // A project with no transcripts of its own whose basename appears in the
    // scratch directory name used to fuzzy-match the scratch project.
    writeTranscript('-private-var-folders-bh-abc123-T-cml-summary', 'summary-run');

    const importer = new SessionHistoryImporter({} as MemoryService);
    const importSessionFile = vi.spyOn(importer, 'importSessionFile');

    const result = await importer.importProject('/Users/dev/summary');

    expect(importSessionFile).not.toHaveBeenCalled();
    expect(result.totalSessions).toBe(0);
    expect(await importer.listAvailableSessions('/Users/dev/summary')).toEqual([]);
    expect(await importer.listAvailableSessions()).toEqual([]);
  });

  it('still imports a project whose name only contains a scratch directory name', async () => {
    const userSession = writeTranscript('-Users-dev-cml-summary-notes', 'user-session');

    const importer = new SessionHistoryImporter({} as MemoryService);
    const importSessionFile = vi.spyOn(importer, 'importSessionFile').mockResolvedValue({
      totalSessions: 1,
      totalMessages: 0,
      importedPrompts: 0,
      importedResponses: 0,
      skippedDuplicates: 0,
      errors: []
    });

    await importer.importAll();

    expect(importSessionFile.mock.calls.map(([filePath]) => filePath)).toEqual([userSession]);
  });
});
