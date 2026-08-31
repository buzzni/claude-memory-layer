import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface WorkerLockOptions {
  pid?: number;
  ownerId?: string;
  now?: () => Date;
  isProcessRunning?: (pid: number) => boolean;
}

export interface WorkerLockAcquiredResult {
  acquired: true;
  lockPath: string;
  pid: number;
  ownerId: string;
  staleRecovered: boolean;
}

export interface WorkerLockBusyResult {
  acquired: false;
  lockPath: string;
  reason: 'busy';
  holderPid: number | null;
}

export type WorkerLockAcquireResult = WorkerLockAcquiredResult | WorkerLockBusyResult;

interface WorkerLockPayload {
  pid: number;
  ownerId: string;
  acquiredAt: string;
}

const UNPARSEABLE_LOCK_GRACE_MS = 5_000;

export class WorkerLock {
  private readonly lockPath: string;
  private readonly pid: number;
  private readonly ownerId: string;
  private readonly now: () => Date;
  private readonly isProcessRunning: (pid: number) => boolean;
  private acquired = false;

  constructor(
    lockPath: string = path.join(os.tmpdir(), 'claude-memory-layer', 'vector-worker.lock'),
    options: WorkerLockOptions = {}
  ) {
    this.lockPath = lockPath;
    this.pid = options.pid ?? process.pid;
    this.ownerId = options.ownerId ?? randomUUID();
    this.now = options.now ?? (() => new Date());
    this.isProcessRunning = options.isProcessRunning ?? defaultIsProcessRunning;
  }

  getLockPath(): string {
    return this.lockPath;
  }

  acquire(): WorkerLockAcquireResult {
    let staleRecovered = false;

    for (;;) {
      mkdirSync(path.dirname(this.lockPath), { recursive: true });
      const createResult = this.tryCreateLockFile();
      if (createResult === 'created') {
        this.acquired = true;
        return {
          acquired: true,
          lockPath: this.lockPath,
          pid: this.pid,
          ownerId: this.ownerId,
          staleRecovered
        };
      }

      const existing = this.readPayload();
      if (!existing && this.unparseableLockMayBeInFlight()) {
        return {
          acquired: false,
          lockPath: this.lockPath,
          reason: 'busy',
          holderPid: null
        };
      }
      if (existing?.pid && this.isProcessRunning(existing.pid)) {
        return {
          acquired: false,
          lockPath: this.lockPath,
          reason: 'busy',
          holderPid: existing.pid
        };
      }

      if (!this.removeExistingLock(existing)) {
        const reread = this.readPayload();
        return {
          acquired: false,
          lockPath: this.lockPath,
          reason: 'busy',
          holderPid: reread?.pid ?? null
        };
      }
      staleRecovered = true;
    }
  }

  release(): boolean {
    if (!this.acquired || !existsSync(this.lockPath)) return false;

    const existing = this.readPayload();
    if (!this.isOwnedPayload(existing)) return false;

    try {
      unlinkSync(this.lockPath);
      this.acquired = false;
      return true;
    } catch {
      return false;
    }
  }

  private tryCreateLockFile(): 'created' | 'exists' {
    const temporaryPath = `${this.lockPath}.${this.ownerId}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify({
        pid: this.pid,
        ownerId: this.ownerId,
        acquiredAt: this.now().toISOString()
      }), { flag: 'wx', mode: 0o600 });
      linkSync(temporaryPath, this.lockPath);
      return 'created';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return 'exists';
      throw error;
    } finally {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The complete payload has already been linked or creation failed.
      }
    }
  }

  private readPayload(): WorkerLockPayload | null {
    try {
      const raw = readFileSync(this.lockPath, 'utf8').trim();
      if (!raw) return null;

      if (/^\d+$/.test(raw)) {
        return {
          pid: Number.parseInt(raw, 10),
          ownerId: '',
          acquiredAt: ''
        };
      }

      const parsed = JSON.parse(raw) as Partial<WorkerLockPayload>;
      const pid = typeof parsed.pid === 'number' ? parsed.pid : Number(parsed.pid);
      if (!Number.isSafeInteger(pid) || pid <= 0) return null;
      return {
        pid,
        ownerId: typeof parsed.ownerId === 'string' ? parsed.ownerId : '',
        acquiredAt: typeof parsed.acquiredAt === 'string' ? parsed.acquiredAt : ''
      };
    } catch {
      return null;
    }
  }

  private isOwnedPayload(payload: WorkerLockPayload | null): boolean {
    if (!payload) return false;
    return payload.pid === this.pid && payload.ownerId === this.ownerId;
  }

  private unparseableLockMayBeInFlight(): boolean {
    try {
      const stat = lstatSync(this.lockPath);
      return this.now().getTime() - stat.mtimeMs < UNPARSEABLE_LOCK_GRACE_MS;
    } catch {
      return false;
    }
  }

  private removeExistingLock(expected: WorkerLockPayload | null): boolean {
    const current = this.readPayload();
    if (!sameLockPayload(current, expected)) return false;
    try {
      unlinkSync(this.lockPath);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ENOENT';
    }
  }
}

function sameLockPayload(left: WorkerLockPayload | null, right: WorkerLockPayload | null): boolean {
  if (left === null || right === null) return left === right;
  return left.pid === right.pid
    && left.ownerId === right.ownerId
    && left.acquiredAt === right.acquiredAt;
}

function defaultIsProcessRunning(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}
