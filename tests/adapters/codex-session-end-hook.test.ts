import { describe, expect, it, vi } from 'vitest';

import {
  launchCodexSessionImport,
  normalizeCodexSessionImportJob,
  type CodexSessionEndHookInput
} from '../../src/adapters/codex/hooks/session-end.js';

const validInput: CodexSessionEndHookInput = {
  session_id: 'thr-123',
  transcript_path: '/tmp/codex/rollout.jsonl',
  cwd: '/repo/project',
  hook_event_name: 'SessionEnd'
};

describe('Codex SessionEnd hook', () => {
  it('normalizes the official Codex hook fields into a project-scoped import job', () => {
    expect(normalizeCodexSessionImportJob(validInput)).toEqual({
      transcriptPath: '/tmp/codex/rollout.jsonl',
      projectPath: '/repo/project'
    });
  });

  it('ignores missing transcripts and non-absolute project scopes', () => {
    expect(normalizeCodexSessionImportJob({ ...validInput, transcript_path: null })).toBeNull();
    expect(normalizeCodexSessionImportJob({ ...validInput, cwd: 'relative/project' })).toBeNull();
  });

  it('hands work to a detached worker and closes the payload pipe', () => {
    const on = vi.fn();
    const end = vi.fn();
    const unref = vi.fn();
    const spawnWorker = vi.fn(() => ({ stdin: { on, end }, unref }));

    const launched = launchCodexSessionImport(validInput, {
      spawnWorker: spawnWorker as never,
      workerPath: '/plugin/hooks/codex-session-import-worker.js'
    });

    expect(launched).toBe(true);
    expect(spawnWorker).toHaveBeenCalledWith(
      process.execPath,
      ['/plugin/hooks/codex-session-import-worker.js'],
      {
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'ignore', 'ignore']
      }
    );
    expect(on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(JSON.parse(end.mock.calls[0][0])).toEqual({
      transcriptPath: '/tmp/codex/rollout.jsonl',
      projectPath: '/repo/project'
    });
    expect(unref).toHaveBeenCalledTimes(1);
  });
});
