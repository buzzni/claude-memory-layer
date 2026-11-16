/**
 * WorkerLock with a wall-clock deadline, for the provider circuit breaker
 * and the summary queue. Both hold the lock only for a few file operations,
 * so a holder that keeps it past the deadline is stuck or slow, and the
 * caller skips its change instead of waiting.
 *
 * Known limit, inherited from WorkerLock: two processes that take over the
 * same dead holder's lock at the same moment can both end up holding it.
 */

import { WorkerLock, type WorkerLockOptions } from '../../core/worker-lock.js';

const RETRY_MS = 10;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Returns null when the lock stays busy past `deadlineMs` or cannot be created; never throws. */
export function acquireWorkerLockWithin(
  lockPath: string,
  deadlineMs: number,
  options: WorkerLockOptions = {}
): WorkerLock | null {
  // Elapsed time on the monotonic clock: an injected wall clock can stand still.
  const deadline = performance.now() + deadlineMs;
  for (;;) {
    // A fresh owner id per attempt: release() then only ever removes this one.
    const lock = new WorkerLock(lockPath, options);
    try {
      if (lock.acquire().acquired) return lock;
    } catch {
      return null;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return null;
    sleepSync(Math.min(RETRY_MS, remaining));
  }
}

export function releaseQuietly(lock: WorkerLock | null): void {
  try {
    lock?.release();
  } catch {
    // An unreleasable lock is taken over once this process exits.
  }
}
