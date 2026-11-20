import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Lets a test run another contender at the exact moment a takeover is about
// to unlink the lock path, i.e. after its re-check of the stale payload.
const fsHooks = vi.hoisted(() => ({
  beforeUnlink: null as ((target: string) => void) | null
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    unlinkSync: (target: import('node:fs').PathLike) => {
      fsHooks.beforeUnlink?.(String(target));
      actual.unlinkSync(target);
    }
  };
});

const { WorkerLock } = await import('../../src/core/worker-lock.js');

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeLock(lockPath: string, pid: number, ownerId: string): void {
  writeFileSync(lockPath, JSON.stringify({ pid, ownerId, acquiredAt: '2026-11-01T00:00:00.000Z' }));
}

afterEach(() => {
  fsHooks.beforeUnlink = null;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('WorkerLock stale takeover', () => {
  it('lets only one of two contenders take over a dead holder\'s lock', () => {
    const dir = makeTempDir('cml-worker-lock-takeover-race-');
    const lockPath = path.join(dir, 'worker.lock');
    writeLock(lockPath, 777, 'dead-owner');
    const isProcessRunning = (pid: number) => pid === 111 || pid === 222;

    const a = new WorkerLock(lockPath, { pid: 111, ownerId: 'owner-a', isProcessRunning });
    const b = new WorkerLock(lockPath, { pid: 222, ownerId: 'owner-b', isProcessRunning });

    // A has re-read the dead payload and is about to unlink it; B runs its
    // whole acquire() in that gap.
    let bResult: ReturnType<typeof b.acquire> | undefined;
    fsHooks.beforeUnlink = (target) => {
      if (target !== lockPath || bResult) return;
      bResult = b.acquire();
    };

    const aResult = a.acquire();

    expect(bResult).toBeDefined();
    const winners = [aResult, bResult].filter((result) => result?.acquired);
    expect(winners).toHaveLength(1);
    expect(aResult).toMatchObject({ acquired: true, staleRecovered: true });
    expect(bResult).toMatchObject({ acquired: false, reason: 'busy' });
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ pid: 111, ownerId: 'owner-a' });
  });

  it('recovers a takeover guard left behind by a contender that died mid-takeover', () => {
    const dir = makeTempDir('cml-worker-lock-dead-guard-');
    const lockPath = path.join(dir, 'worker.lock');
    writeLock(lockPath, 777, 'dead-owner');
    writeLock(`${lockPath}.takeover`, 888, 'dead-contender');

    const lock = new WorkerLock(lockPath, {
      pid: 111,
      ownerId: 'owner-a',
      isProcessRunning: (pid) => pid === 111
    });

    expect(lock.acquire()).toMatchObject({ acquired: true, staleRecovered: true });
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ pid: 111, ownerId: 'owner-a' });
  });

  it('reports busy and leaves the stale lock while a live contender holds the takeover guard', () => {
    const dir = makeTempDir('cml-worker-lock-live-guard-');
    const lockPath = path.join(dir, 'worker.lock');
    writeLock(lockPath, 777, 'dead-owner');
    writeLock(`${lockPath}.takeover`, 222, 'live-contender');

    const lock = new WorkerLock(lockPath, {
      pid: 111,
      ownerId: 'owner-a',
      isProcessRunning: (pid) => pid === 111 || pid === 222
    });

    expect(lock.acquire()).toMatchObject({ acquired: false, reason: 'busy' });
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ pid: 777, ownerId: 'dead-owner' });
  });
});
