import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { checkProviderBreaker, gatherProviderBreakerFacts } from '../../src/apps/cli/doctor.js';
import { ProviderCircuitBreaker, getProviderCircuitStatePath, type ProviderCircuitState } from '../../src/adapters/llm/provider-circuit-breaker.js';
import { savePendingSummary } from '../../src/adapters/llm/summary-pending.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const open = (overrides: Partial<ProviderCircuitState> = {}): ProviderCircuitState => ({
  state: 'open',
  consecutiveFailures: 3,
  reason: 'provider-rate-limit',
  openedAt: '2026-01-01T00:00:00.000Z',
  nextProbeAt: '2026-01-01T00:05:00.000Z',
  cooldownMs: 300_000,
  probeClaimId: null,
  probeClaimedAt: null,
  probeLeaseUntil: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides
});

describe('checkProviderBreaker', () => {
  it('passes when every provider circuit is closed', () => {
    expect(checkProviderBreaker({ enabled: true, states: {}, pendingSummaries: 0 })).toEqual({
      name: 'llm-provider-breaker',
      status: 'pass',
      detail: 'closed'
    });
  });

  it('warns with the reason, next probe and kept summaries while a circuit is open', () => {
    const result = checkProviderBreaker({ enabled: true, states: { claude: open() }, pendingSummaries: 4 });
    expect(result).toMatchObject({
      name: 'llm-provider-breaker',
      status: 'warn',
      detail: 'claude open since 2026-01-01T00:00:00.000Z (provider-rate-limit), next probe at 2026-01-01T00:05:00.000Z; '
        + '4 skipped session summaries kept for after recovery'
    });
    expect(result.fix).toContain('usage limit');
  });

  it('points at the login when authentication opened the circuit', () => {
    const result = checkProviderBreaker({ enabled: true, states: { codex: open({ reason: 'provider-auth' }) }, pendingSummaries: 0 });
    expect(result.fix).toContain('Log in to the codex CLI');
  });

  it('reports a failure streak below the threshold and kept summaries while closed', () => {
    const streak = open({ state: 'closed', consecutiveFailures: 2, openedAt: null, nextProbeAt: null, cooldownMs: null });
    expect(checkProviderBreaker({ enabled: true, states: { claude: streak }, pendingSummaries: 1 })).toEqual({
      name: 'llm-provider-breaker',
      status: 'pass',
      detail: 'closed (claude: 2 consecutive provider-rate-limit failures); 1 skipped session summary kept for after recovery'
    });
  });

  it('says when this shell has the breaker turned off', () => {
    expect(checkProviderBreaker({ enabled: false, states: {}, pendingSummaries: 0 }).detail)
      .toBe('disabled in this shell (CLAUDE_MEMORY_LLM_BREAKER=off)');
  });
});

describe('gatherProviderBreakerFacts', () => {
  it('reads the breaker state and the kept summaries from the memory root', () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-doctor-breaker-'));
    roots.push(homeDir);
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    const breaker = new ProviderCircuitBreaker({
      filePath: getProviderCircuitStatePath(homeDir),
      now: () => now,
      config: { enabled: true, failureThreshold: 1, cooldownMs: 1000, maxCooldownMs: 1000 }
    });
    breaker.recordFailure('claude', 'provider-auth', { allowed: true, probe: false });
    savePendingSummary('s1', { homeDir, now: () => now });

    const facts = gatherProviderBreakerFacts({ env: {}, homeDir, now: () => now });
    expect(facts.enabled).toBe(true);
    expect(facts.states.claude).toMatchObject({ state: 'open', reason: 'provider-auth' });
    expect(facts.pendingSummaries).toBe(1);
  });
});
