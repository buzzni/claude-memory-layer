import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  auditProjectScope,
  auditProjectScopeWindows,
  formatProjectScopeAudit,
  parseProjectScopeAuditDays
} from '../../src/apps/cli/project-scope-audit.js';
import type { SessionRegistry } from '../../src/core/registry/session-registry.js';
import { hashProjectPath } from '../../src/core/registry/project-path.js';
import { createSQLiteDatabase, sqliteClose, sqliteExec } from '../../src/core/sqlite-wrapper.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('project scope audit', () => {
  it('validates bounded audit windows', () => {
    expect(parseProjectScopeAuditDays(undefined)).toBe(7);
    expect(parseProjectScopeAuditDays('30')).toBe(30);
    expect(() => parseProjectScopeAuditDays('0')).toThrow('--days');
    expect(() => parseProjectScopeAuditDays('1.5')).toThrow('--days');
    expect(() => parseProjectScopeAuditDays('invalid')).toThrow('--days');
  });

  it('reports only aggregate stale, missing, mismatched, and duplicate scope state', () => {
    const registry: SessionRegistry = {
      version: 1,
      sessions: {
        good: { projectPath: '/repo/good', projectHash: 'aaaaaaaa', registeredAt: '2026-08-12T00:00:00Z' },
        stale: { projectPath: '/repo/stale', projectHash: 'legacy00', registeredAt: '2026-08-12T00:00:00Z' },
        duplicate: { projectPath: '/repo/duplicate', projectHash: 'cccccccc', registeredAt: '2026-08-12T00:00:00Z' }
      }
    };
    const report = auditProjectScope({ homeDir: '/private/home', days: 7 }, {
      discoverStoreSessions: () => ({
        scannedStoreCount: 4,
        unreadableStoreCount: 1,
        rows: [
          { storeHash: 'aaaaaaaa', sessionId: 'good', eventCount: 10 },
          { storeHash: 'bbbbbbbb', sessionId: 'stale', eventCount: 3 },
          { storeHash: 'dddddddd', sessionId: 'missing', eventCount: 2 },
          { storeHash: 'cccccccc', sessionId: 'duplicate', eventCount: 5 },
          { storeHash: 'eeeeeeee', sessionId: 'duplicate', eventCount: 4 }
        ]
      }),
      loadRegistry: () => registry,
      canonicalHash: (projectPath) => ({
        '/repo/good': 'aaaaaaaa',
        '/repo/stale': 'bbbbbbbb',
        '/repo/duplicate': 'cccccccc'
      })[projectPath] ?? 'ffffffff'
    });

    expect(report).toEqual({
      schemaVersion: 'project-scope-audit-v1',
      mode: 'read-only',
      days: 7,
      scannedStoreCount: 4,
      unreadableStoreCount: 1,
      recentSessionCount: 4,
      correctlyScopedSessionCount: 1,
      staleRegistrySessionCount: 1,
      unregisteredSessionCount: 1,
      mismatchedSessionCount: 1,
      duplicateSessionCount: 1,
      mismatchedEventCount: 4
    });
    const output = formatProjectScopeAudit(report);
    expect(output).toContain('No project stores or registry entries were changed.');
    expect(output).not.toContain('/private/home');
    expect(output).not.toContain('good');
  });

  it('groups discrepancies by sanitized project identity without session ids or paths', () => {
    const registry: SessionRegistry = {
      version: 2,
      sessions: {
        affected: {
          projectPath: '/private/repo',
          projectHash: 'aaaaaaaa',
          registeredAt: '2026-08-12T00:00:00Z',
          lastSeenAt: '2026-08-12T00:00:00Z',
          identityKind: 'git-common-dir'
        }
      }
    };
    const report = auditProjectScope({ days: 7, groupByProject: true }, {
      discoverStoreSessions: () => ({
        scannedStoreCount: 1,
        unreadableStoreCount: 0,
        rows: [{ storeHash: 'bbbbbbbb', sessionId: 'affected', eventCount: 9 }]
      }),
      loadRegistry: () => registry,
      canonicalHash: () => 'aaaaaaaa'
    });

    expect(report.groups).toEqual([expect.objectContaining({
      canonicalProjectHash: 'aaaaaaaa',
      projectLabel: 'project-aaaaaaaa',
      mismatchedSessions: 1,
      mismatchedEvents: 9,
      candidateStoreHashes: ['bbbbbbbb'],
      recommendedAction: 'preview-consolidation'
    })]);
    expect(JSON.stringify(report)).not.toContain('affected');
    expect(JSON.stringify(report)).not.toContain('/private/repo');
    const output = formatProjectScopeAudit(report);
    expect(output).toContain('project-aaaaaaaa');
    expect(output).toContain('candidates=bbbbbbbb');
    expect(output).toContain('action=preview-consolidation');
    expect(output).not.toContain('affected');
    expect(output).not.toContain('/private/repo');
  });

  it('exposes the standard 1, 7, 14, and 30 day windows', () => {
    const windows = auditProjectScopeWindows({}, {
      discoverStoreSessions: ({ days }) => ({
        scannedStoreCount: days,
        unreadableStoreCount: 0,
        rows: []
      }),
      loadRegistry: () => ({ version: 2, sessions: {} })
    });
    expect(windows.windows.map((window) => window.days)).toEqual([1, 7, 14, 30]);
    expect(windows.windows.map((window) => window.scannedStoreCount)).toEqual([1, 7, 14, 30]);
  });

  it('includes sessions incorrectly routed to the global store', () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-scope-audit-global-'));
    tempDirs.push(homeDir);
    const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
    mkdirSync(memoryRoot, { recursive: true });
    const db = createSQLiteDatabase(path.join(memoryRoot, 'events.sqlite'));
    sqliteExec(db, `
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );
      INSERT INTO events (id, session_id, timestamp)
      VALUES ('event-1', 'global-session', datetime('now'));
    `);
    sqliteClose(db);

    const projectPath = path.join(homeDir, 'repo');
    writeFileSync(path.join(memoryRoot, 'session-registry.json'), JSON.stringify({
      version: 1,
      sessions: {
        'global-session': {
          projectPath,
          projectHash: hashProjectPath(projectPath),
          registeredAt: '2026-08-12T00:00:00Z'
        }
      }
    }));

    expect(auditProjectScope({ homeDir, days: 7 })).toMatchObject({
      scannedStoreCount: 1,
      recentSessionCount: 1,
      mismatchedSessionCount: 1,
      mismatchedEventCount: 1
    });
  });

  it('does not scan through a symlinked projects root', () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-scope-audit-symlink-'));
    tempDirs.push(homeDir);
    const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
    const outside = path.join(homeDir, 'outside-projects');
    mkdirSync(memoryRoot, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, path.join(memoryRoot, 'projects'));

    expect(auditProjectScope({ homeDir })).toMatchObject({
      scannedStoreCount: 0,
      unreadableStoreCount: 1,
      recentSessionCount: 0
    });
  });
});
