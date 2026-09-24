import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { WorkerLock } from '../../src/core/worker-lock.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function readPayload(lockPath: string): { pid: number; ownerId: string; acquiredAt: string } {
  return JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number; ownerId: string; acquiredAt: string };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('WorkerLock', () => {
  it('acquires an exclusive lock and reports the live holder instead of overwriting it', () => {
    const dir = makeTempDir('cml-worker-lock-live-');
    const lockPath = path.join(dir, 'nested', 'vector-worker.lock');

    const first = new WorkerLock(lockPath, {
      pid: 111,
      ownerId: 'owner-first',
      now: () => new Date('2026-05-25T00:00:00.000Z'),
      isProcessRunning: () => true
    });
    const firstResult = first.acquire();

    expect(firstResult).toEqual({
      acquired: true,
      lockPath,
      ownerId: 'owner-first',
      pid: 111,
      staleRecovered: false
    });
    expect(existsSync(lockPath)).toBe(true);
    expect(readPayload(lockPath)).toMatchObject({
      pid: 111,
      ownerId: 'owner-first',
      acquiredAt: '2026-05-25T00:00:00.000Z'
    });

    const second = new WorkerLock(lockPath, {
      pid: 222,
      ownerId: 'owner-second',
      isProcessRunning: (pid) => pid === 111
    });
    const secondResult = second.acquire();

    expect(secondResult).toEqual({
      acquired: false,
      lockPath,
      holderPid: 111,
      reason: 'busy'
    });
    expect(readPayload(lockPath)).toMatchObject({ pid: 111, ownerId: 'owner-first' });
  });

  it('recovers stale lock files whose recorded process is no longer running', () => {
    const dir = makeTempDir('cml-worker-lock-stale-');
    const lockPath = path.join(dir, 'vector-worker.lock');
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      pid: 999999,
      ownerId: 'dead-owner',
      acquiredAt: '2026-05-24T00:00:00.000Z'
    }));

    const lock = new WorkerLock(lockPath, {
      pid: 333,
      ownerId: 'owner-new',
      now: () => new Date('2026-05-25T00:00:00.000Z'),
      isProcessRunning: () => false
    });

    expect(lock.acquire()).toEqual({
      acquired: true,
      lockPath,
      ownerId: 'owner-new',
      pid: 333,
      staleRecovered: true
    });
    expect(readPayload(lockPath)).toMatchObject({ pid: 333, ownerId: 'owner-new' });
  });

  it('does not remove a recent unparseable lock that may still be initializing', () => {
    const dir = makeTempDir('cml-worker-lock-initializing-');
    const lockPath = path.join(dir, 'vector-worker.lock');
    const now = new Date('2026-05-25T00:00:00.000Z');
    writeFileSync(lockPath, '');
    utimesSync(lockPath, now, now);

    const contender = new WorkerLock(lockPath, {
      pid: 333,
      ownerId: 'contender',
      now: () => now,
      isProcessRunning: () => false
    });

    expect(contender.acquire()).toEqual({
      acquired: false,
      lockPath,
      holderPid: null,
      reason: 'busy'
    });
    expect(readFileSync(lockPath, 'utf8')).toBe('');
  });

  it('recovers an unparseable lock after the initialization grace expires', () => {
    const dir = makeTempDir('cml-worker-lock-malformed-stale-');
    const lockPath = path.join(dir, 'vector-worker.lock');
    const staleTime = new Date('2026-05-24T00:00:00.000Z');
    writeFileSync(lockPath, '{broken');
    utimesSync(lockPath, staleTime, staleTime);

    const contender = new WorkerLock(lockPath, {
      pid: 333,
      ownerId: 'contender',
      now: () => new Date('2026-05-25T00:00:00.000Z'),
      isProcessRunning: () => false
    });

    expect(contender.acquire()).toMatchObject({ acquired: true, staleRecovered: true });
    expect(readPayload(lockPath)).toMatchObject({ pid: 333, ownerId: 'contender' });
  });

  it('does not remove a new owner that replaces a stale lock during recovery', () => {
    const dir = makeTempDir('cml-worker-lock-replaced-');
    const lockPath = path.join(dir, 'vector-worker.lock');
    writeFileSync(lockPath, JSON.stringify({
      pid: 777,
      ownerId: 'dead-owner',
      acquiredAt: '2026-05-24T00:00:00.000Z'
    }));
    const contender = new WorkerLock(lockPath, {
      pid: 888,
      ownerId: 'contender',
      isProcessRunning: (pid) => {
        if (pid === 777) {
          writeFileSync(lockPath, JSON.stringify({
            pid: 999,
            ownerId: 'replacement-owner',
            acquiredAt: '2026-05-25T00:00:00.000Z'
          }));
          return false;
        }
        return pid === 999;
      }
    });

    expect(contender.acquire()).toEqual({
      acquired: false,
      lockPath,
      holderPid: 999,
      reason: 'busy'
    });
    expect(readPayload(lockPath)).toMatchObject({ pid: 999, ownerId: 'replacement-owner' });
  });

  it('only releases the lock owned by this instance', () => {
    const dir = makeTempDir('cml-worker-lock-release-');
    const lockPath = path.join(dir, 'vector-worker.lock');

    const owner = new WorkerLock(lockPath, {
      pid: 444,
      ownerId: 'owner-real',
      isProcessRunning: () => true
    });
    expect(owner.acquire().acquired).toBe(true);

    const stranger = new WorkerLock(lockPath, {
      pid: 444,
      ownerId: 'owner-stranger',
      isProcessRunning: () => true
    });
    expect(stranger.release()).toBe(false);
    expect(existsSync(lockPath)).toBe(true);

    writeFileSync(lockPath, JSON.stringify({
      pid: 555,
      ownerId: 'owner-replacement',
      acquiredAt: '2026-05-25T00:01:00.000Z'
    }));
    expect(owner.release()).toBe(false);
    expect(readPayload(lockPath)).toMatchObject({ pid: 555, ownerId: 'owner-replacement' });

    const replacement = new WorkerLock(lockPath, {
      pid: 555,
      ownerId: 'owner-replacement',
      isProcessRunning: () => true
    });
    expect(replacement.release()).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('releases the lock owned by this instance', () => {
    const dir = makeTempDir('cml-worker-lock-release-owned-');
    const lockPath = path.join(dir, 'vector-worker.lock');
    const owner = new WorkerLock(lockPath, {
      pid: 666,
      ownerId: 'owner-real',
      isProcessRunning: () => true
    });

    expect(owner.acquire().acquired).toBe(true);
    expect(owner.release()).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });
});
