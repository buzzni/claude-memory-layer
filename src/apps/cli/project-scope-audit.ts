import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createSQLiteDatabase, sqliteAll, sqliteClose } from '../../core/sqlite-wrapper.js';
import { hashProjectPath } from '../../core/registry/project-path.js';
import { loadSessionRegistry, type SessionRegistry } from '../../core/registry/session-registry.js';

export interface ProjectScopeStoreSession {
  storeHash: string;
  sessionId: string;
  eventCount: number;
}

export interface ProjectScopeAuditOptions {
  homeDir?: string;
  days?: number;
}

export interface ProjectScopeAuditReport {
  schemaVersion: 'project-scope-audit-v1';
  mode: 'read-only';
  days: number;
  scannedStoreCount: number;
  unreadableStoreCount: number;
  recentSessionCount: number;
  correctlyScopedSessionCount: number;
  staleRegistrySessionCount: number;
  unregisteredSessionCount: number;
  mismatchedSessionCount: number;
  duplicateSessionCount: number;
  mismatchedEventCount: number;
}

export interface ProjectScopeAuditDeps {
  discoverStoreSessions?: (options: Required<ProjectScopeAuditOptions>) => {
    rows: ProjectScopeStoreSession[];
    scannedStoreCount: number;
    unreadableStoreCount: number;
  };
  loadRegistry?: (homeDir: string) => SessionRegistry;
  canonicalHash?: (projectPath: string) => string;
}

export function parseProjectScopeAuditDays(value: string | number | undefined): number {
  if (value === undefined) return 7;
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 365) {
    throw new Error('--days must be an integer between 1 and 365');
  }
  return parsed;
}

export function auditProjectScope(
  options: ProjectScopeAuditOptions = {},
  deps: ProjectScopeAuditDeps = {}
): ProjectScopeAuditReport {
  const resolved = {
    homeDir: options.homeDir ?? os.homedir(),
    days: parseProjectScopeAuditDays(options.days)
  };
  const discovered = (deps.discoverStoreSessions ?? discoverProjectStoreSessions)(resolved);
  const registry = (deps.loadRegistry ?? ((homeDir) => loadSessionRegistry({ homeDir })))(resolved.homeDir);
  const canonicalHash = deps.canonicalHash ?? hashProjectPath;
  const bySession = new Map<string, ProjectScopeStoreSession[]>();
  for (const row of discovered.rows) {
    const existing = bySession.get(row.sessionId) ?? [];
    existing.push(row);
    bySession.set(row.sessionId, existing);
  }

  const canonicalByPath = new Map<string, string>();
  let correctlyScopedSessionCount = 0;
  let staleRegistrySessionCount = 0;
  let unregisteredSessionCount = 0;
  let mismatchedSessionCount = 0;
  let duplicateSessionCount = 0;
  let mismatchedEventCount = 0;

  for (const [sessionId, rows] of bySession) {
    const entry = registry.sessions[sessionId];
    if (rows.length > 1) duplicateSessionCount += 1;
    if (!entry) {
      unregisteredSessionCount += 1;
      continue;
    }

    let canonical = canonicalByPath.get(entry.projectPath);
    if (!canonical) {
      canonical = canonicalHash(entry.projectPath);
      canonicalByPath.set(entry.projectPath, canonical);
    }
    const staleRegistry = canonical !== entry.projectHash;
    if (staleRegistry) staleRegistrySessionCount += 1;

    const mismatchedRows = rows.filter((row) => row.storeHash !== canonical);
    if (mismatchedRows.length > 0) {
      mismatchedSessionCount += 1;
      mismatchedEventCount += mismatchedRows.reduce((sum, row) => sum + row.eventCount, 0);
    }
    if (!staleRegistry && rows.length === 1 && mismatchedRows.length === 0) {
      correctlyScopedSessionCount += 1;
    }
  }

  return {
    schemaVersion: 'project-scope-audit-v1',
    mode: 'read-only',
    days: resolved.days,
    scannedStoreCount: discovered.scannedStoreCount,
    unreadableStoreCount: discovered.unreadableStoreCount,
    recentSessionCount: bySession.size,
    correctlyScopedSessionCount,
    staleRegistrySessionCount,
    unregisteredSessionCount,
    mismatchedSessionCount,
    duplicateSessionCount,
    mismatchedEventCount
  };
}

export function formatProjectScopeAudit(report: ProjectScopeAuditReport): string {
  return [
    `Project scope audit (${report.days} days, read-only)`,
    `Stores scanned: ${report.scannedStoreCount}`,
    `Unreadable stores: ${report.unreadableStoreCount}`,
    `Recent sessions: ${report.recentSessionCount}`,
    `Correctly scoped sessions: ${report.correctlyScopedSessionCount}`,
    `Stale registry sessions: ${report.staleRegistrySessionCount}`,
    `Unregistered sessions: ${report.unregisteredSessionCount}`,
    `Mismatched sessions: ${report.mismatchedSessionCount}`,
    `Duplicate sessions: ${report.duplicateSessionCount}`,
    `Events in non-canonical stores: ${report.mismatchedEventCount}`,
    'No project stores or registry entries were changed.'
  ].join('\n');
}

function discoverProjectStoreSessions(options: Required<ProjectScopeAuditOptions>): {
  rows: ProjectScopeStoreSession[];
  scannedStoreCount: number;
  unreadableStoreCount: number;
} {
  const memoryRoot = path.join(options.homeDir, '.claude-code', 'memory');
  const projectsRoot = path.join(memoryRoot, 'projects');
  const rows: ProjectScopeStoreSession[] = [];
  const stores: Array<{ storeHash: string; dbPath: string }> = [];
  let scannedStoreCount = 0;
  let unreadableStoreCount = 0;

  const globalDbPath = path.join(memoryRoot, 'events.sqlite');
  if (isLocalFile(globalDbPath)) {
    stores.push({ storeHash: '__global__', dbPath: globalDbPath });
  }

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9]{8}$/.test(entry.name)) continue;
    const dbPath = path.join(projectsRoot, entry.name, 'events.sqlite');
    if (!isLocalFile(dbPath)) continue;
    stores.push({ storeHash: entry.name, dbPath });
  }

  for (const store of stores) {
    scannedStoreCount += 1;
    let db;
    let unreadable = false;
    const storeRows: ProjectScopeStoreSession[] = [];
    try {
      db = createSQLiteDatabase(store.dbPath, { readonly: true, snapshot: true });
      const recent = sqliteAll<{ sessionId: string; eventCount: number }>(
        db,
        `SELECT session_id AS sessionId, COUNT(*) AS eventCount
         FROM events
         WHERE datetime(timestamp) >= datetime('now', ?)
         GROUP BY session_id`,
        [`-${options.days} days`]
      );
      for (const row of recent) {
        storeRows.push({ storeHash: store.storeHash, sessionId: row.sessionId, eventCount: Number(row.eventCount) });
      }
    } catch {
      unreadable = true;
    } finally {
      if (db) {
        try {
          sqliteClose(db);
        } catch {
          unreadable = true;
        }
      }
    }
    if (unreadable) {
      unreadableStoreCount += 1;
    } else {
      rows.push(...storeRows);
    }
  }
  return { rows, scannedStoreCount, unreadableStoreCount };
}

function isLocalFile(file: string): boolean {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}
