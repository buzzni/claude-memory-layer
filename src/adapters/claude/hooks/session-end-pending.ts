/**
 * Pending SessionEnd jobs
 *
 * The session-end worker acknowledges its job before it loads the session-end
 * work, so once the hook has left nothing else will end that session. When
 * the load fails (a partial install, a module that throws while evaluating)
 * the worker keeps the job here instead, one file per session under
 * ~/.claude-code/memory/session-end-pending/, and the next worker that does
 * load the work retries it. Every outcome appends a record to
 * ~/.claude-code/memory/session-end-diagnostics.jsonl, which `doctor` points
 * to. Uses only node built-ins: the worker loads this before it has acked.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { SessionEndHandler } from './session-end-handoff.js';
import type { ClaudeSessionEndJob } from './session-end.js';

/** Retries of a job whose handler loaded but threw, before it is dropped. */
export const SESSION_END_RETRY_MAX_ATTEMPTS = 3;
/** A session that ended longer ago than this is dropped instead of ended. */
export const SESSION_END_RETRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A retry claim this old belongs to a worker that died mid-retry. */
const STALE_CLAIM_MS = 60 * 60 * 1000;
const CLAIM_SUFFIX = '.claimed';

export interface PendingSessionEndJob {
  version: 1;
  job: ClaudeSessionEndJob;
  failedAt: string;
  /** Retries that ran the handler and failed. */
  attempts: number;
  lastError: string;
}

export interface SessionEndPendingOptions {
  homeDir?: string;
  now?: () => Date;
}

export interface SessionEndRetrySummary {
  completed: number;
  failed: number;
  abandoned: number;
}

function memoryDir(options: SessionEndPendingOptions): string {
  return path.join(options.homeDir ?? os.homedir(), '.claude-code', 'memory');
}

export function getSessionEndPendingDir(options: SessionEndPendingOptions = {}): string {
  return path.join(memoryDir(options), 'session-end-pending');
}

export function getSessionEndDiagnosticsPath(options: SessionEndPendingOptions = {}): string {
  return path.join(memoryDir(options), 'session-end-diagnostics.jsonl');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordDiagnostic(options: SessionEndPendingOptions, record: Record<string, unknown>): void {
  try {
    const at = (options.now ?? (() => new Date()))().toISOString();
    fs.mkdirSync(memoryDir(options), { recursive: true });
    fs.appendFileSync(getSessionEndDiagnosticsPath(options), `${JSON.stringify({ version: 1, at, ...record })}\n`);
  } catch {
    // Diagnostics must never affect session end.
  }
}

function writeRecord(file: string, record: PendingSessionEndJob): void {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(record));
  fs.renameSync(temp, file);
}

function readRecord(file: string): PendingSessionEndJob | null {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as PendingSessionEndJob;
    return record?.version === 1 && typeof record.job?.sessionId === 'string' ? record : null;
  } catch {
    return null;
  }
}

function readDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Keep a job whose session-end work could not be loaded. Never throws. */
export function savePendingSessionEndJob(
  job: ClaudeSessionEndJob,
  error: unknown,
  options: SessionEndPendingOptions = {}
): void {
  const lastError = errorMessage(error);
  try {
    const dir = getSessionEndPendingDir(options);
    fs.mkdirSync(dir, { recursive: true });
    // One per session: a session resumed and ended again replaces its older job.
    const file = path.join(dir, `${job.sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
    writeRecord(file, {
      version: 1,
      job,
      failedAt: (options.now ?? (() => new Date()))().toISOString(),
      attempts: 0,
      lastError
    });
  } catch {
    // Nowhere to keep it; the diagnostic below still records the loss.
  }
  recordDiagnostic(options, { event: 'handler_load_failed', error: lastError });
}

/** Jobs waiting for a retry, including ones a worker is retrying right now. */
export function listPendingSessionEndJobs(options: SessionEndPendingOptions = {}): PendingSessionEndJob[] {
  const dir = getSessionEndPendingDir(options);
  return readDir(dir)
    .filter((name) => name.endsWith('.json') || name.endsWith(`.json${CLAIM_SUFFIX}`))
    .sort()
    .flatMap((name) => readRecord(path.join(dir, name)) ?? []);
}

/**
 * Run each kept job through a handler that loaded. A job is claimed by
 * renaming it first, so two workers retrying at once never run it twice.
 */
export async function retryPendingSessionEndJobs(
  handle: SessionEndHandler,
  options: SessionEndPendingOptions = {}
): Promise<SessionEndRetrySummary> {
  const summary: SessionEndRetrySummary = { completed: 0, failed: 0, abandoned: 0 };
  const dir = getSessionEndPendingDir(options);
  const now = (options.now ?? (() => new Date()))();

  for (const name of readDir(dir).filter((entry) => entry.endsWith(`.json${CLAIM_SUFFIX}`))) {
    const claimed = path.join(dir, name);
    try {
      if (Date.now() - fs.statSync(claimed).mtimeMs > STALE_CLAIM_MS) {
        fs.renameSync(claimed, claimed.slice(0, -CLAIM_SUFFIX.length));
      }
    } catch {
      // Another worker took it over or finished it.
    }
  }

  for (const name of readDir(dir).filter((entry) => entry.endsWith('.json'))) {
    const file = path.join(dir, name);
    const claimed = `${file}${CLAIM_SUFFIX}`;
    try {
      fs.renameSync(file, claimed);
    } catch {
      continue;
    }
    try {
      // A rename keeps the saved file's mtime; the claim's age starts now.
      const claimedAt = new Date();
      fs.utimesSync(claimed, claimedAt, claimedAt);
    } catch {
      // Gone already; reading it below fails and drops it.
    }
    const abandon = (reason: string) => {
      fs.rmSync(claimed, { force: true });
      summary.abandoned += 1;
      recordDiagnostic(options, { event: 'retry_abandoned', reason });
    };

    const record = readRecord(claimed);
    if (!record) {
      abandon('unreadable');
      continue;
    }
    if (now.getTime() - Date.parse(record.failedAt) > SESSION_END_RETRY_MAX_AGE_MS) {
      abandon('expired');
      continue;
    }
    try {
      await handle(record.job);
      fs.rmSync(claimed, { force: true });
      summary.completed += 1;
      recordDiagnostic(options, { event: 'retry_completed', attempts: record.attempts + 1 });
    } catch (error) {
      const attempts = record.attempts + 1;
      if (attempts >= SESSION_END_RETRY_MAX_ATTEMPTS) {
        abandon('attempts');
        continue;
      }
      try {
        writeRecord(claimed, { ...record, attempts, lastError: errorMessage(error) });
        // Linking fails when the session ended again meanwhile and its newer job was kept.
        fs.linkSync(claimed, file);
        fs.rmSync(claimed, { force: true });
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code === 'EEXIST') {
          abandon('superseded');
          continue;
        }
        // Left claimed; a later worker takes it over once the claim is stale.
      }
      summary.failed += 1;
      recordDiagnostic(options, { event: 'retry_failed', attempts, error: errorMessage(error) });
    }
  }
  return summary;
}
