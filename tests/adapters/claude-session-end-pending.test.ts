import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  SESSION_END_RETRY_MAX_ATTEMPTS,
  SESSION_END_RETRY_MAX_AGE_MS,
  getSessionEndDiagnosticsPath,
  getSessionEndPendingDir,
  listPendingSessionEndJobs,
  retryPendingSessionEndJobs,
  savePendingSessionEndJob
} from '../../src/adapters/claude/hooks/session-end-pending.js';
import type { ClaudeSessionEndJob } from '../../src/adapters/claude/hooks/session-end.js';

const job: ClaudeSessionEndJob = {
  sessionId: 'session-1',
  registrationId: 'registration-1',
  transcriptPath: '/tmp/claude/session-1.jsonl',
  projectPath: '/repo/project',
  snapshot: { transcriptBytes: 4096, endedAt: '2026-11-07T00:00:00.000Z', openTurn: null }
};

describe('pending SessionEnd jobs', () => {
  let homeDir = '';
  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), 'cml-session-end-pending-'));
  });
  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  const at = (iso: string) => ({ homeDir, now: () => new Date(iso) });
  const diagnostics = () => readFileSync(getSessionEndDiagnosticsPath({ homeDir }), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);

  it('keeps a job whose handler failed to load, with a diagnostic record', () => {
    savePendingSessionEndJob(job, new Error('Cannot find module better-sqlite3'), at('2026-11-07T01:00:00.000Z'));

    expect(listPendingSessionEndJobs({ homeDir })).toEqual([{
      version: 1,
      job,
      failedAt: '2026-11-07T01:00:00.000Z',
      attempts: 0,
      lastError: 'Cannot find module better-sqlite3'
    }]);
    expect(diagnostics()).toEqual([expect.objectContaining({
      event: 'handler_load_failed',
      error: 'Cannot find module better-sqlite3'
    })]);
  });

  it('lists nothing when no job ever failed', () => {
    expect(listPendingSessionEndJobs({ homeDir })).toEqual([]);
  });

  it('runs a kept job once on retry and then forgets it', async () => {
    savePendingSessionEndJob(job, new Error('boom'), at('2026-11-07T01:00:00.000Z'));
    const handle = vi.fn(async () => {});

    const first = await retryPendingSessionEndJobs(handle, at('2026-11-07T02:00:00.000Z'));
    const second = await retryPendingSessionEndJobs(handle, at('2026-11-07T03:00:00.000Z'));

    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith(job);
    expect(first).toEqual({ completed: 1, failed: 0, abandoned: 0 });
    expect(second).toEqual({ completed: 0, failed: 0, abandoned: 0 });
    expect(listPendingSessionEndJobs({ homeDir })).toEqual([]);
    expect(diagnostics().map((record) => record.event)).toEqual(['handler_load_failed', 'retry_completed']);
  });

  it('gives up on a job after a bounded number of failed retries', async () => {
    savePendingSessionEndJob(job, new Error('boom'), at('2026-11-07T01:00:00.000Z'));
    const handle = vi.fn(async () => { throw new Error('still broken'); });

    for (let attempt = 1; attempt < SESSION_END_RETRY_MAX_ATTEMPTS; attempt += 1) {
      expect(await retryPendingSessionEndJobs(handle, at('2026-11-07T02:00:00.000Z')))
        .toEqual({ completed: 0, failed: 1, abandoned: 0 });
      expect(listPendingSessionEndJobs({ homeDir })[0]).toMatchObject({ attempts: attempt, lastError: 'still broken' });
    }
    expect(await retryPendingSessionEndJobs(handle, at('2026-11-07T02:00:00.000Z')))
      .toEqual({ completed: 0, failed: 0, abandoned: 1 });
    expect(await retryPendingSessionEndJobs(handle, at('2026-11-07T02:00:00.000Z')))
      .toEqual({ completed: 0, failed: 0, abandoned: 0 });

    expect(handle).toHaveBeenCalledTimes(SESSION_END_RETRY_MAX_ATTEMPTS);
    expect(listPendingSessionEndJobs({ homeDir })).toEqual([]);
    expect(diagnostics().at(-1)).toMatchObject({ event: 'retry_abandoned', reason: 'attempts' });
  });

  it('drops a job too old to be worth ending without running it', async () => {
    savePendingSessionEndJob(job, new Error('boom'), at('2026-11-07T01:00:00.000Z'));
    const handle = vi.fn(async () => {});
    const later = new Date(Date.parse('2026-11-07T01:00:00.000Z') + SESSION_END_RETRY_MAX_AGE_MS + 1).toISOString();

    expect(await retryPendingSessionEndJobs(handle, at(later))).toEqual({ completed: 0, failed: 0, abandoned: 1 });

    expect(handle).not.toHaveBeenCalled();
    expect(listPendingSessionEndJobs({ homeDir })).toEqual([]);
    expect(diagnostics().at(-1)).toMatchObject({ event: 'retry_abandoned', reason: 'expired' });
  });

  it('does not run a job another worker is already retrying, but takes over one it left behind', async () => {
    savePendingSessionEndJob(job, new Error('boom'), at('2026-11-07T01:00:00.000Z'));
    const dir = getSessionEndPendingDir({ homeDir });
    const [file] = readdirSync(dir);
    const claimed = path.join(dir, `${file}.claimed`);
    // As another worker would leave it mid-retry.
    writeFileSync(claimed, readFileSync(path.join(dir, file)));
    rmSync(path.join(dir, file));
    const handle = vi.fn(async () => {});

    expect(await retryPendingSessionEndJobs(handle, { homeDir })).toEqual({ completed: 0, failed: 0, abandoned: 0 });
    expect(handle).not.toHaveBeenCalled();
    expect(listPendingSessionEndJobs({ homeDir })).toHaveLength(1);

    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(claimed, longAgo, longAgo);
    expect(await retryPendingSessionEndJobs(handle, { homeDir })).toEqual({ completed: 1, failed: 0, abandoned: 0 });
    expect(existsSync(claimed)).toBe(false);
  });

  it('does not let a second worker take over a job saved long ago that the first has just claimed', async () => {
    savePendingSessionEndJob(job, new Error('boom'), at('2026-11-07T01:00:00.000Z'));
    const dir = getSessionEndPendingDir({ homeDir });
    const [file] = readdirSync(dir);
    // Saved two hours ago; a rename keeps this mtime on the claim.
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(path.join(dir, file), longAgo, longAgo);
    const releases: Array<() => void> = [];
    const handle = vi.fn(() => new Promise<void>((resolve) => { releases.push(resolve); }));

    const first = retryPendingSessionEndJobs(handle, { homeDir });
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(1));
    const second = retryPendingSessionEndJobs(handle, { homeDir });
    await new Promise((resolve) => setImmediate(resolve));
    const runs = handle.mock.calls.length;
    releases.forEach((release) => release());

    expect(runs).toBe(1);
    expect(await second).toEqual({ completed: 0, failed: 0, abandoned: 0 });
    expect(await first).toEqual({ completed: 1, failed: 0, abandoned: 0 });
  });

  it('never throws when the store cannot be written', () => {
    writeFileSync(path.join(homeDir, '.claude-code'), 'not a directory');

    expect(() => savePendingSessionEndJob(job, new Error('boom'), { homeDir })).not.toThrow();
    expect(listPendingSessionEndJobs({ homeDir })).toEqual([]);
  });
});
