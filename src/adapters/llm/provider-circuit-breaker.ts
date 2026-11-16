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
 * state lives in one file under the memory root rather than in memory. A
 * short exclusive lock file serialises updates, and the probe is claimed
 * inside that lock, so concurrent processes send at most one probe. A closed
 * breaker is read without the lock and writes nothing on success: the common
 * path costs one small file read.
 *
 * Only failure codes that will fail again right away count. A timeout or a
 * generic error neither opens the breaker nor resets the streak.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** CliProviderError code for a call the open breaker skipped. */
export const CIRCUIT_OPEN_CODE = 'provider-circuit-open';

const PERSISTENT_FAILURE_CODES = new Set(['provider-auth', 'provider-rate-limit']);

/** A probe claim this old belongs to a process that died mid-probe. */
const PROBE_CLAIM_TTL_MS = 10 * 60_000;
/** The lock is held for one read and one write; older means its holder died. */
const LOCK_STALE_MS = 5_000;
const LOCK_ATTEMPTS = 20;
const LOCK_RETRY_MS = 10;

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
  probeClaimedAt: string | null;
  updatedAt: string;
}

export type CircuitAdmission =
  | { allowed: true; probe: boolean }
  | { allowed: false; nextProbeAt: string | null };

interface CircuitStateFile {
  version: 1;
  providers: Record<string, ProviderCircuitState>;
}

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

/** Lock-free read for status reporting. Missing or unreadable means every breaker is closed. */
export function readProviderCircuitStates(
  filePath: string = getProviderCircuitStatePath()
): Record<string, ProviderCircuitState> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as CircuitStateFile;
    if (parsed?.version === 1 && parsed.providers && typeof parsed.providers === 'object') return parsed.providers;
  } catch {
    // Missing or corrupt: fall through to closed.
  }
  return {};
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class ProviderCircuitBreaker {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly config: ProviderCircuitConfig;

  constructor(options: { filePath?: string; now?: () => number; config?: ProviderCircuitConfig } = {}) {
    this.filePath = options.filePath ?? getProviderCircuitStatePath();
    this.now = options.now ?? Date.now;
    this.config = options.config ?? resolveProviderCircuitConfig();
  }

  admit(provider: string): CircuitAdmission {
    if (!this.config.enabled) return { allowed: true, probe: false };
    const seen = readProviderCircuitStates(this.filePath)[provider];
    if (seen?.state !== 'open') return { allowed: true, probe: false };

    const admission = this.withLock((providers): CircuitAdmission => {
      const current = providers[provider];
      if (current?.state !== 'open') return { allowed: true, probe: false };
      const now = this.now();
      const claimLive = current.probeClaimedAt !== null
        && now - Date.parse(current.probeClaimedAt) < PROBE_CLAIM_TTL_MS;
      if (now < Date.parse(current.nextProbeAt ?? '') || claimLive) {
        return { allowed: false, nextProbeAt: current.nextProbeAt };
      }
      providers[provider] = { ...current, probeClaimedAt: this.iso(now), updatedAt: this.iso(now) };
      return { allowed: true, probe: true };
    });
    // Lock unavailable: skipping is the safe side of an open breaker.
    return admission ?? { allowed: false, nextProbeAt: seen.nextProbeAt };
  }

  recordSuccess(provider: string): void {
    if (!this.config.enabled) return;
    const seen = readProviderCircuitStates(this.filePath)[provider];
    if (!seen) return;
    this.withLock((providers) => {
      delete providers[provider];
    });
  }

  recordFailure(provider: string, code: string | undefined, admission: { probe: boolean }): void {
    if (!this.config.enabled) return;
    const persistent = code !== undefined && PERSISTENT_FAILURE_CODES.has(code);
    if (!persistent && !admission.probe) return;

    this.withLock((providers) => {
      const now = this.now();
      const current = providers[provider];
      if (current?.state === 'open') {
        // Only the probe's outcome moves an open breaker; a call admitted
        // before it opened must not release or extend someone else's probe.
        if (!admission.probe) return;
        const cooldownMs = persistent
          ? Math.min((current.cooldownMs ?? this.config.cooldownMs) * 2, this.config.maxCooldownMs)
          : current.cooldownMs ?? this.config.cooldownMs;
        providers[provider] = {
          ...current,
          reason: persistent ? code! : current.reason,
          cooldownMs,
          nextProbeAt: this.iso(now + cooldownMs),
          probeClaimedAt: null,
          updatedAt: this.iso(now)
        };
        return;
      }
      if (!persistent) return;

      const consecutiveFailures = (current?.consecutiveFailures ?? 0) + 1;
      providers[provider] = consecutiveFailures >= this.config.failureThreshold
        ? {
            state: 'open',
            consecutiveFailures,
            reason: code!,
            openedAt: this.iso(now),
            nextProbeAt: this.iso(now + this.config.cooldownMs),
            cooldownMs: this.config.cooldownMs,
            probeClaimedAt: null,
            updatedAt: this.iso(now)
          }
        : {
            state: 'closed',
            consecutiveFailures,
            reason: code!,
            openedAt: null,
            nextProbeAt: null,
            cooldownMs: null,
            probeClaimedAt: null,
            updatedAt: this.iso(now)
          };
    });
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  /**
   * Runs `update` on a fresh read under the lock and writes the result back.
   * Returns undefined when the lock could not be taken or the file could not
   * be written; the breaker is advisory and never fails the caller.
   */
  private withLock<T>(update: (providers: Record<string, ProviderCircuitState>) => T): T | undefined {
    const lockPath = `${this.filePath}.lock`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    } catch {
      return undefined;
    }
    if (!this.acquireLock(lockPath)) return undefined;
    try {
      const providers = readProviderCircuitStates(this.filePath);
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
      fs.rmSync(lockPath, { force: true });
    }
  }

  private acquireLock(lockPath: string): boolean {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      try {
        fs.closeSync(fs.openSync(lockPath, 'wx'));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      }
      try {
        // Wall clock on purpose: the lock file's mtime is wall-clock time.
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      sleepSync(LOCK_RETRY_MS);
    }
    return false;
  }
}
