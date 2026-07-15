import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

function runCli(args: string[]) {
  return spawnSync('npx', ['tsx', 'src/apps/cli/index.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_MEMORY_DISABLE_VECTOR: '1' },
  });
}

describe('productivity health CLI', () => {
  it('prints Project Health Report JSON without leaking the raw project path', () => {
    const projectPath = mkdtempSync(path.join(tmpdir(), 'cml-productivity-health-project-'));

    const result = runCli(['health', '--productivity', '--json', '--project', projectPath, '--profile', 'reviewer', '--mode', 'observe']);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain(projectPath);
    const report = JSON.parse(result.stdout) as {
      schemaVersion: string;
      status: string;
      profile: string;
      mode: string;
      project: { scope: string; id: string };
      signals: { storage: { totalEvents: number; vectorCount: number } };
      riskGates: Array<{ id: string; status: string }>;
      summary: { warningReasons: string[] };
      nextBestAction: string;
    };
    expect(report.schemaVersion).toBe('agent-productivity-health-v1');
    expect(report.profile).toBe('reviewer');
    expect(report.mode).toBe('observe');
    expect(report.project.scope).toBe('project');
    expect(report.project.id).toMatch(/^[a-f0-9]{8}$/);
    expect(report.signals.storage.totalEvents).toBe(0);
    expect(report.signals.storage.vectorCount).toBe(0);
    expect(report.riskGates.map((gate) => gate.id)).toEqual(['project-scope-known', 'outbox-healthy', 'memory-density', 'derivation-liveness', 'derived-sources-ready']);
    expect(report.summary.warningReasons).toContain('memory_density_low');
    expect(report.nextBestAction).toContain('Import or capture project context');
  });

  it('fails validation before initializing storage for unsupported productivity profiles', () => {
    const projectPath = mkdtempSync(path.join(tmpdir(), 'cml-productivity-health-invalid-'));

    const result = runCli(['health', '--productivity', '--json', '--project', projectPath, '--profile', 'admin']);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Invalid --profile');
    expect(result.stderr).not.toContain(projectPath);
  });
});
