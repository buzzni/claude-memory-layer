/**
 * Session summaries the provider circuit breaker skipped.
 *
 * A skipped session keeps no summary, so the session-start backfill could
 * pick it up again, but that backfill only looks at the five most recent
 * unsummarized sessions of the project being opened, and sessions whose
 * summary came back empty stay in that window forever. A long outage would
 * push skipped sessions out of reach. The semantic daemon keeps their ids
 * here and summarizes them once a provider call succeeds again. Only ids and
 * timestamps are stored, bounded by age and count.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Entries kept at most; the oldest are dropped first. */
export const SUMMARY_PENDING_MAX_ENTRIES = 100;
/** A session skipped longer ago than this is no longer summarized from here. */
export const SUMMARY_PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PendingSummary {
  sessionId: string;
  queuedAt: string;
}

export interface SummaryPendingOptions {
  homeDir?: string;
  now?: () => number;
}

export function getSummaryPendingPath(options: SummaryPendingOptions = {}): string {
  return path.join(options.homeDir ?? os.homedir(), '.claude-code', 'memory', 'summary-pending.json');
}

function readEntries(file: string): PendingSummary[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: number; entries?: unknown };
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter((entry): entry is PendingSummary =>
      typeof entry?.sessionId === 'string' && typeof entry?.queuedAt === 'string');
  } catch {
    return [];
  }
}

function withinLimits(entries: PendingSummary[], options: SummaryPendingOptions): PendingSummary[] {
  const now = (options.now ?? Date.now)();
  return entries
    .filter((entry) => now - Date.parse(entry.queuedAt) <= SUMMARY_PENDING_MAX_AGE_MS)
    .slice(-SUMMARY_PENDING_MAX_ENTRIES);
}

/** Never throws: losing the entry leaves the session to the session-start backfill. */
export function savePendingSummary(sessionId: string, options: SummaryPendingOptions = {}): void {
  const file = getSummaryPendingPath(options);
  try {
    const entries = readEntries(file);
    if (!entries.some((entry) => entry.sessionId === sessionId)) {
      entries.push({ sessionId, queuedAt: new Date((options.now ?? Date.now)()).toISOString() });
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, entries: withinLimits(entries, options) }), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch {
    // See above.
  }
}

export function listPendingSummaries(options: SummaryPendingOptions = {}): PendingSummary[] {
  return withinLimits(readEntries(getSummaryPendingPath(options)), options);
}

/**
 * Empties the queue and returns its session ids, oldest first. The file is
 * renamed away before it is read, so two takers never get the same entries.
 */
export function takePendingSummaries(options: SummaryPendingOptions = {}): string[] {
  const file = getSummaryPendingPath(options);
  const taken = `${file}.${process.pid}.taken`;
  try {
    fs.renameSync(file, taken);
  } catch {
    return [];
  }
  try {
    return withinLimits(readEntries(taken), options).map((entry) => entry.sessionId);
  } finally {
    fs.rmSync(taken, { force: true });
  }
}
