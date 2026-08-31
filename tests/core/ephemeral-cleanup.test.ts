import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { cleanupEphemeralState } from '../../src/core/operations/ephemeral-cleanup.js';
import { createSQLiteDatabase, sqliteClose, sqliteExec, sqliteRun } from '../../src/core/sqlite-wrapper.js';

const roots: string[] = [];
const NOW = new Date('2026-08-31T00:00:00.000Z');

function fixture() {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-ephemeral-cleanup-'));
  roots.push(homeDir);
  const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
  const runtimeDir = path.join(memoryRoot, 'runtime-resources');
  mkdirSync(runtimeDir, { recursive: true });
  return { homeDir, memoryRoot, runtimeDir };
}

function runtimeSnapshot(pid: number, updatedAt: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    pid,
    processState: 'running',
    startedAt: '2026-08-01T00:00:00.000Z',
    updatedAt,
    stoppedAt: null,
    ...overrides
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ephemeral cleanup', () => {
  it('preserves live, recent, malformed, and symlinked runtime state', () => {
    const { homeDir, runtimeDir } = fixture();
    writeFileSync(path.join(runtimeDir, 'process-10.json'), JSON.stringify(runtimeSnapshot(10, '2026-08-01T00:00:00.000Z')));
    writeFileSync(path.join(runtimeDir, 'process-11.json'), JSON.stringify(runtimeSnapshot(11, '2026-08-30T12:00:00.000Z')));
    writeFileSync(path.join(runtimeDir, 'process-12.json'), '{broken');
    const outside = path.join(homeDir, 'outside.json');
    writeFileSync(outside, JSON.stringify(runtimeSnapshot(13, '2026-08-01T00:00:00.000Z')));
    symlinkSync(outside, path.join(runtimeDir, 'process-13.json'));

    const report = cleanupEphemeralState({
      homeDir,
      targetClass: 'runtime',
      apply: true,
      now: NOW,
      isProcessAlive: (pid) => pid === 10
    });

    expect(report.removed).toBe(0);
    expect(report.protected).toBe(3);
    expect(report.malformed).toBe(1);
    expect(existsSync(path.join(runtimeDir, 'process-10.json'))).toBe(true);
    expect(existsSync(path.join(runtimeDir, 'process-11.json'))).toBe(true);
    expect(existsSync(path.join(runtimeDir, 'process-12.json'))).toBe(true);
    expect(existsSync(path.join(runtimeDir, 'process-13.json'))).toBe(true);
  });

  it('previews then removes only dead runtime state outside grace and handles PID reuse identity', () => {
    const { homeDir, runtimeDir } = fixture();
    const stale = path.join(runtimeDir, 'process-20.json');
    const reused = path.join(runtimeDir, 'process-21.json');
    writeFileSync(stale, JSON.stringify(runtimeSnapshot(20, '2026-08-01T00:00:00.000Z')));
    writeFileSync(reused, JSON.stringify(runtimeSnapshot(21, '2026-08-01T00:00:00.000Z')));

    const preview = cleanupEphemeralState({
      homeDir,
      targetClass: 'runtime',
      now: NOW,
      isProcessAlive: (pid) => pid === 21,
      getProcessStartedAt: () => '2026-08-30T00:00:00.000Z'
    });
    expect(preview.candidates).toBe(2);
    expect(preview.removed).toBe(0);
    expect(existsSync(stale)).toBe(true);
    expect(existsSync(reused)).toBe(true);

    const applied = cleanupEphemeralState({
      homeDir,
      targetClass: 'runtime',
      apply: true,
      now: NOW,
      isProcessAlive: (pid) => pid === 21,
      getProcessStartedAt: () => '2026-08-30T00:00:00.000Z'
    });
    expect(applied.removed).toBe(2);
    expect(applied.reclaimedBytes).toBeGreaterThan(0);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(reused)).toBe(false);
  });

  it('protects active/recent adherence state and removes terminal old state only after preview', () => {
    const { homeDir, memoryRoot } = fixture();
    const old = '2026-07-01T00:00:00.000Z';
    const recent = '2026-08-30T00:00:00.000Z';
    const registry = {
      version: 2,
      sessions: {
        active: { projectPath: '/repo/a', projectHash: '11111111', registeredAt: old, lastSeenAt: old, terminal: false },
        recent: { projectPath: '/repo/a', projectHash: '11111111', registeredAt: old, lastSeenAt: recent, terminal: true },
        terminal: { projectPath: '/repo/a', projectHash: '11111111', registeredAt: old, lastSeenAt: old, terminal: true }
      }
    };
    writeFileSync(path.join(memoryRoot, 'session-registry.json'), JSON.stringify(registry));
    for (const [sessionId, updatedAt] of [['active', old], ['recent', old], ['terminal', old]]) {
      writeFileSync(path.join(memoryRoot, `.adherence-state-${sessionId}.json`), JSON.stringify({ sessionId, updatedAt }));
    }

    const preview = cleanupEphemeralState({ homeDir, targetClass: 'adherence', now: NOW });
    expect(preview.candidates).toBe(1);
    expect(preview.protected).toBe(2);
    expect(existsSync(path.join(memoryRoot, '.adherence-state-terminal.json'))).toBe(true);

    const applied = cleanupEphemeralState({ homeDir, targetClass: 'adherence', now: NOW, apply: true });
    expect(applied.removed).toBe(1);
    expect(existsSync(path.join(memoryRoot, '.adherence-state-active.json'))).toBe(true);
    expect(existsSync(path.join(memoryRoot, '.adherence-state-recent.json'))).toBe(true);
    expect(existsSync(path.join(memoryRoot, '.adherence-state-terminal.json'))).toBe(false);
  });

  it('protects old terminal adherence state when its project store has recent events', () => {
    const { homeDir, memoryRoot } = fixture();
    const projectHash = '11111111';
    const sessionId = 'terminal-with-recent-event';
    const old = '2026-07-01T00:00:00.000Z';
    writeFileSync(path.join(memoryRoot, 'session-registry.json'), JSON.stringify({
      version: 2,
      sessions: {
        [sessionId]: {
          projectPath: '/repo/a',
          projectHash,
          registeredAt: old,
          lastSeenAt: old,
          terminal: true
        }
      }
    }));
    const adherencePath = path.join(memoryRoot, `.adherence-state-${sessionId}.json`);
    writeFileSync(adherencePath, JSON.stringify({ sessionId, updatedAt: old }));

    const dbPath = path.join(memoryRoot, 'projects', projectHash, 'events.sqlite');
    const db = createSQLiteDatabase(dbPath);
    sqliteExec(db, 'CREATE TABLE events (session_id TEXT NOT NULL, timestamp TEXT NOT NULL)');
    sqliteRun(db, 'INSERT INTO events (session_id, timestamp) VALUES (?, ?)', [
      sessionId,
      '2026-08-30T00:00:00.000Z'
    ]);
    sqliteClose(db);

    const report = cleanupEphemeralState({
      homeDir,
      targetClass: 'adherence',
      now: NOW,
      apply: true
    });

    expect(report).toMatchObject({ candidates: 0, protected: 1, removed: 0 });
    expect(existsSync(adherencePath)).toBe(true);
  });

  it('fails closed when recent-event liveness cannot be inspected', () => {
    const { homeDir, memoryRoot } = fixture();
    const projectHash = '22222222';
    const sessionId = 'terminal-with-unreadable-events';
    const old = '2026-07-01T00:00:00.000Z';
    writeFileSync(path.join(memoryRoot, 'session-registry.json'), JSON.stringify({
      version: 2,
      sessions: {
        [sessionId]: {
          projectPath: '/repo/b',
          projectHash,
          registeredAt: old,
          lastSeenAt: old,
          terminal: true
        }
      }
    }));
    const adherencePath = path.join(memoryRoot, `.adherence-state-${sessionId}.json`);
    writeFileSync(adherencePath, JSON.stringify({ sessionId, updatedAt: old }));
    const storePath = path.join(memoryRoot, 'projects', projectHash);
    mkdirSync(storePath, { recursive: true });
    writeFileSync(path.join(storePath, 'events.sqlite'), 'not sqlite');

    const report = cleanupEphemeralState({
      homeDir,
      targetClass: 'adherence',
      now: NOW,
      apply: true
    });

    expect(report).toMatchObject({ candidates: 0, protected: 1, removed: 0 });
    expect(report.samples.some((sample) => sample.reason === 'recent_events_unavailable')).toBe(true);
    expect(existsSync(adherencePath)).toBe(true);
  });

  it('caps removals without evicting a recent active file', () => {
    const { homeDir, runtimeDir } = fixture();
    writeFileSync(path.join(runtimeDir, 'process-30.json'), JSON.stringify(runtimeSnapshot(30, '2026-07-01T00:00:00.000Z')));
    writeFileSync(path.join(runtimeDir, 'process-31.json'), JSON.stringify(runtimeSnapshot(31, '2026-07-01T00:00:00.000Z')));
    writeFileSync(path.join(runtimeDir, 'process-32.json'), JSON.stringify(runtimeSnapshot(32, '2026-08-30T23:00:00.000Z')));
    const report = cleanupEphemeralState({
      homeDir,
      targetClass: 'runtime',
      now: NOW,
      apply: true,
      maxRemovals: 1,
      isProcessAlive: () => false
    });
    expect(report.removed).toBe(1);
    expect(existsSync(path.join(runtimeDir, 'process-32.json'))).toBe(true);
  });

  it('revalidates a runtime file immediately before deletion', () => {
    const { homeDir, runtimeDir } = fixture();
    const target = path.join(runtimeDir, 'process-33.json');
    writeFileSync(target, JSON.stringify(runtimeSnapshot(33, '2026-07-01T00:00:00.000Z')));
    let livenessChecks = 0;

    const report = cleanupEphemeralState({
      homeDir,
      targetClass: 'runtime',
      now: NOW,
      apply: true,
      isProcessAlive: () => {
        livenessChecks += 1;
        if (livenessChecks === 2) {
          writeFileSync(target, JSON.stringify(runtimeSnapshot(33, '2026-08-31T00:00:00.000Z', {
            processState: 'running',
            model: { loaded: true }
          })));
        }
        return false;
      }
    });

    expect(report).toMatchObject({ candidates: 0, protected: 1, removed: 0 });
    expect(report.samples.some((sample) => sample.reason === 'changed_during_scan')).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it('revalidates adherence registry liveness after recent-event inspection', () => {
    const { homeDir, memoryRoot } = fixture();
    const sessionId = 'terminal-that-resumed';
    const old = '2026-07-01T00:00:00.000Z';
    const staleRegistry = {
      version: 2,
      sessions: {
        [sessionId]: {
          projectPath: '/repo/a',
          projectHash: '11111111',
          registeredAt: old,
          lastSeenAt: old,
          terminal: true
        }
      }
    };
    const activeRegistry = {
      version: 2,
      sessions: {
        [sessionId]: {
          ...staleRegistry.sessions[sessionId],
          lastSeenAt: '2026-08-31T00:00:00.000Z',
          terminal: false
        }
      }
    };
    let registryReads = 0;
    const adherencePath = path.join(memoryRoot, `.adherence-state-${sessionId}.json`);
    writeFileSync(adherencePath, JSON.stringify({ sessionId, updatedAt: old }));

    const report = cleanupEphemeralState({
      homeDir,
      targetClass: 'adherence',
      now: NOW,
      apply: true,
      loadRegistry: () => registryReads++ === 0 ? staleRegistry : activeRegistry
    });

    expect(report).toMatchObject({ candidates: 0, protected: 1, removed: 0 });
    expect(report.samples.some((sample) => sample.reason === 'changed_during_scan')).toBe(true);
    expect(existsSync(adherencePath)).toBe(true);
  });

  it('reloads adherence registry immediately before each candidate deletion', () => {
    const { homeDir, memoryRoot } = fixture();
    const old = '2026-07-01T00:00:00.000Z';
    const sessionIds = ['terminal-a', 'terminal-b'];
    let resumedSessionId: string | null = null;
    let registryReads = 0;
    const loadRegistry = () => {
      registryReads += 1;
      return {
        version: 2,
        sessions: Object.fromEntries(sessionIds.map((sessionId) => [sessionId, {
          projectPath: '/repo/a',
          projectHash: '11111111',
          registeredAt: old,
          lastSeenAt: sessionId === resumedSessionId ? NOW.toISOString() : old,
          terminal: sessionId !== resumedSessionId
        }]))
      };
    };
    for (const sessionId of sessionIds) {
      writeFileSync(path.join(memoryRoot, `.adherence-state-${sessionId}.json`), JSON.stringify({ sessionId, updatedAt: old }));
    }

    const report = cleanupEphemeralState({
      homeDir,
      targetClass: 'adherence',
      now: NOW,
      apply: true,
      loadRegistry,
      removeFile: (filePath) => {
        const removedSessionId = sessionIds.find((sessionId) => filePath.endsWith(`${sessionId}.json`));
        resumedSessionId = sessionIds.find((sessionId) => sessionId !== removedSessionId) ?? null;
        rmSync(filePath);
      }
    });

    expect(registryReads).toBe(3);
    expect(report).toMatchObject({ candidates: 1, protected: 1, removed: 1 });
    expect(resumedSessionId).not.toBeNull();
    expect(existsSync(path.join(memoryRoot, `.adherence-state-${resumedSessionId}.json`))).toBe(true);
  });

  it('rejects a symlinked owned directory instead of deleting through it', () => {
    const { homeDir, runtimeDir } = fixture();
    const outside = path.join(homeDir, 'outside-runtime');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'process-40.json'), JSON.stringify(runtimeSnapshot(40, '2026-07-01T00:00:00.000Z')));
    rmSync(runtimeDir, { recursive: true });
    symlinkSync(outside, runtimeDir);

    expect(() => cleanupEphemeralState({
      homeDir,
      targetClass: 'runtime',
      apply: true,
      now: NOW,
      isProcessAlive: () => false
    })).toThrow(/non-symlink directory/);
    expect(existsSync(path.join(outside, 'process-40.json'))).toBe(true);
  });

  it('protects files whose owned filename does not match the payload identity', () => {
    const { homeDir, memoryRoot, runtimeDir } = fixture();
    writeFileSync(path.join(runtimeDir, 'process-41.json'), JSON.stringify(runtimeSnapshot(99, '2026-07-01T00:00:00.000Z')));
    writeFileSync(path.join(memoryRoot, '.adherence-state-session-a.json'), JSON.stringify({
      sessionId: 'session-b',
      updatedAt: '2026-07-01T00:00:00.000Z'
    }));

    const report = cleanupEphemeralState({ homeDir, apply: true, now: NOW, isProcessAlive: () => false });
    expect(report).toMatchObject({ removed: 0, protected: 2, malformed: 2 });
    expect(existsSync(path.join(runtimeDir, 'process-41.json'))).toBe(true);
    expect(existsSync(path.join(memoryRoot, '.adherence-state-session-a.json'))).toBe(true);
  });

  it('continues after a deletion failure and reports it', () => {
    const { homeDir, runtimeDir } = fixture();
    const first = path.join(runtimeDir, 'process-50.json');
    const second = path.join(runtimeDir, 'process-51.json');
    writeFileSync(first, JSON.stringify(runtimeSnapshot(50, '2026-07-01T00:00:00.000Z')));
    writeFileSync(second, JSON.stringify(runtimeSnapshot(51, '2026-07-01T00:00:00.000Z')));

    const report = cleanupEphemeralState({
      homeDir,
      targetClass: 'runtime',
      apply: true,
      now: NOW,
      isProcessAlive: () => false,
      removeFile: (filePath) => {
        if (filePath === first) throw new Error('injected deletion failure');
        rmSync(filePath);
      }
    });
    expect(report).toMatchObject({ candidates: 2, removed: 1, failures: 1 });
    expect(report.samples.some((sample) => sample.reason === 'delete_failed')).toBe(true);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(false);
  });

  it('counts failed deletions against the apply attempt cap', () => {
    const { homeDir, runtimeDir } = fixture();
    const first = path.join(runtimeDir, 'process-60.json');
    const second = path.join(runtimeDir, 'process-61.json');
    writeFileSync(first, JSON.stringify(runtimeSnapshot(60, '2026-07-01T00:00:00.000Z')));
    writeFileSync(second, JSON.stringify(runtimeSnapshot(61, '2026-07-01T00:00:00.000Z')));
    let deleteCalls = 0;

    const report = cleanupEphemeralState({
      homeDir,
      targetClass: 'runtime',
      apply: true,
      now: NOW,
      maxRemovals: 1,
      isProcessAlive: () => false,
      removeFile: () => {
        deleteCalls += 1;
        throw new Error('injected deletion failure');
      }
    });

    expect(deleteCalls).toBe(1);
    expect(report).toMatchObject({ candidates: 1, protected: 1, removed: 0, failures: 1 });
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
  });

  it('rejects invalid destructive time and bound options before scanning', () => {
    const { homeDir, runtimeDir } = fixture();
    const target = path.join(runtimeDir, 'process-70.json');
    writeFileSync(target, JSON.stringify(runtimeSnapshot(70, '2026-08-31T00:00:00.000Z')));

    expect(() => cleanupEphemeralState({
      homeDir,
      apply: true,
      now: new Date(Number.NaN),
      isProcessAlive: () => false
    })).toThrow(/valid date/);
    expect(() => cleanupEphemeralState({
      homeDir,
      apply: true,
      now: NOW,
      runtimeGraceMs: Number.NaN,
      isProcessAlive: () => false
    })).toThrow(/runtime grace/);
    expect(() => cleanupEphemeralState({
      homeDir,
      apply: true,
      now: NOW,
      adherenceRetentionMs: -1,
      isProcessAlive: () => false
    })).toThrow(/adherence retention/);
    expect(() => cleanupEphemeralState({
      homeDir,
      apply: true,
      now: NOW,
      maxRemovals: 1.5,
      isProcessAlive: () => false
    })).toThrow(/maximum removals/);
    expect(existsSync(target)).toBe(true);
  });
});
