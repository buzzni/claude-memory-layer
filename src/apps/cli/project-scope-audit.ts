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
  groupByProject?: boolean;
}

export interface ProjectScopeAuditGroup {
  canonicalProjectHash: string;
  projectLabel: string;
  identityKind: 'memory-root-marker' | 'git-common-dir' | 'path-fallback' | 'unknown';
  correctlyScopedSessions: number;
  staleRegistrySessions: number;
  unregisteredSessions: number;
  mismatchedSessions: number;
  duplicateSessions: number;
  mismatchedEvents: number;
  candidateStoreHashes: string[];
  recommendedAction: 'none' | 'inspect-registry' | 'preview-consolidation';
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
  groups?: ProjectScopeAuditGroup[];
}

export interface ProjectScopeAuditWindowsReport {
  schemaVersion: 'project-scope-audit-windows-v1';
  mode: 'read-only';
  windows: ProjectScopeAuditReport[];
}

export interface ProjectScopeAuditDeps {
  discoverStoreSessions?: (options: { homeDir: string; days: number }) => {
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
    days: parseProjectScopeAuditDays(options.days),
    groupByProject: options.groupByProject === true
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
  const groups = new Map<string, ProjectScopeAuditGroup>();

  for (const [sessionId, rows] of bySession) {
    const entry = registry.sessions[sessionId];
    if (rows.length > 1) duplicateSessionCount += 1;
    if (!entry) {
      unregisteredSessionCount += 1;
      if (resolved.groupByProject) {
        const unknown = groupFor(groups, '__unregistered__', 'unknown');
        unknown.unregisteredSessions += 1;
        if (rows.length > 1) unknown.duplicateSessions += 1;
        addCandidateStores(unknown, rows);
        unknown.recommendedAction = 'inspect-registry';
      }
      continue;
    }

    let canonical = canonicalByPath.get(entry.projectPath);
    if (!canonical) {
      canonical = canonicalHash(entry.projectPath);
      canonicalByPath.set(entry.projectPath, canonical);
    }
    const staleRegistry = canonical !== entry.projectHash;
    if (staleRegistry) staleRegistrySessionCount += 1;
    const group = resolved.groupByProject
      ? groupFor(groups, canonical, entry.identityKind ?? 'unknown')
      : undefined;
    if (group && staleRegistry) group.staleRegistrySessions += 1;
    if (group && rows.length > 1) group.duplicateSessions += 1;

    const mismatchedRows = rows.filter((row) => row.storeHash !== canonical);
    if (mismatchedRows.length > 0) {
      mismatchedSessionCount += 1;
      mismatchedEventCount += mismatchedRows.reduce((sum, row) => sum + row.eventCount, 0);
      if (group) {
        group.mismatchedSessions += 1;
        group.mismatchedEvents += mismatchedRows.reduce((sum, row) => sum + row.eventCount, 0);
        addCandidateStores(group, mismatchedRows);
        group.recommendedAction = 'preview-consolidation';
      }
    }
    if (!staleRegistry && rows.length === 1 && mismatchedRows.length === 0) {
      correctlyScopedSessionCount += 1;
      if (group) group.correctlyScopedSessions += 1;
    } else if (group && group.recommendedAction === 'none') {
      group.recommendedAction = 'inspect-registry';
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
    mismatchedEventCount,
    ...(resolved.groupByProject
      ? { groups: Array.from(groups.values()).sort((a, b) => a.canonicalProjectHash.localeCompare(b.canonicalProjectHash)) }
      : {})
  };
}

export function auditProjectScopeWindows(
  options: Omit<ProjectScopeAuditOptions, 'days'> = {},
  deps: ProjectScopeAuditDeps = {}
): ProjectScopeAuditWindowsReport {
  return {
    schemaVersion: 'project-scope-audit-windows-v1',
    mode: 'read-only',
    windows: [1, 7, 14, 30].map((days) => auditProjectScope({ ...options, days }, deps))
  };
}

export function formatProjectScopeAudit(report: ProjectScopeAuditReport): string {
  const lines = [
    `Project scope audit (${report.days} days, read-only)`,
    `Stores scanned: ${report.scannedStoreCount}`,
    `Unreadable stores: ${report.unreadableStoreCount}`,
    `Recent sessions: ${report.recentSessionCount}`,
    `Correctly scoped sessions: ${report.correctlyScopedSessionCount}`,
    `Stale registry sessions: ${report.staleRegistrySessionCount}`,
    `Unregistered sessions: ${report.unregisteredSessionCount}`,
    `Mismatched sessions: ${report.mismatchedSessionCount}`,
    `Duplicate sessions: ${report.duplicateSessionCount}`,
    `Events in non-canonical stores: ${report.mismatchedEventCount}`
  ];
  if (report.groups) {
    lines.push('Project groups:');
    for (const group of report.groups) {
      lines.push(
        `- ${group.projectLabel} identity=${group.identityKind} correct=${group.correctlyScopedSessions}`
        + ` stale=${group.staleRegistrySessions} unregistered=${group.unregisteredSessions}`
        + ` mismatched=${group.mismatchedSessions}/${group.mismatchedEvents}`
        + ` duplicate=${group.duplicateSessions} candidates=${group.candidateStoreHashes.join(',') || 'none'}`
        + ` action=${group.recommendedAction}`
      );
    }
  }
  lines.push('No project stores or registry entries were changed.');
  return lines.join('\n');
}

function discoverProjectStoreSessions(options: { homeDir: string; days: number }): {
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

  if (!isLocalDirectory(memoryRoot)) {
    return {
      rows,
      scannedStoreCount,
      unreadableStoreCount: fs.existsSync(memoryRoot) ? 1 : 0
    };
  }

  const globalDbPath = path.join(memoryRoot, 'events.sqlite');
  if (isLocalFile(globalDbPath)) {
    stores.push({ storeHash: '__global__', dbPath: globalDbPath });
  }

  let entries: fs.Dirent[] = [];
  if (fs.existsSync(projectsRoot) && !isLocalDirectory(projectsRoot)) {
    unreadableStoreCount += 1;
  } else {
    try {
      entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
    } catch {
      entries = [];
    }
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
      db = createSQLiteDatabase(store.dbPath, {
        readonly: true,
        snapshot: true,
        canonicalMemoryRoot: memoryRoot
      });
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

function groupFor(
  groups: Map<string, ProjectScopeAuditGroup>,
  canonicalProjectHash: string,
  identityKind: ProjectScopeAuditGroup['identityKind']
): ProjectScopeAuditGroup {
  let group = groups.get(canonicalProjectHash);
  if (!group) {
    group = {
      canonicalProjectHash,
      projectLabel: canonicalProjectHash === '__unregistered__' ? 'unregistered' : `project-${canonicalProjectHash}`,
      identityKind,
      correctlyScopedSessions: 0,
      staleRegistrySessions: 0,
      unregisteredSessions: 0,
      mismatchedSessions: 0,
      duplicateSessions: 0,
      mismatchedEvents: 0,
      candidateStoreHashes: [],
      recommendedAction: 'none'
    };
    groups.set(canonicalProjectHash, group);
  }
  return group;
}

function addCandidateStores(group: ProjectScopeAuditGroup, rows: ProjectScopeStoreSession[]): void {
  group.candidateStoreHashes = Array.from(new Set([
    ...group.candidateStoreHashes,
    ...rows.map((row) => row.storeHash)
  ])).sort();
}

function isLocalFile(file: string): boolean {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

function isLocalDirectory(directory: string): boolean {
  try {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}
