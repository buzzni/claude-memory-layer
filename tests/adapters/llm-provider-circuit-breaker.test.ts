import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_PROBE_LEASE_MS,
  ProviderCircuitBreaker,
  getProviderCircuitStatePath,
  readProviderCircuitStates,
  resolveProviderCircuitConfig,
  type CircuitAdmission,
  type ProviderCircuitBreakerOptions,
  type ProviderCircuitConfig
} from '../../src/adapters/llm/provider-circuit-breaker.js';

const START = Date.parse('2026-01-01T00:00:00.000Z');
const LEASE = 30_000;
const CONFIG: ProviderCircuitConfig = {
  enabled: true,
  failureThreshold: 3,
  cooldownMs: 60_000,
  maxCooldownMs: 200_000
};
/** An admission of a call that went through while the breaker was closed. */
const NORMAL: CircuitAdmission = { allowed: true, probe: false };

let dir: string;
let clock: number;
let filePath: string;

function breaker(overrides: Partial<ProviderCircuitBreakerOptions> = {}): ProviderCircuitBreaker {
  return new ProviderCircuitBreaker({ filePath, now: () => clock, config: CONFIG, ...overrides });
}

function trip(target: ProviderCircuitBreaker, code = 'provider-rate-limit'): void {
  for (let i = 0; i < CONFIG.failureThreshold; i += 1) target.recordFailure('claude', code, NORMAL);
}

function claude() {
  return readProviderCircuitStates(filePath).claude;
}

function writeRawState(state: Record<string, unknown>): void {
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, providers: { claude: state } }));
}

const openState = (overrides: Record<string, unknown> = {}) => ({
  state: 'open',
  consecutiveFailures: 3,
  reason: 'provider-rate-limit',
  openedAt: '2026-01-01T00:00:00.000Z',
  nextProbeAt: '2026-01-01T00:01:00.000Z',
  cooldownMs: 60_000,
  probeClaimId: null,
  probeClaimedAt: null,
  probeLeaseUntil: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cml-breaker-'));
  filePath = path.join(dir, 'llm-provider-breaker.json');
  clock = START;
});

afterEach(() => {
  fs.chmodSync(dir, 0o700);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ProviderCircuitBreaker transitions', () => {
  it('admits calls while closed and writes nothing on success', () => {
    const subject = breaker();
    expect(subject.admit('claude', LEASE)).toEqual(NORMAL);
    subject.recordSuccess('claude', NORMAL);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('opens after the threshold of consecutive quota failures and then skips calls', () => {
    const subject = breaker();
    subject.recordFailure('claude', 'provider-rate-limit', NORMAL);
    subject.recordFailure('claude', 'provider-rate-limit', NORMAL);
    expect(subject.admit('claude', LEASE)).toEqual(NORMAL);

    subject.recordFailure('claude', 'provider-rate-limit', NORMAL);
    expect(subject.admit('claude', LEASE)).toEqual({ allowed: false, nextProbeAt: '2026-01-01T00:01:00.000Z' });
    expect(claude()).toMatchObject({
      state: 'open',
      reason: 'provider-rate-limit',
      openedAt: '2026-01-01T00:00:00.000Z',
      nextProbeAt: '2026-01-01T00:01:00.000Z',
      cooldownMs: 60_000
    });
  });

  it('opens on authentication failures too', () => {
    trip(breaker(), 'provider-auth');
    expect(claude()).toMatchObject({ state: 'open', reason: 'provider-auth' });
  });

  it.each(['provider-timeout', 'provider-error', 'provider-not-found'])(
    'never opens on %s, which may pass on the next try',
    (code) => {
      const subject = breaker();
      for (let i = 0; i < 10; i += 1) subject.recordFailure('claude', code, NORMAL);
      expect(subject.admit('claude', LEASE)).toEqual(NORMAL);
      expect(fs.existsSync(filePath)).toBe(false);
    }
  );

  it('neither counts nor resets the streak on a transient failure', () => {
    const subject = breaker();
    subject.recordFailure('claude', 'provider-rate-limit', NORMAL);
    subject.recordFailure('claude', 'provider-rate-limit', NORMAL);
    subject.recordFailure('claude', 'provider-timeout', NORMAL);
    subject.recordFailure('claude', 'provider-rate-limit', NORMAL);
    expect(claude()?.state).toBe('open');
  });

  it('resets the streak on success', () => {
    const subject = breaker();
    subject.recordFailure('claude', 'provider-rate-limit', NORMAL);
    subject.recordFailure('claude', 'provider-rate-limit', NORMAL);
    subject.recordSuccess('claude', NORMAL);
    subject.recordFailure('claude', 'provider-rate-limit', NORMAL);
    expect(subject.admit('claude', LEASE)).toEqual(NORMAL);
    expect(claude()).toMatchObject({ state: 'closed', consecutiveFailures: 1 });
  });

  it('keeps providers apart', () => {
    trip(breaker());
    expect(breaker().admit('codex', LEASE)).toEqual(NORMAL);
  });

  it('lets exactly one probe through after the cooldown', () => {
    const subject = breaker();
    trip(subject);
    clock = START + 60_000;
    expect(subject.admit('claude', LEASE)).toMatchObject({ allowed: true, probe: true, claimId: expect.any(String) });
    expect(subject.admit('claude', LEASE)).toEqual({ allowed: false, nextProbeAt: '2026-01-01T00:01:00.000Z' });
    // A second breaker instance stands in for another process.
    expect(breaker().admit('claude', LEASE)).toMatchObject({ allowed: false });
  });

  it('closes when the probe succeeds', () => {
    const subject = breaker();
    trip(subject);
    clock = START + 60_000;
    const probe = subject.admit('claude', LEASE);
    subject.recordSuccess('claude', probe);
    expect(subject.admit('claude', LEASE)).toEqual(NORMAL);
    expect(claude()).toBeUndefined();
  });

  it('reopens with a doubled cooldown, capped, when the probe fails the same way', () => {
    const subject = breaker();
    trip(subject);

    clock = START + 60_000;
    subject.recordFailure('claude', 'provider-rate-limit', subject.admit('claude', LEASE));
    expect(claude()).toMatchObject({
      state: 'open', cooldownMs: 120_000, nextProbeAt: '2026-01-01T00:03:00.000Z', probeClaimId: null
    });

    clock = START + 180_000;
    subject.recordFailure('claude', 'provider-auth', subject.admit('claude', LEASE));
    expect(claude()).toMatchObject({
      cooldownMs: 200_000, reason: 'provider-auth', nextProbeAt: '2026-01-01T00:06:20.000Z'
    });
  });

  it('keeps the cooldown when the probe fails transiently', () => {
    const subject = breaker();
    trip(subject);
    clock = START + 60_000;
    subject.recordFailure('claude', 'provider-timeout', subject.admit('claude', LEASE));
    expect(claude()).toMatchObject({
      state: 'open', cooldownMs: 60_000, nextProbeAt: '2026-01-01T00:02:00.000Z', probeClaimId: null
    });
  });

  it('admits everything and records nothing when disabled', () => {
    const subject = breaker({ config: { ...CONFIG, enabled: false } });
    trip(subject);
    expect(subject.admit('claude', LEASE)).toEqual(NORMAL);
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

describe('ProviderCircuitBreaker probe ownership', () => {
  it('ignores the late failure of a call admitted before the circuit opened', () => {
    const subject = breaker();
    trip(subject);
    clock = START + 60_000;
    const probe = subject.admit('claude', LEASE);
    subject.recordFailure('claude', 'provider-rate-limit', NORMAL);
    expect(claude()?.probeClaimId).toBe((probe as { claimId: string }).claimId);
  });

  it('ignores the late success of a call admitted before the circuit opened (review case)', () => {
    const subject = breaker();
    trip(subject);
    clock = START + 60_000;
    const probe = subject.admit('claude', LEASE);
    subject.recordSuccess('claude', NORMAL);
    expect(claude()).toMatchObject({ state: 'open', probeClaimId: (probe as { claimId: string }).claimId });
    expect(breaker().admit('claude', LEASE)).toMatchObject({ allowed: false });
  });

  it('holds the probe for the lease the caller asked for', () => {
    const subject = breaker();
    trip(subject);
    clock = START + 60_000;
    subject.admit('claude', 15 * 60_000);
    // Past the old fixed 10-minute TTL but inside the caller's lease.
    clock = START + 60_000 + 14 * 60_000;
    expect(breaker().admit('claude', LEASE)).toMatchObject({ allowed: false });
  });

  it('admits a new probe once the lease ran out and ignores the old probe when it finally ends (review case)', () => {
    const subject = breaker();
    trip(subject);
    clock = START + 60_000;
    const first = subject.admit('claude', LEASE);
    clock = START + 60_000 + LEASE;
    const second = breaker().admit('claude', LEASE);
    expect(second).toMatchObject({ allowed: true, probe: true });

    subject.recordSuccess('claude', first);
    subject.recordFailure('claude', 'provider-rate-limit', first);
    expect(claude()).toMatchObject({ state: 'open', probeClaimId: (second as { claimId: string }).claimId, cooldownMs: 60_000 });

    breaker().recordSuccess('claude', second);
    expect(claude()).toBeUndefined();
  });
});

describe('ProviderCircuitBreaker fails open', () => {
  it('admits calls once due when the state directory cannot be written (review case)', () => {
    if (process.getuid?.() === 0) return; // root ignores the permission bits
    trip(breaker());
    fs.chmodSync(dir, 0o500);
    expect(breaker().admit('claude', LEASE)).toMatchObject({ allowed: false });
    clock = START + 60_000;
    expect(breaker().admit('claude', LEASE)).toEqual(NORMAL);
    clock = START + 10 * 60 * 60_000;
    expect(breaker().admit('claude', LEASE)).toEqual(NORMAL);
  });

  it('treats an unreadable state file as closed', () => {
    fs.writeFileSync(filePath, '{not json');
    expect(breaker().admit('claude', LEASE)).toEqual(NORMAL);
  });

  it.each([
    ['an unknown state', { state: 'half-open' }],
    ['an unparseable next probe time', { nextProbeAt: 'soon' }],
    ['a missing cooldown', { cooldownMs: null }],
    ['a negative streak', { consecutiveFailures: -1 }]
  ])('treats a state with %s as closed', (_label, overrides) => {
    writeRawState(openState(overrides));
    expect(breaker().admit('claude', LEASE)).toEqual(NORMAL);
    expect(claude()).toBeUndefined();
  });

  it('does not trust a next probe further out than the cooldown cap (review case)', () => {
    writeRawState(openState({ nextProbeAt: '2036-01-01T00:00:00.000Z' }));
    expect(breaker().admit('claude', LEASE)).toMatchObject({ allowed: true, probe: true });
  });

  it('does not trust a probe claim dated after now, as after the clock went back (review case)', () => {
    writeRawState(openState({
      nextProbeAt: '2025-12-31T23:59:00.000Z',
      probeClaimId: 'old',
      probeClaimedAt: '2026-01-01T06:00:00.000Z',
      probeLeaseUntil: '2026-01-01T07:00:00.000Z'
    }));
    expect(breaker().admit('claude', LEASE)).toMatchObject({ allowed: true, probe: true });
  });

  it('never grants a lease longer than the longest allowed CLI call (review case: 25-hour lease)', () => {
    const subject = breaker();
    trip(subject);
    clock = START + 60_000;
    expect(subject.admit('claude', 25 * 60 * 60_000)).toMatchObject({ allowed: true, probe: true });
    expect(Date.parse(claude()!.probeLeaseUntil!) - clock).toBe(MAX_PROBE_LEASE_MS);
    expect(breaker().admit('claude', 25 * 60 * 60_000)).toMatchObject({ allowed: false });
    clock += MAX_PROBE_LEASE_MS;
    expect(breaker().admit('claude', LEASE)).toMatchObject({ allowed: true, probe: true });
  });

  it('does not trust a probe lease longer than any CLI call', () => {
    writeRawState(openState({
      nextProbeAt: '2025-12-31T23:59:00.000Z',
      probeClaimId: 'stuck',
      probeClaimedAt: '2025-12-31T23:59:00.000Z',
      probeLeaseUntil: '2036-01-01T00:00:00.000Z'
    }));
    expect(breaker().admit('claude', LEASE)).toMatchObject({ allowed: true, probe: true });
  });

  it('admits the call when a live process keeps the state lock', () => {
    trip(breaker());
    clock = START + 60_000;
    const holder = JSON.stringify({ pid: 4242, ownerId: 'other', acquiredAt: '2026-01-01T00:00:00.000Z' });
    fs.writeFileSync(`${filePath}.lock`, holder);
    expect(breaker({ isProcessRunning: () => true }).admit('claude', LEASE)).toEqual(NORMAL);
    // The live holder's lock is left alone.
    expect(fs.readFileSync(`${filePath}.lock`, 'utf8')).toBe(holder);
  });

  it('takes over the state lock of a dead process, and only that (review case)', () => {
    trip(breaker());
    clock = START + 60_000;
    fs.writeFileSync(`${filePath}.lock`, JSON.stringify({ pid: 4242, ownerId: 'dead', acquiredAt: '2026-01-01T00:00:00.000Z' }));
    const isProcessRunning = (pid: number) => pid !== 4242;
    expect(breaker({ isProcessRunning }).admit('claude', LEASE)).toMatchObject({ allowed: true, probe: true });
    expect(fs.existsSync(`${filePath}.lock`)).toBe(false);
  });

  it('never lets a lock error reach the caller', () => {
    trip(breaker());
    clock = START + 60_000;
    fs.writeFileSync(`${filePath}.lock`, JSON.stringify({ pid: 4242, ownerId: 'x', acquiredAt: '2026-01-01T00:00:00.000Z' }));
    const throwing = breaker({ isProcessRunning: () => { throw new Error('ps failed'); } });
    expect(throwing.admit('claude', LEASE)).toEqual(NORMAL);
    expect(() => throwing.recordFailure('claude', 'provider-rate-limit', NORMAL)).not.toThrow();
    expect(() => throwing.recordSuccess('claude', NORMAL)).not.toThrow();
  });
});

describe('resolveProviderCircuitConfig', () => {
  it('is on by default with conservative limits', () => {
    expect(resolveProviderCircuitConfig({})).toEqual({
      enabled: true,
      failureThreshold: 3,
      cooldownMs: 5 * 60_000,
      maxCooldownMs: 60 * 60_000
    });
  });

  it('reads the overrides and the off switch', () => {
    expect(resolveProviderCircuitConfig({
      CLAUDE_MEMORY_LLM_BREAKER: 'off',
      CLAUDE_MEMORY_LLM_BREAKER_THRESHOLD: '5',
      CLAUDE_MEMORY_LLM_BREAKER_COOLDOWN_MS: '1000',
      CLAUDE_MEMORY_LLM_BREAKER_MAX_COOLDOWN_MS: '9000'
    })).toEqual({ enabled: false, failureThreshold: 5, cooldownMs: 1000, maxCooldownMs: 9000 });
  });

  it('ignores invalid numbers and never caps below the base cooldown', () => {
    expect(resolveProviderCircuitConfig({
      CLAUDE_MEMORY_LLM_BREAKER_THRESHOLD: 'zero',
      CLAUDE_MEMORY_LLM_BREAKER_COOLDOWN_MS: '-5',
      CLAUDE_MEMORY_LLM_BREAKER_MAX_COOLDOWN_MS: '10'
    })).toMatchObject({ failureThreshold: 3, cooldownMs: 5 * 60_000, maxCooldownMs: 5 * 60_000 });
  });
});

describe('getProviderCircuitStatePath', () => {
  it('lives in the memory root', () => {
    expect(getProviderCircuitStatePath('/home/u')).toBe(path.join('/home/u', '.claude-code', 'memory', 'llm-provider-breaker.json'));
  });
});
