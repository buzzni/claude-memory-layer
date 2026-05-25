import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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
      if (existing?.pid && this.isProcessRunning(existing.pid)) {
        return {
          acquired: false,
          lockPath: this.lockPath,
          reason: 'busy',
          holderPid: existing.pid
        };
      }

      if (!this.removeExistingLock()) {
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
    let fd: number | null = null;
    try {
      fd = openSync(this.lockPath, 'wx');
      writeFileSync(fd, JSON.stringify({
        pid: this.pid,
        ownerId: this.ownerId,
        acquiredAt: this.now().toISOString()
      }));
      return 'created';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return 'exists';
      throw error;
    } finally {
      if (fd !== null) closeSync(fd);
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

  private removeExistingLock(): boolean {
    try {
      unlinkSync(this.lockPath);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ENOENT';
    }
  }
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
