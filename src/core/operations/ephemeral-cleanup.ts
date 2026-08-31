import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadSessionRegistry } from '../registry/session-registry.js';
import { createSQLiteDatabase, sqliteAll, sqliteClose, sqliteGet } from '../sqlite-wrapper.js';

export type EphemeralCleanupClass = 'runtime' | 'adherence' | 'all';

export interface EphemeralCleanupOptions {
  homeDir?: string;
  memoryRoot?: string;
  targetClass?: EphemeralCleanupClass;
  apply?: boolean;
  now?: Date;
  runtimeGraceMs?: number;
  adherenceRetentionMs?: number;
  maxRemovals?: number;
  isProcessAlive?: (pid: number) => boolean;
  getProcessStartedAt?: (pid: number) => string | null;
  loadRegistry?: () => ReturnType<typeof loadSessionRegistry>;
  removeFile?: (filePath: string) => void;
}

export interface EphemeralCleanupReport {
  schemaVersion: 'ephemeral-cleanup-v1';
  mode: 'preview' | 'apply';
  scanned: number;
  candidates: number;
  protected: number;
  malformed: number;
  removed: number;
  failures: number;
  candidateBytes: number;
  reclaimedBytes: number;
  byClass: Record<'runtime' | 'adherence', {
    scanned: number;
    candidates: number;
    removed: number;
    failures: number;
  }>;
  samples: Array<{ opaqueId: string; targetClass: 'runtime' | 'adherence'; reason: string }>;
  recoverable: false;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function cleanupEphemeralState(options: EphemeralCleanupOptions = {}): EphemeralCleanupReport {
  const homeDir = options.homeDir ?? os.homedir();
  const memoryRoot = path.resolve(options.memoryRoot ?? path.join(homeDir, '.claude-code', 'memory'));
  assertSafeMemoryRoot(memoryRoot, homeDir);
  const nowMs = requireFiniteTime(options.now ?? new Date(), 'cleanup now');
  const runtimeGraceMs = requireNonNegativeDuration(options.runtimeGraceMs ?? DAY_MS, 'runtime grace');
  const adherenceRetentionMs = requireNonNegativeDuration(
    options.adherenceRetentionMs ?? 14 * DAY_MS,
    'adherence retention'
  );
  const maxRemovals = requireNonNegativeInteger(options.maxRemovals ?? 1_000, 'maximum removals');
  const targetClass = options.targetClass ?? 'all';
  const loadRegistry = options.loadRegistry ?? (() => loadSessionRegistry({ homeDir }));
  const registry = loadRegistry();
  const report: EphemeralCleanupReport = {
    schemaVersion: 'ephemeral-cleanup-v1',
    mode: options.apply ? 'apply' : 'preview',
    scanned: 0,
    candidates: 0,
    protected: 0,
    malformed: 0,
    removed: 0,
    failures: 0,
    candidateBytes: 0,
    reclaimedBytes: 0,
    byClass: {
      runtime: { scanned: 0, candidates: 0, removed: 0, failures: 0 },
      adherence: { scanned: 0, candidates: 0, removed: 0, failures: 0 }
    },
    samples: [],
    recoverable: false
  };
  if (targetClass === 'runtime' || targetClass === 'all') {
    scanRuntimeFiles(report, path.join(memoryRoot, 'runtime-resources'), {
      apply: options.apply === true,
      nowMs,
      graceMs: runtimeGraceMs,
      maxRemovals,
      isProcessAlive: options.isProcessAlive ?? defaultIsProcessAlive,
      getProcessStartedAt: options.getProcessStartedAt ?? (() => null),
      removeFile: options.removeFile ?? fs.unlinkSync
    });
  }
  if (targetClass === 'adherence' || targetClass === 'all') {
    scanAdherenceFiles(report, memoryRoot, {
      apply: options.apply === true,
      nowMs,
      retentionMs: adherenceRetentionMs,
      maxRemovals,
      registry,
      loadRegistry,
      removeFile: options.removeFile ?? fs.unlinkSync
    });
  }
  return report;
}

function scanRuntimeFiles(
  report: EphemeralCleanupReport,
  directory: string,
  options: {
    apply: boolean;
    nowMs: number;
    graceMs: number;
    maxRemovals: number;
    isProcessAlive: (pid: number) => boolean;
    getProcessStartedAt: (pid: number) => string | null;
    removeFile: (filePath: string) => void;
  }
): void {
  for (const file of directOwnedFiles(directory, /^process-(\d+)\.json$/)) {
    report.scanned += 1;
    report.byClass.runtime.scanned += 1;
    const parsed = readJson(file.path);
    const pid = Number((parsed as Record<string, unknown> | null)?.pid);
    const updatedAt = Date.parse(String((parsed as Record<string, unknown> | null)?.updatedAt ?? ''));
    const startedAt = Date.parse(String((parsed as Record<string, unknown> | null)?.startedAt ?? ''));
    const stoppedAt = Date.parse(String((parsed as Record<string, unknown> | null)?.stoppedAt ?? ''));
    if (
      !parsed
      || !Number.isSafeInteger(pid)
      || pid <= 0
      || pid !== Number(file.match[1])
      || !Number.isFinite(updatedAt)
      || !Number.isFinite(startedAt)
    ) {
      markProtected(report, true);
      addSample(report, file.path, 'runtime', 'malformed');
      continue;
    }
    if (runtimeOwnerIsLive(pid, startedAt, options)) {
      markProtected(report, false);
      continue;
    }
    const confirmedExitAt = Number.isFinite(stoppedAt) ? stoppedAt : updatedAt;
    if (options.nowMs - confirmedExitAt < options.graceMs) {
      markProtected(report, false);
      continue;
    }
    if (removalAttempts(report) >= options.maxRemovals) {
      markProtected(report, false);
      addSample(report, file.path, 'runtime', 'removal_cap');
      continue;
    }
    const ownerBecameLive = options.apply && runtimeOwnerIsLive(pid, startedAt, options);
    if (options.apply && (ownerBecameLive || !isUnchangedOwnedFile(file))) {
      markProtected(report, false);
      addSample(report, file.path, 'runtime', 'changed_during_scan');
      continue;
    }
    markCandidate(report, file, 'runtime', 'dead_process_outside_grace', options.apply, options.removeFile);
  }
}

function scanAdherenceFiles(
  report: EphemeralCleanupReport,
  memoryRoot: string,
  options: {
    apply: boolean;
    nowMs: number;
    retentionMs: number;
    maxRemovals: number;
    registry: ReturnType<typeof loadSessionRegistry>;
    loadRegistry: () => ReturnType<typeof loadSessionRegistry>;
    removeFile: (filePath: string) => void;
  }
): void {
  const staleCandidates: Array<{
    file: DirectOwnedFile;
    sessionId: string;
    projectHash: string;
  }> = [];
  for (const file of directOwnedFiles(memoryRoot, /^\.adherence-state-(.+)\.json$/)) {
    report.scanned += 1;
    report.byClass.adherence.scanned += 1;
    const parsed = readJson(file.path) as Record<string, unknown> | null;
    const sessionId = typeof parsed?.sessionId === 'string' ? parsed.sessionId : '';
    const updatedAt = Date.parse(String(parsed?.updatedAt ?? ''));
    if (!parsed || !sessionId || sessionId !== file.match[1] || !Number.isFinite(updatedAt)) {
      markProtected(report, true);
      addSample(report, file.path, 'adherence', 'malformed');
      continue;
    }
    const registryEntry = options.registry.sessions[sessionId];
    const lastSeenAt = Date.parse(registryEntry?.lastSeenAt ?? registryEntry?.registeredAt ?? '');
    if (
      !registryEntry?.terminal
      || (Number.isFinite(lastSeenAt) && options.nowMs - lastSeenAt < options.retentionMs)
      || options.nowMs - updatedAt < options.retentionMs
    ) {
      markProtected(report, false);
      continue;
    }
    staleCandidates.push({ file, sessionId, projectHash: registryEntry.projectHash });
  }

  const eventProtection = findRecentEventSessions(
    memoryRoot,
    staleCandidates,
    new Date(options.nowMs - options.retentionMs).toISOString()
  );
  for (const { file, sessionId } of staleCandidates) {
    if (eventProtection.recent.has(sessionId) || eventProtection.unknown.has(sessionId)) {
      markProtected(report, false);
      if (eventProtection.unknown.has(sessionId)) {
        addSample(report, file.path, 'adherence', 'recent_events_unavailable');
      }
      continue;
    }
    if (removalAttempts(report) >= options.maxRemovals) {
      markProtected(report, false);
      addSample(report, file.path, 'adherence', 'removal_cap');
      continue;
    }
    if (options.apply && !adherenceCandidateStillStale(
      file,
      sessionId,
      options.loadRegistry(),
      options.nowMs,
      options.retentionMs
    )) {
      markProtected(report, false);
      addSample(report, file.path, 'adherence', 'changed_during_scan');
      continue;
    }
    markCandidate(report, file, 'adherence', 'terminal_outside_retention', options.apply, options.removeFile);
  }
}

function findRecentEventSessions(
  memoryRoot: string,
  candidates: Array<{ sessionId: string; projectHash: string }>,
  cutoffIso: string
): { recent: Set<string>; unknown: Set<string> } {
  const recent = new Set<string>();
  const unknown = new Set<string>();
  if (candidates.length === 0) return { recent, unknown };

  const sessionsByDatabase = new Map<string, Set<string>>();
  const allSessionIds = new Set(candidates.map((candidate) => candidate.sessionId));
  sessionsByDatabase.set(path.join(memoryRoot, 'events.sqlite'), allSessionIds);
  for (const candidate of candidates) {
    if (!/^[a-f0-9]{8}$/.test(candidate.projectHash)) {
      unknown.add(candidate.sessionId);
      continue;
    }
    const dbPath = path.join(memoryRoot, 'projects', candidate.projectHash, 'events.sqlite');
    const sessions = sessionsByDatabase.get(dbPath) ?? new Set<string>();
    sessions.add(candidate.sessionId);
    sessionsByDatabase.set(dbPath, sessions);
  }

  for (const [databasePath, sessionIds] of sessionsByDatabase) {
    if (!fs.existsSync(databasePath)) continue;
    if (!isOwnedRegularFile(memoryRoot, databasePath)) {
      for (const sessionId of sessionIds) unknown.add(sessionId);
      continue;
    }
    let db: ReturnType<typeof createSQLiteDatabase> | null = null;
    try {
      db = createSQLiteDatabase(databasePath, {
        readonly: true,
        snapshot: true,
        canonicalMemoryRoot: memoryRoot
      });
      const eventsTable = sqliteGet<{ name: string }>(
        db,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'"
      );
      if (!eventsTable) continue;
      const ids = [...sessionIds];
      for (let offset = 0; offset < ids.length; offset += 400) {
        const chunk = ids.slice(offset, offset + 400);
        const placeholders = chunk.map(() => '?').join(', ');
        const rows = sqliteAll<{ session_id: string }>(
          db,
          `SELECT DISTINCT session_id FROM events
           WHERE session_id IN (${placeholders})
             AND datetime(timestamp) >= datetime(?)`,
          [...chunk, cutoffIso]
        );
        for (const row of rows) {
          if (typeof row.session_id === 'string') recent.add(row.session_id);
        }
      }
    } catch {
      // Cleanup is destructive: if recent-event liveness cannot be verified,
      // preserve every adherence file that depended on this store.
      for (const sessionId of sessionIds) unknown.add(sessionId);
    } finally {
      if (db) sqliteClose(db);
    }
  }
  return { recent, unknown };
}

function isOwnedRegularFile(memoryRoot: string, filePath: string): boolean {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const relative = path.relative(fs.realpathSync(memoryRoot), fs.realpathSync(filePath));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

interface DirectOwnedFile {
  path: string;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  match: RegExpMatchArray;
}

function directOwnedFiles(directory: string, pattern: RegExp): DirectOwnedFile[] {
  assertOwnedDirectoryIfPresent(directory);
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .flatMap((entry) => {
        const match = entry.name.match(pattern);
        if (!entry.isFile() || entry.isSymbolicLink() || !match) return [];
        const filePath = path.join(directory, entry.name);
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) return [];
        return [{
          path: filePath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          dev: stat.dev,
          ino: stat.ino,
          match
        }];
      });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
}

function runtimeOwnerIsLive(
  pid: number,
  recordedStartedAt: number,
  options: {
    isProcessAlive: (pid: number) => boolean;
    getProcessStartedAt: (pid: number) => string | null;
  }
): boolean {
  if (!options.isProcessAlive(pid)) return false;
  const liveStartedAt = Date.parse(options.getProcessStartedAt(pid) ?? '');
  return !Number.isFinite(liveStartedAt) || Math.abs(liveStartedAt - recordedStartedAt) < 1_000;
}

function adherenceCandidateStillStale(
  file: DirectOwnedFile,
  sessionId: string,
  registry: ReturnType<typeof loadSessionRegistry>,
  nowMs: number,
  retentionMs: number
): boolean {
  if (!isUnchangedOwnedFile(file)) return false;
  const parsed = readJson(file.path) as Record<string, unknown> | null;
  const updatedAt = Date.parse(String(parsed?.updatedAt ?? ''));
  if (!parsed || parsed.sessionId !== sessionId || !Number.isFinite(updatedAt)) return false;
  const entry = registry.sessions[sessionId];
  const lastSeenAt = Date.parse(entry?.lastSeenAt ?? entry?.registeredAt ?? '');
  return entry?.terminal === true
    && (!Number.isFinite(lastSeenAt) || nowMs - lastSeenAt >= retentionMs)
    && nowMs - updatedAt >= retentionMs
    && isUnchangedOwnedFile(file);
}

function isUnchangedOwnedFile(file: DirectOwnedFile): boolean {
  try {
    const current = fs.lstatSync(file.path);
    return current.isFile()
      && !current.isSymbolicLink()
      && current.size === file.size
      && current.mtimeMs === file.mtimeMs
      && current.dev === file.dev
      && current.ino === file.ino;
  } catch {
    return false;
  }
}

function removalAttempts(report: EphemeralCleanupReport): number {
  return report.removed + report.failures;
}

function markCandidate(
  report: EphemeralCleanupReport,
  file: { path: string; size: number },
  targetClass: 'runtime' | 'adherence',
  reason: string,
  apply: boolean,
  removeFile: (filePath: string) => void
): void {
  report.candidates += 1;
  report.candidateBytes += file.size;
  report.byClass[targetClass].candidates += 1;
  addSample(report, file.path, targetClass, reason);
  if (!apply) return;
  try {
    removeFile(file.path);
    report.removed += 1;
    report.reclaimedBytes += file.size;
    report.byClass[targetClass].removed += 1;
  } catch {
    report.failures += 1;
    report.byClass[targetClass].failures += 1;
    addSample(report, file.path, targetClass, 'delete_failed');
  }
}

function markProtected(report: EphemeralCleanupReport, malformed: boolean): void {
  report.protected += 1;
  if (malformed) report.malformed += 1;
}

function addSample(
  report: EphemeralCleanupReport,
  filePath: string,
  targetClass: 'runtime' | 'adherence',
  reason: string
): void {
  if (report.samples.length >= 20) return;
  report.samples.push({
    opaqueId: createHash('sha256').update(path.basename(filePath)).digest('hex').slice(0, 12),
    targetClass,
    reason
  });
}

function readJson(filePath: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function requireFiniteTime(value: Date, label: string): number {
  const timestamp = value.getTime();
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be a valid date`);
  return timestamp;
}

function requireNonNegativeDuration(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative duration`);
  }
  return value;
}

function requireNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function assertSafeMemoryRoot(memoryRoot: string, homeDir: string): void {
  const resolvedHome = path.resolve(homeDir);
  const expected = path.join(resolvedHome, '.claude-code', 'memory');
  if (memoryRoot !== expected || memoryRoot === resolvedHome || path.dirname(memoryRoot) === memoryRoot) {
    throw new Error('cleanup requires the exact CML-owned memory root');
  }
  assertOwnedDirectoryIfPresent(memoryRoot);
}

function assertOwnedDirectoryIfPresent(directory: string): void {
  if (!fs.existsSync(directory)) return;
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('cleanup owned root must be a non-symlink directory');
  }
}
