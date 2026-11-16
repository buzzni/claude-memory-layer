import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ProviderCircuitBreaker,
  getProviderCircuitStatePath,
  readProviderCircuitStates,
  resolveProviderCircuitConfig,
  type ProviderCircuitConfig
} from '../../src/adapters/llm/provider-circuit-breaker.js';

const START = Date.parse('2026-01-01T00:00:00.000Z');
const CONFIG: ProviderCircuitConfig = {
  enabled: true,
  failureThreshold: 3,
  cooldownMs: 60_000,
  maxCooldownMs: 200_000
};

let dir: string;
let clock: number;
let filePath: string;

function breaker(config: ProviderCircuitConfig = CONFIG): ProviderCircuitBreaker {
  return new ProviderCircuitBreaker({ filePath, now: () => clock, config });
}

function trip(target: ProviderCircuitBreaker, code = 'provider-rate-limit'): void {
  for (let i = 0; i < CONFIG.failureThreshold; i += 1) target.recordFailure('claude', code, { probe: false });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cml-breaker-'));
  filePath = path.join(dir, 'llm-provider-breaker.json');
  clock = START;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ProviderCircuitBreaker', () => {
  it('admits calls while closed and writes nothing on success', () => {
    const subject = breaker();
    expect(subject.admit('claude')).toEqual({ allowed: true, probe: false });
    subject.recordSuccess('claude');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('opens after the threshold of consecutive quota failures and then skips calls', () => {
    const subject = breaker();
    subject.recordFailure('claude', 'provider-rate-limit', { probe: false });
    subject.recordFailure('claude', 'provider-rate-limit', { probe: false });
    expect(subject.admit('claude')).toEqual({ allowed: true, probe: false });

    subject.recordFailure('claude', 'provider-rate-limit', { probe: false });
    expect(subject.admit('claude')).toEqual({ allowed: false, nextProbeAt: '2026-01-01T00:01:00.000Z' });
    expect(readProviderCircuitStates(filePath).claude).toMatchObject({
      state: 'open',
      reason: 'provider-rate-limit',
      openedAt: '2026-01-01T00:00:00.000Z',
      nextProbeAt: '2026-01-01T00:01:00.000Z',
      cooldownMs: 60_000
    });
  });

  it('opens on authentication failures too', () => {
    const subject = breaker();
    trip(subject, 'provider-auth');
    expect(readProviderCircuitStates(filePath).claude).toMatchObject({ state: 'open', reason: 'provider-auth' });
  });

  it.each(['provider-timeout', 'provider-error', 'provider-not-found'])(
    'never opens on %s, which may pass on the next try',
    (code) => {
      const subject = breaker();
      for (let i = 0; i < 10; i += 1) subject.recordFailure('claude', code, { probe: false });
      expect(subject.admit('claude')).toEqual({ allowed: true, probe: false });
      expect(fs.existsSync(filePath)).toBe(false);
    }
  );

  it('neither counts nor resets the streak on a transient failure', () => {
    const subject = breaker();
    subject.recordFailure('claude', 'provider-rate-limit', { probe: false });
    subject.recordFailure('claude', 'provider-rate-limit', { probe: false });
    subject.recordFailure('claude', 'provider-timeout', { probe: false });
    subject.recordFailure('claude', 'provider-rate-limit', { probe: false });
    expect(readProviderCircuitStates(filePath).claude?.state).toBe('open');
  });

  it('resets the streak on success', () => {
    const subject = breaker();
    subject.recordFailure('claude', 'provider-rate-limit', { probe: false });
    subject.recordFailure('claude', 'provider-rate-limit', { probe: false });
    subject.recordSuccess('claude');
    subject.recordFailure('claude', 'provider-rate-limit', { probe: false });
    expect(subject.admit('claude')).toEqual({ allowed: true, probe: false });
    expect(readProviderCircuitStates(filePath).claude).toMatchObject({ state: 'closed', consecutiveFailures: 1 });
  });

  it('keeps providers apart', () => {
    const subject = breaker();
    trip(subject);
    expect(subject.admit('codex')).toEqual({ allowed: true, probe: false });
  });

  it('lets exactly one probe through after the cooldown', () => {
    const subject = breaker();
    trip(subject);
    clock = START + 60_000;
    expect(subject.admit('claude')).toEqual({ allowed: true, probe: true });
    expect(subject.admit('claude')).toEqual({ allowed: false, nextProbeAt: '2026-01-01T00:01:00.000Z' });
    // A second breaker instance stands in for another process.
    expect(breaker().admit('claude')).toMatchObject({ allowed: false });
  });

  it('closes when the probe succeeds', () => {
    const subject = breaker();
    trip(subject);
    clock = START + 60_000;
    subject.admit('claude');
    subject.recordSuccess('claude');
    expect(subject.admit('claude')).toEqual({ allowed: true, probe: false });
    expect(readProviderCircuitStates(filePath).claude).toBeUndefined();
  });

  it('reopens with a doubled cooldown, capped, when the probe fails the same way', () => {
    const subject = breaker();
    trip(subject);

    clock = START + 60_000;
    subject.admit('claude');
    subject.recordFailure('claude', 'provider-rate-limit', { probe: true });
    expect(readProviderCircuitStates(filePath).claude).toMatchObject({
      state: 'open', cooldownMs: 120_000, nextProbeAt: '2026-01-01T00:03:00.000Z', probeClaimedAt: null
    });

    clock = START + 180_000;
    subject.admit('claude');
    subject.recordFailure('claude', 'provider-auth', { probe: true });
    expect(readProviderCircuitStates(filePath).claude).toMatchObject({
      cooldownMs: 200_000, reason: 'provider-auth', nextProbeAt: '2026-01-01T00:06:20.000Z'
    });
  });

  it('keeps the cooldown when the probe fails transiently', () => {
    const subject = breaker();
    trip(subject);
    clock = START + 60_000;
    subject.admit('claude');
    subject.recordFailure('claude', 'provider-timeout', { probe: true });
    expect(readProviderCircuitStates(filePath).claude).toMatchObject({
      state: 'open', cooldownMs: 60_000, nextProbeAt: '2026-01-01T00:02:00.000Z', probeClaimedAt: null
    });
  });

  it('ignores the late failure of a call admitted before the circuit opened', () => {
    const subject = breaker();
    trip(subject);
    clock = START + 60_000;
    subject.admit('claude');
    subject.recordFailure('claude', 'provider-rate-limit', { probe: false });
    // The probe claim is untouched; nobody else may probe.
    expect(readProviderCircuitStates(filePath).claude?.probeClaimedAt).toBe('2026-01-01T00:01:00.000Z');
  });

  it('lets another probe through once a probe claim is abandoned', () => {
    const subject = breaker();
    trip(subject);
    clock = START + 60_000;
    subject.admit('claude');
    // The prober died without recording an outcome.
    clock = START + 60_000 + 11 * 60_000;
    expect(breaker().admit('claude')).toEqual({ allowed: true, probe: true });
  });

  it('admits everything and records nothing when disabled', () => {
    const subject = breaker({ ...CONFIG, enabled: false });
    trip(subject);
    expect(subject.admit('claude')).toEqual({ allowed: true, probe: false });
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('treats an unreadable state file as closed', () => {
    fs.writeFileSync(filePath, '{not json');
    expect(breaker().admit('claude')).toEqual({ allowed: true, probe: false });
  });

  it('skips while another process holds the state lock', () => {
    const subject = breaker();
    trip(subject);
    clock = START + 60_000;
    fs.writeFileSync(`${filePath}.lock`, '');
    expect(subject.admit('claude')).toMatchObject({ allowed: false });
  });

  it('breaks a state lock left behind by a dead process', () => {
    const subject = breaker();
    trip(subject);
    clock = START + 60_000;
    const lock = `${filePath}.lock`;
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    expect(subject.admit('claude')).toEqual({ allowed: true, probe: true });
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
