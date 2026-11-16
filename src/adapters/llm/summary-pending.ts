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
 * One file per session under ~/.claude-code/memory/summary-pending/. A retry
 * claims its file by renaming it to a name that carries the claimer's pid and
 * claim time. Every change to the directory — save, prune, claim, release,
 * complete, taking back stale claims — runs under one WorkerLock, so no change
 * ever sees a file another one is moving. Without the lock a change is
 * skipped; a skipped removal leaves the entry in place, which is always safe.
 * Only the semantic daemon changes the queue, never a hook's response path;
 * doctor and audit only read it.
 *
 * Invariant: a kept summary does not disappear before its retry is done (the
 * summary was stored, or there was nothing left to store). The only other
 * removals are the stated bounds: older than 7 days, beyond 100 entries in
 * the whole queue (claimed ones included; the oldest unclaimed go first), or
 * 3 retries that reached the provider and failed. Known limits: a save that
 * cannot take the lock is dropped (the session stays eligible for the
 * session-start backfill), and WorkerLock's takeover of a dead holder's lock
 * can, rarely, let two processes in at once.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { acquireWorkerLockWithin, releaseQuietly } from './lock-within.js';
import { MAX_PROVIDER_CALL_MS } from './provider-circuit-breaker.js';

/** Entries kept at most, claimed ones included; the oldest unclaimed are dropped first. */
export const SUMMARY_PENDING_MAX_ENTRIES = 100;
/** A session skipped longer ago than this is no longer summarized from here. */
export const SUMMARY_PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Retries that reached the provider and failed, before the entry is dropped. */
export const SUMMARY_PENDING_MAX_ATTEMPTS = 3;
/** Longer than any summary run: the longest provider call plus store work. */
export const SUMMARY_PENDING_STALE_CLAIM_MS = MAX_PROVIDER_CALL_MS + 10 * 60_000;

const LOCK_NAME = '.lock';
/** Queue changes run off the hook path; a short wait beats dropping a save. */
const LOCK_DEADLINE_MS = 500;
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

function isClaimName(name: string): boolean {
  return CLAIM_PATTERN.test(name);
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

function writeRecord(file: string, record: PendingSummary): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, ...record } satisfies PendingSummaryFile), { mode: 0o600 });
  fs.renameSync(temporary, file);
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

/**
 * Runs `change` with the queue lock held. Returns undefined, having changed
 * nothing further, when the lock cannot be taken or the change throws.
 */
function withQueueLock<T>(options: SummaryPendingOptions, change: (dir: string) => T): T | undefined {
  const dir = getSummaryPendingDir(options);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return undefined;
  }
  const lock = acquireWorkerLockWithin(path.join(dir, LOCK_NAME), LOCK_DEADLINE_MS, {
    now: () => new Date(nowMs(options)),
    ...(options.isProcessRunning ? { isProcessRunning: options.isProcessRunning } : {})
  });
  if (!lock) return undefined;
  try {
    return change(dir);
  } catch {
    return undefined;
  } finally {
    releaseQuietly(lock);
  }
}

/** Keep a session the breaker skipped. Never throws (nor does anything else here); never replaces a kept or claimed entry. */
export function savePendingSummary(sessionId: string, options: SummaryPendingOptions = {}): void {
  withQueueLock(options, (dir) => {
    const name = queueFileName(sessionId);
    // A claimed entry goes back with its original queuedAt when its retry ends.
    if (readDir(dir).some((entry) => entry === name || entry.startsWith(`${name}${CLAIM_MARKER}`))) return;
    writeRecord(path.join(dir, name), { sessionId, queuedAt: new Date(nowMs(options)).toISOString(), attempts: 0 });
    pruneLocked(dir, options);
  });
}

/**
 * Lock held: drops expired and unreadable unclaimed entries, then the oldest
 * unclaimed ones while the whole queue, claimed entries included, is over
 * the limit. Claimed entries belong to their retry and are never removed here.
 */
function pruneLocked(dir: string, options: SummaryPendingOptions): void {
  const names = readDir(dir);
  const claimed = names.filter(isClaimName).length;
  const unclaimed = names
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ file: path.join(dir, name), record: readRecord(path.join(dir, name)) }));
  const keep = unclaimed
    .filter(({ file, record }) => {
      if (record && !expired(record, options)) return true;
      fs.rmSync(file, { force: true });
      return false;
    })
    .sort((a, b) => a.record!.queuedAt.localeCompare(b.record!.queuedAt));
  for (const { file } of keep.slice(0, Math.max(0, claimed + keep.length - SUMMARY_PENDING_MAX_ENTRIES))) {
    fs.rmSync(file, { force: true });
  }
}

/** Kept sessions, including ones being retried right now; a lock-free read for status reporting. */
export function listPendingSummaries(options: SummaryPendingOptions = {}): PendingSummary[] {
  const dir = getSummaryPendingDir(options);
  return readDir(dir)
    .filter((name) => name.endsWith('.json') || isClaimName(name))
    .flatMap((name) => readRecord(path.join(dir, name)) ?? [])
    .filter((record) => !expired(record, options))
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

/**
 * Takes back claims whose owner died or that are older than any summary run
 * (or dated in the future, after the clock went back), then returns the kept
 * session ids, oldest first. Empty when the queue lock is unavailable.
 */
export function pendingSummarySessionIds(options: SummaryPendingOptions = {}): string[] {
  return withQueueLock(options, (dir) => {
    const isProcessRunning = options.isProcessRunning ?? defaultIsProcessRunning;
    const now = nowMs(options);
    const names = readDir(dir);
    for (const name of names) {
      const match = CLAIM_PATTERN.exec(name);
      if (!match) continue;
      const age = now - Number(match[2]);
      if (isProcessRunning(Number(match[1])) && age >= 0 && age <= SUMMARY_PENDING_STALE_CLAIM_MS) continue;
      const queued = name.slice(0, name.indexOf(CLAIM_MARKER));
      // save() never queues a claimed session, so the queued name is free.
      if (!names.includes(queued)) fs.renameSync(path.join(dir, name), path.join(dir, queued));
    }
    return readDir(dir)
      .filter((name) => name.endsWith('.json'))
      .flatMap((name) => readRecord(path.join(dir, name)) ?? [])
      .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))
      .map((record) => record.sessionId);
  }) ?? [];
}

/** Claims one kept session for a retry, or returns null when it is not there to claim. */
export function claimPendingSummary(sessionId: string, options: SummaryPendingOptions = {}): PendingSummaryClaim | null {
  return withQueueLock(options, (dir) => {
    const queuePath = path.join(dir, queueFileName(sessionId));
    if (!fs.existsSync(queuePath)) return null;
    const claimPath = `${queuePath}${CLAIM_MARKER}${options.pid ?? process.pid}-${nowMs(options)}-${randomUUID()}`;
    fs.renameSync(queuePath, claimPath);
    const record = readRecord(claimPath);
    if (!record || expired(record, options)) {
      fs.rmSync(claimPath, { force: true });
      return null;
    }
    return { sessionId: record.sessionId, record, claimPath, queuePath };
  }) ?? null;
}

/**
 * The retry is done. A claim that was taken back meanwhile is no longer ours
 * and stays; its next retry finds nothing left to do.
 */
export function completePendingSummary(claim: PendingSummaryClaim, options: SummaryPendingOptions = {}): void {
  withQueueLock(options, () => {
    fs.rmSync(claim.claimPath, { force: true });
  });
}

/**
 * The retry did not complete: put the entry back with its original queuedAt.
 * `failed` counts a retry that reached the provider and failed; a deferred
 * one (breaker still open, store busy) does not count. A claim that was taken
 * back meanwhile is left to its new owner.
 */
export function releasePendingSummary(
  claim: PendingSummaryClaim,
  outcome: { failed: boolean },
  options: SummaryPendingOptions = {}
): void {
  withQueueLock(options, () => {
    if (!fs.existsSync(claim.claimPath)) return;
    const attempts = claim.record.attempts + (outcome.failed ? 1 : 0);
    if (attempts >= SUMMARY_PENDING_MAX_ATTEMPTS) {
      fs.rmSync(claim.claimPath, { force: true });
      return;
    }
    if (attempts !== claim.record.attempts) writeRecord(claim.claimPath, { ...claim.record, attempts });
    fs.renameSync(claim.claimPath, claim.queuePath);
  });
}
