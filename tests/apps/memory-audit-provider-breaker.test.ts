import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildMemoryAuditReport, formatMemoryAuditMarkdown } from '../../src/apps/cli/memory-audit-report.js';
import { ProviderCircuitBreaker, getProviderCircuitStatePath } from '../../src/adapters/llm/provider-circuit-breaker.js';
import { getSummaryPendingPath, savePendingSummary } from '../../src/adapters/llm/summary-pending.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-audit-breaker-'));
  roots.push(homeDir);
  return homeDir;
}

describe('audit LLM provider circuit section', () => {
  it('reports open circuits and kept summaries without any provider text', () => {
    const homeDir = home();
    new ProviderCircuitBreaker({
      filePath: getProviderCircuitStatePath(homeDir),
      now: () => NOW.getTime(),
      config: { enabled: true, failureThreshold: 1, cooldownMs: 60_000, maxCooldownMs: 60_000 }
    }).recordFailure('claude', 'provider-rate-limit', { allowed: true, probe: false });
    savePendingSummary('s1', { homeDir, now: () => NOW.getTime() });
    savePendingSummary('s2', { homeDir, now: () => NOW.getTime() });

    const report = buildMemoryAuditReport({ homeDir, allProjects: true, now: NOW });

    expect(report.llmProviderCircuit).toEqual({
      providers: [{
        provider: 'claude',
        state: 'open',
        reason: 'provider-rate-limit',
        consecutiveFailures: 1,
        openedAt: '2026-01-01T00:00:00.000Z',
        nextProbeAt: '2026-01-01T00:01:00.000Z'
      }],
      pendingSummaries: 2
    });
    const markdown = formatMemoryAuditMarkdown(report);
    expect(markdown).toContain('## LLM provider circuit');
    expect(markdown).toContain('| claude | open | provider-rate-limit | 1 | 2026-01-01T00:00:00.000Z | 2026-01-01T00:01:00.000Z |');
    expect(markdown).toContain('Skipped session summaries kept for after recovery: 2');
    expect(markdown).not.toContain('s1');
  });

  it('reports every circuit closed and creates no file when there is no state', () => {
    const homeDir = home();
    const report = buildMemoryAuditReport({ homeDir, allProjects: true, now: NOW });
    expect(report.llmProviderCircuit).toEqual({ providers: [], pendingSummaries: 0 });
    expect(formatMemoryAuditMarkdown(report)).toContain('Every provider circuit is closed.');
    expect(existsSync(getProviderCircuitStatePath(homeDir))).toBe(false);
    expect(existsSync(getSummaryPendingPath({ homeDir }))).toBe(false);
  });
});
