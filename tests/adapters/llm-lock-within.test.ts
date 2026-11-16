import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireWorkerLockWithin, releaseQuietly } from '../../src/adapters/llm/lock-within.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cml-lock-within-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('acquireWorkerLockWithin', () => {
  it('takes a free lock and releases it', () => {
    const lockPath = path.join(dir, 'a.lock');
    const lock = acquireWorkerLockWithin(lockPath, 100);
    expect(lock).not.toBeNull();
    expect(fs.existsSync(lockPath)).toBe(true);
    releaseQuietly(lock);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('gives up on a live holder by elapsed time, not by a retry count (review recommendation)', () => {
    const lockPath = path.join(dir, 'a.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 4242, ownerId: 'other', acquiredAt: '2026-01-01T00:00:00.000Z' }));
    const started = performance.now();
    expect(acquireWorkerLockWithin(lockPath, 60, { isProcessRunning: () => true })).toBeNull();
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(55);
    expect(elapsed).toBeLessThan(60 + 150);
  });

  it('returns null instead of throwing when the lock cannot be created', () => {
    if (process.getuid?.() === 0) return; // root ignores the permission bits
    fs.chmodSync(dir, 0o500);
    try {
      expect(acquireWorkerLockWithin(path.join(dir, 'a.lock'), 50)).toBeNull();
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });
});
