/**
 * Persistent circuit breaker for the LLM CLI providers.
 *
 * A logged-out or rate-limited CLI fails every call the same way until a
 * person logs in or the quota window resets, and each failed call still costs
 * a CLI start. The breaker opens after a streak of those failures, skips calls
 * while open, and after a cooldown lets a single probe through: success closes
 * it, another such failure reopens it with a doubled (capped) cooldown.
 *
 * Hooks start a fresh process every time and the daemon is long-lived, so the
 * state lives in one file under the memory root rather than in memory.
 * Updates run under a WorkerLock (pid + owner id, taken over only from a dead
 * holder, released only by its owner). The probe is claimed inside that lock
 * with an id and a lease as long as the CLI timeout allows the call to run,
 * so concurrent processes send at most one probe, and only the outcome of the
 * current claim moves an open breaker. A closed breaker is read without the
 * lock and writes nothing on success: the common path is one small read.
 *
 * Invariant: the breaker only ever withholds a call it can justify from a
 * valid state. A missing, corrupt or implausible state (a time further out
 * than the cooldown cap, a claim from the future after the clock went back),
 * a lock it cannot take, or a directory it cannot write all fail open: the
 * call goes to the provider as if there were no breaker.
 *
 * Only failure codes that will fail again right away count. A timeout or a
 * generic error neither opens the breaker nor resets the streak.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { WorkerLock } from '../../core/worker-lock.js';
import { acquireWorkerLockWithin, releaseQuietly } from './lock-within.js';

/** CliProviderError code for a call the open breaker skipped. */
export const CIRCUIT_OPEN_CODE = 'provider-circuit-open';

const PERSISTENT_FAILURE_CODES = new Set(['provider-auth', 'provider-rate-limit']);

/** The longest a provider call may run; cli-provider clamps every CLI timeout to it. */
export const MAX_PROVIDER_CALL_MS = 30 * 60_000;
/** Added to the caller's CLI timeout for the probe lease: lock and spawn overhead. */
export const PROBE_LEASE_MARGIN_MS = 60_000;
/** Longest lease admit() grants; a longer one in the file comes from a damaged file. */
export const MAX_PROBE_LEASE_MS = MAX_PROVIDER_CALL_MS + PROBE_LEASE_MARGIN_MS;
/** The lock is held for one read and one write; a live holder frees it within this. */
const LOCK_DEADLINE_MS = 200;

export interface ProviderCircuitConfig {
  enabled: boolean;
  /** Consecutive persistent failures that open the breaker. */
  failureThreshold: number;
  /** Wait before the first probe. */
  cooldownMs: number;
  /** Cap for the cooldown, which doubles after each failed probe. */
  maxCooldownMs: number;
}

export interface ProviderCircuitState {
  state: 'closed' | 'open';
  consecutiveFailures: number;
  /** Failure code behind the streak or the open breaker. */
  reason: string | null;
  openedAt: string | null;
  nextProbeAt: string | null;
  cooldownMs: number | null;
  /** The probe in flight: who claimed it, when, and until when the claim holds. */
  probeClaimId: string | null;
  probeClaimedAt: string | null;
  probeLeaseUntil: string | null;
  updatedAt: string;
}

export type CircuitAdmission =
  | { allowed: true; probe: false }
  | { allowed: true; probe: true; claimId: string }
  | { allowed: false; nextProbeAt: string };

interface CircuitStateFile {
  version: 1;
  providers: Record<string, ProviderCircuitState>;
}

export interface ProviderCircuitBreakerOptions {
  filePath?: string;
  now?: () => number;
  config?: ProviderCircuitConfig;
  /** Lock holder liveness; tests stand in for live and dead holders. */
  isProcessRunning?: (pid: number) => boolean;
}

const ADMIT: CircuitAdmission = { allowed: true, probe: false };

function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveProviderCircuitConfig(env: NodeJS.ProcessEnv = process.env): ProviderCircuitConfig {
  const cooldownMs = positiveIntEnv(env.CLAUDE_MEMORY_LLM_BREAKER_COOLDOWN_MS, 5 * 60_000);
  return {
    enabled: env.CLAUDE_MEMORY_LLM_BREAKER !== 'off',
    failureThreshold: positiveIntEnv(env.CLAUDE_MEMORY_LLM_BREAKER_THRESHOLD, 3),
    cooldownMs,
    maxCooldownMs: Math.max(cooldownMs, positiveIntEnv(env.CLAUDE_MEMORY_LLM_BREAKER_MAX_COOLDOWN_MS, 60 * 60_000))
  };
}

export function getProviderCircuitStatePath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.claude-code', 'memory', 'llm-provider-breaker.json');
}

const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const isTimeOrNull = (value: unknown) => value === null || isTime(value);

/** Shape check only; whether the times are plausible is judged against the clock in admit(). */
function isValidState(value: unknown): value is ProviderCircuitState {
  const state = value as Partial<ProviderCircuitState> | null;
  if (!state || typeof state !== 'object') return false;
  const common = Number.isInteger(state.consecutiveFailures) && state.consecutiveFailures! >= 0
    && (state.reason === null || typeof state.reason === 'string')
    && isTime(state.updatedAt)
    && (state.probeClaimId === null || typeof state.probeClaimId === 'string')
    && isTimeOrNull(state.probeClaimedAt) && isTimeOrNull(state.probeLeaseUntil);
  if (!common) return false;
  if (state.state === 'closed') return true;
  return state.state === 'open'
    && isTime(state.openedAt) && isTime(state.nextProbeAt)
    && Number.isInteger(state.cooldownMs) && state.cooldownMs! > 0;
}

function readStateFile(filePath: string): Record<string, ProviderCircuitState> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as CircuitStateFile;
    if (parsed?.version !== 1 || !parsed.providers || typeof parsed.providers !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed.providers).filter(([, state]) => isValidState(state)));
  } catch {
    return {};
  }
}

/**
 * Lock-free read for status reporting. Missing, unreadable or malformed
 * entries are left out, which reads as closed — the same way admit() treats them.
 */
export function readProviderCircuitStates(
  filePath: string = getProviderCircuitStatePath()
): Record<string, ProviderCircuitState> {
  return readStateFile(filePath);
}

export class ProviderCircuitBreaker {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly config: ProviderCircuitConfig;
  private readonly isProcessRunning?: (pid: number) => boolean;

  constructor(options: ProviderCircuitBreakerOptions = {}) {
    this.filePath = options.filePath ?? getProviderCircuitStatePath();
    this.now = options.now ?? Date.now;
    this.config = options.config ?? resolveProviderCircuitConfig();
    this.isProcessRunning = options.isProcessRunning;
  }

  /**
   * @param leaseMs how long the caller's call may run if it becomes the
   *   probe: its CLI timeout plus PROBE_LEASE_MARGIN_MS. Another probe is
   *   admitted only after that.
   */
  admit(provider: string, leaseMs: number): CircuitAdmission {
    if (!this.config.enabled) return ADMIT;
    const seen = readStateFile(this.filePath)[provider];
    if (seen?.state !== 'open') return ADMIT;
    const wait = this.waitReason(seen, this.now());
    if (wait) return wait;

    const admission = this.withLock((providers): CircuitAdmission => {
      const current = providers[provider];
      if (current?.state !== 'open') return ADMIT;
      const now = this.now();
      const stillWaiting = this.waitReason(current, now);
      if (stillWaiting) return stillWaiting;
      const claimId = randomUUID();
      providers[provider] = {
        ...current,
        probeClaimId: claimId,
        probeClaimedAt: this.iso(now),
        probeLeaseUntil: this.iso(now + Math.min(Math.max(leaseMs, 0), MAX_PROBE_LEASE_MS)),
        updatedAt: this.iso(now)
      };
      return { allowed: true, probe: true, claimId };
    });
    // Could not lock or record the claim: fail open (see the module comment).
    return admission ?? ADMIT;
  }

  recordSuccess(provider: string, admission: CircuitAdmission): void {
    if (!this.config.enabled) return;
    if (!readStateFile(this.filePath)[provider]) return;
    this.withLock((providers) => {
      const current = providers[provider];
      if (current?.state === 'open' && !this.isCurrentProbe(current, admission)) return;
      delete providers[provider];
    });
  }

  recordFailure(provider: string, code: string | undefined, admission: CircuitAdmission): void {
    if (!this.config.enabled) return;
    const persistent = code !== undefined && PERSISTENT_FAILURE_CODES.has(code);
    const probe = admission.allowed && admission.probe;
    if (!persistent && !probe) return;

    this.withLock((providers) => {
      const now = this.now();
      const current = providers[provider];
      if (current?.state === 'open') {
        // Only the current probe's outcome moves an open breaker: a call
        // admitted before it opened, or a probe whose lease ran out and was
        // replaced, must not release or extend the live claim.
        if (!this.isCurrentProbe(current, admission)) return;
        const cooldownMs = persistent
          ? Math.min(current.cooldownMs! * 2, this.config.maxCooldownMs)
          : Math.min(current.cooldownMs!, this.config.maxCooldownMs);
        providers[provider] = {
          ...current,
          reason: persistent ? code! : current.reason,
          cooldownMs,
          nextProbeAt: this.iso(now + cooldownMs),
          probeClaimId: null,
          probeClaimedAt: null,
          probeLeaseUntil: null,
          updatedAt: this.iso(now)
        };
        return;
      }
      if (!persistent) return;

      const consecutiveFailures = (current?.consecutiveFailures ?? 0) + 1;
      const opens = consecutiveFailures >= this.config.failureThreshold;
      providers[provider] = {
        state: opens ? 'open' : 'closed',
        consecutiveFailures,
        reason: code!,
        openedAt: opens ? this.iso(now) : null,
        nextProbeAt: opens ? this.iso(now + this.config.cooldownMs) : null,
        cooldownMs: opens ? this.config.cooldownMs : null,
        probeClaimId: null,
        probeClaimedAt: null,
        probeLeaseUntil: null,
        updatedAt: this.iso(now)
      };
    });
  }

  /**
   * Why an open breaker withholds a call right now, or null when a probe may
   * go. Times the clock cannot have produced — a probe due further out than
   * the cooldown cap, a claim dated in the future, a lease longer than any
   * call — come from a clock that went back or a damaged file, and do not
   * withhold anything.
   */
  private waitReason(state: ProviderCircuitState, now: number): CircuitAdmission | null {
    const nextProbe = Date.parse(state.nextProbeAt!);
    const plausibleNextProbe = nextProbe - now <= this.config.maxCooldownMs;
    const claimLive = state.probeClaimId !== null
      && state.probeClaimedAt !== null && state.probeLeaseUntil !== null
      && Date.parse(state.probeClaimedAt) <= now
      && now < Date.parse(state.probeLeaseUntil)
      && Date.parse(state.probeLeaseUntil) - Date.parse(state.probeClaimedAt) <= MAX_PROBE_LEASE_MS;
    if ((now < nextProbe && plausibleNextProbe) || claimLive) {
      return { allowed: false, nextProbeAt: state.nextProbeAt! };
    }
    return null;
  }

  private isCurrentProbe(state: ProviderCircuitState, admission: CircuitAdmission): boolean {
    return admission.allowed && admission.probe && state.probeClaimId === admission.claimId;
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  /**
   * Runs `update` on a fresh read under the lock and writes the result back.
   * Returns undefined when the lock could not be taken or anything failed,
   * including the release; the breaker never fails the caller.
   */
  private withLock<T>(update: (providers: Record<string, ProviderCircuitState>) => T): T | undefined {
    let lock: WorkerLock | null = null;
    try {
      lock = this.acquireLock();
      if (!lock) return undefined;
      const providers = readStateFile(this.filePath);
      const before = JSON.stringify(providers);
      const result = update(providers);
      if (JSON.stringify(providers) !== before) {
        const temporary = `${this.filePath}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify({ version: 1, providers } satisfies CircuitStateFile), { mode: 0o600 });
        fs.renameSync(temporary, this.filePath);
      }
      return result;
    } catch {
      return undefined;
    } finally {
      releaseQuietly(lock);
    }
  }

  private acquireLock(): WorkerLock | null {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    return acquireWorkerLockWithin(`${this.filePath}.lock`, LOCK_DEADLINE_MS, {
      now: () => new Date(this.now()),
      ...(this.isProcessRunning ? { isProcessRunning: this.isProcessRunning } : {})
    });
  }
}
