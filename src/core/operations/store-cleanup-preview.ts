import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadSessionRegistry } from '../registry/session-registry.js';
import { createSQLiteDatabase, sqliteClose, sqliteGet } from '../sqlite-wrapper.js';

export type StoreCleanupClassification = 'temp' | 'unattributed';

export interface StoreCleanupPreviewOptions {
  homeDir?: string;
  memoryRoot?: string;
  classification: StoreCleanupClassification;
  now?: Date;
  minimumAgeMs?: number;
}

export interface StoreCleanupPreviewReport {
  schemaVersion: 'store-cleanup-preview-v1';
  dryRun: true;
  classification: StoreCleanupClassification;
  scanned: number;
  candidates: number;
  protected: number;
  candidateBytes: number;
  samples: Array<{ opaqueId: string; classification: StoreCleanupClassification; reasons: string[] }>;
  action: 'review' | 'quarantine_candidate';
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function previewStoreCleanup(options: StoreCleanupPreviewOptions): StoreCleanupPreviewReport {
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const memoryRoot = path.resolve(options.memoryRoot ?? path.join(homeDir, '.claude-code', 'memory'));
  if (memoryRoot !== path.join(homeDir, '.claude-code', 'memory')) {
    throw new Error('store cleanup preview requires the exact CML-owned memory root');
  }
  assertOwnedDirectoryIfPresent(memoryRoot);
  const nowMs = (options.now ?? new Date()).getTime();
  const minimumAgeMs = options.minimumAgeMs ?? 30 * DAY_MS;
  const registry = loadSessionRegistry({ homeDir });
  const activeHashes = new Set(Object.values(registry.sessions)
    .filter((entry) => !entry.terminal)
    .map((entry) => entry.projectHash));
  const pathsByHash = new Map<string, string[]>();
  for (const entry of Object.values(registry.sessions)) {
    const paths = pathsByHash.get(entry.projectHash) ?? [];
    paths.push(entry.projectPath);
    pathsByHash.set(entry.projectHash, paths);
  }

  const report: StoreCleanupPreviewReport = {
    schemaVersion: 'store-cleanup-preview-v1',
    dryRun: true,
    classification: options.classification,
    scanned: 0,
    candidates: 0,
    protected: 0,
    candidateBytes: 0,
    samples: [],
    action: options.classification === 'temp' ? 'quarantine_candidate' : 'review'
  };

  for (const entry of directProjectStores(path.join(memoryRoot, 'projects'))) {
    report.scanned += 1;
    const reasons: string[] = [];
    const registeredPaths = pathsByHash.get(entry.projectHash) ?? [];
    const latestEventAt = readLatestEventAt(path.join(entry.storePath, 'events.sqlite'), memoryRoot);
    const oldEnough = latestEventAt !== null && nowMs - latestEventAt >= minimumAgeMs;
    const liveLock = ['vector-worker.lock', 'summary-worker.lock', 'retention-lifecycle.lock']
      .some((name) => fs.existsSync(path.join(entry.storePath, name)));

    if (activeHashes.has(entry.projectHash)) reasons.push('active_registry_reference');
    if (liveLock) reasons.push('live_lock_present');
    if (latestEventAt !== null && !oldEnough) reasons.push('recent_events');

    let matches = false;
    if (options.classification === 'unattributed') {
      matches = registeredPaths.length === 0;
      if (matches) reasons.push('no_identity_attribution');
    } else {
      const tempRootSignal = registeredPaths.some((projectPath) => isInside(projectPath, os.tmpdir()));
      const fixtureSignal = registeredPaths.some((projectPath) => /(?:^|[-_.\/])(test|tests|fixture|e2e|tmp|temp)(?:$|[-_.\/])/i.test(projectPath));
      const inactiveSignal = !activeHashes.has(entry.projectHash);
      const signalCount = Number(tempRootSignal) + Number(fixtureSignal) + Number(inactiveSignal) + Number(oldEnough);
      if (tempRootSignal) reasons.push('temp_root_identity');
      if (fixtureSignal) reasons.push('fixture_identity');
      if (inactiveSignal) reasons.push('no_active_registry_reference');
      if (oldEnough) reasons.push('outside_retention');
      matches = registeredPaths.length > 0 && signalCount >= 2;
    }

    const protectedStore = activeHashes.has(entry.projectHash) || liveLock || !oldEnough;
    if (!matches || protectedStore) {
      report.protected += 1;
      continue;
    }
    report.candidates += 1;
    report.candidateBytes += directoryBytes(entry.storePath);
    if (report.samples.length < 20) {
      report.samples.push({
        opaqueId: createHash('sha256').update(entry.projectHash).digest('hex').slice(0, 12),
        classification: options.classification,
        reasons: reasons.filter((reason) => !reason.startsWith('active_') && !reason.startsWith('live_'))
      });
    }
  }
  return report;
}

function directProjectStores(projectsRoot: string): Array<{ projectHash: string; storePath: string }> {
  assertOwnedDirectoryIfPresent(projectsRoot);
  try {
    return fs.readdirSync(projectsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && /^[a-f0-9]{8}$/.test(entry.name))
      .map((entry) => ({ projectHash: entry.name, storePath: path.join(projectsRoot, entry.name) }));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
}

function assertOwnedDirectoryIfPresent(directory: string): void {
  if (!fs.existsSync(directory)) return;
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('store cleanup root must be a non-symlink directory');
  }
}

function readLatestEventAt(dbPath: string, memoryRoot: string): number | null {
  if (!fs.existsSync(dbPath) || fs.lstatSync(dbPath).isSymbolicLink()) return null;
  let db;
  try {
    db = createSQLiteDatabase(dbPath, {
      readonly: true,
      snapshot: true,
      canonicalMemoryRoot: memoryRoot,
      walMode: false
    });
    const row = sqliteGet<{ timestamp: string | null }>(db, 'SELECT MAX(timestamp) AS timestamp FROM events');
    const parsed = Date.parse(row?.timestamp ?? '');
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  } finally {
    if (db) sqliteClose(db);
  }
}

function directoryBytes(directory: string): number {
  let total = 0;
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
      } else if (stat.isFile()) {
        total += stat.size;
      }
    } catch {
      // A concurrently removed or unreadable entry contributes no recoverable bytes.
      continue;
    }
  }
  return total;
}

function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
