/**
 * Session summaries the provider circuit breaker skipped.
 *
 * A skipped session keeps no summary, so the session-start backfill could
 * pick it up again, but that backfill only looks at the five most recent
 * unsummarized sessions of the project being opened, and sessions whose
 * summary came back empty stay in that window forever (#206). A long outage
 * would push skipped sessions out of reach. The semantic daemon keeps them
 * here and summarizes them once a provider call succeeds again.
 *
 * Modelled on session-end-pending: one file per session under
 * ~/.claude-code/memory/summary-pending/, so concurrent saves never rewrite
 * each other, and a retry claims its file by renaming it. The claim name
 * carries the claimer's pid and claim time, so the rename alone records the
 * owner, and a claim whose owner died or that outlived any summary run is
 * taken back.
 *
 * Invariant: a kept session is removed only when its retry reports done, or
 * when it hits a stated bound — older than SUMMARY_PENDING_MAX_AGE_MS, beyond
 * SUMMARY_PENDING_MAX_ENTRIES, or SUMMARY_PENDING_MAX_ATTEMPTS retries that
 * failed. A retry that fails or is deferred puts the file back with its
 * original queuedAt. Only session ids and times are stored.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Unclaimed entries kept at most; the oldest are dropped first. */
export const SUMMARY_PENDING_MAX_ENTRIES = 100;
/** A session skipped longer ago than this is no longer summarized from here. */
export const SUMMARY_PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Retries that reached the provider and failed, before the entry is dropped. */
export const SUMMARY_PENDING_MAX_ATTEMPTS = 3;
/** A claim this old outlived any summary run; its owner is gone or stuck. */
export const SUMMARY_PENDING_STALE_CLAIM_MS = 60 * 60 * 1000;

const CLAIM_MARKER = '.claimed-';
const CLAIM_PATTERN = /\.claimed-(\d+)-(\d+)-[0-9a-f-]+$/;

export interface PendingSummary {
  sessionId: string;
  queuedAt: string;
  /** Retries that reached the provider and failed. */
  attempts: number;
}

export interface PendingSummaryClaim {
  sessionId: string;
  record: PendingSummary;
  /** Where the claimed file lives while the retry runs. */
  claimPath: string;
  /** Where it goes back to when the retry does not complete. */
  queuePath: string;
}

export interface SummaryPendingOptions {
  homeDir?: string;
  now?: () => number;
  pid?: number;
  isProcessRunning?: (pid: number) => boolean;
}

interface PendingSummaryFile extends PendingSummary {
  version: 1;
}

export function getSummaryPendingDir(options: SummaryPendingOptions = {}): string {
  return path.join(options.homeDir ?? os.homedir(), '.claude-code', 'memory', 'summary-pending');
}

function nowMs(options: SummaryPendingOptions): number {
  return (options.now ?? Date.now)();
}

function queueFileName(sessionId: string): string {
  return `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`;
}

function readDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function readRecord(file: string): PendingSummary | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<PendingSummaryFile>;
    if (parsed?.version !== 1 || typeof parsed.sessionId !== 'string' || typeof parsed.queuedAt !== 'string') return null;
    if (!Number.isFinite(Date.parse(parsed.queuedAt))) return null;
    const attempts = Number.isInteger(parsed.attempts) && parsed.attempts! >= 0 ? parsed.attempts! : 0;
    return { sessionId: parsed.sessionId, queuedAt: parsed.queuedAt, attempts };
  } catch {
    return null;
  }
}

function serialize(record: PendingSummary): string {
  return JSON.stringify({ version: 1, ...record } satisfies PendingSummaryFile);
}

function expired(record: PendingSummary, options: SummaryPendingOptions): boolean {
  return nowMs(options) - Date.parse(record.queuedAt) > SUMMARY_PENDING_MAX_AGE_MS;
}

function defaultIsProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Keep a session the breaker skipped. Never throws; never replaces a kept or claimed entry. */
export function savePendingSummary(sessionId: string, options: SummaryPendingOptions = {}): void {
  const dir = getSummaryPendingDir(options);
  const name = queueFileName(sessionId);
  const file = path.join(dir, name);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // A claimed entry goes back with its original queuedAt when its retry ends.
    if (readDir(dir).some((entry) => entry.startsWith(`${name}${CLAIM_MARKER}`))) return;
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, serialize({ sessionId, queuedAt: new Date(nowMs(options)).toISOString(), attempts: 0 }), {
      flag: 'wx',
      mode: 0o600
    });
    try {
      // link fails when the session is already kept, which keeps the older entry.
      fs.linkSync(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  } catch {
    // Nowhere to keep it; the session-start backfill may still reach it.
  }
  pruneUnclaimed(options);
}

/** Drops expired, unreadable and excess unclaimed entries. Claimed entries belong to their retry. */
function pruneUnclaimed(options: SummaryPendingOptions): void {
  const dir = getSummaryPendingDir(options);
  const entries = readDir(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ file: path.join(dir, name), record: readRecord(path.join(dir, name)) }))
    .sort((a, b) => (b.record?.queuedAt ?? '').localeCompare(a.record?.queuedAt ?? ''));
  let retained = 0;
  for (const { file, record } of entries) {
    if (record && !expired(record, options) && retained < SUMMARY_PENDING_MAX_ENTRIES) {
      retained += 1;
      continue;
    }
    fs.rmSync(file, { force: true });
  }
}

/** Kept sessions, including ones being retried right now; for status reporting. */
export function listPendingSummaries(options: SummaryPendingOptions = {}): PendingSummary[] {
  const dir = getSummaryPendingDir(options);
  return readDir(dir)
    .filter((name) => name.endsWith('.json') || CLAIM_PATTERN.test(name))
    .flatMap((name) => readRecord(path.join(dir, name)) ?? [])
    .filter((record) => !expired(record, options))
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

/**
 * Puts back claims whose owner died or that are older than any summary run
 * (or dated in the future, after the clock went back), then returns the kept
 * session ids, oldest first.
 */
export function pendingSummarySessionIds(options: SummaryPendingOptions = {}): string[] {
  const dir = getSummaryPendingDir(options);
  const isProcessRunning = options.isProcessRunning ?? defaultIsProcessRunning;
  const now = nowMs(options);
  for (const name of readDir(dir)) {
    const match = CLAIM_PATTERN.exec(name);
    if (!match) continue;
    const age = now - Number(match[2]);
    const live = isProcessRunning(Number(match[1])) && age >= 0 && age <= SUMMARY_PENDING_STALE_CLAIM_MS;
    if (live) continue;
    try {
      // Replacing a newer duplicate keeps the original queuedAt.
      fs.renameSync(path.join(dir, name), path.join(dir, name.slice(0, name.indexOf(CLAIM_MARKER))));
    } catch {
      // Another process took it back first.
    }
  }
  return readDir(dir)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => readRecord(path.join(dir, name)) ?? [])
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))
    .map((record) => record.sessionId);
}

/** Claims one kept session for a retry, or returns null when someone else has it. */
export function claimPendingSummary(sessionId: string, options: SummaryPendingOptions = {}): PendingSummaryClaim | null {
  const queuePath = path.join(getSummaryPendingDir(options), queueFileName(sessionId));
  const claimPath = `${queuePath}${CLAIM_MARKER}${options.pid ?? process.pid}-${nowMs(options)}-${randomUUID()}`;
  try {
    fs.renameSync(queuePath, claimPath);
  } catch {
    return null;
  }
  const record = readRecord(claimPath);
  if (!record || expired(record, options)) {
    fs.rmSync(claimPath, { force: true });
    return null;
  }
  return { sessionId: record.sessionId, record, claimPath, queuePath };
}

/** The retry stored a summary or found nothing left to do. */
export function completePendingSummary(claim: PendingSummaryClaim): void {
  fs.rmSync(claim.claimPath, { force: true });
}

/**
 * The retry did not complete: put the entry back with its original queuedAt.
 * `failed` counts a retry that reached the provider and failed; a deferred
 * one (breaker still open, store busy) does not count.
 */
export function releasePendingSummary(claim: PendingSummaryClaim, outcome: { failed: boolean }): void {
  const attempts = claim.record.attempts + (outcome.failed ? 1 : 0);
  try {
    if (attempts >= SUMMARY_PENDING_MAX_ATTEMPTS) {
      fs.rmSync(claim.claimPath, { force: true });
      return;
    }
    if (attempts !== claim.record.attempts) {
      const temporary = `${claim.claimPath}.tmp`;
      fs.writeFileSync(temporary, serialize({ ...claim.record, attempts }), { mode: 0o600 });
      fs.renameSync(temporary, claim.claimPath);
    }
    fs.renameSync(claim.claimPath, claim.queuePath);
  } catch {
    // Left claimed; pendingSummarySessionIds takes it back once it is stale.
  }
}
