import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('actors repair CLI', () => {
  it('dry-runs missing project storage without creating memory directories', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cml-actors-repair-home-'));
    const project = mkdtempSync(path.join(tmpdir(), 'cml-actors-repair-project-'));
    try {
      const result = spawnSync('npx', [
        'tsx',
        'src/apps/cli/index.ts',
        'actors',
        'repair',
        '--project',
        project,
        '--dry-run',
        '--json'
      ], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        encoding: 'utf8'
      });

      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(payload).toMatchObject({
        operation: 'actors-repair',
        dryRun: true,
        scannedEvents: 0,
        scannedSessions: 0,
        actorsWouldCreate: 0,
        membershipsWouldCreate: 0
      });
      expect(existsSync(path.join(home, '.claude-code'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('rejects conflicting --apply and --dry-run flags', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cml-actors-repair-home-'));
    const project = mkdtempSync(path.join(tmpdir(), 'cml-actors-repair-project-'));
    try {
      const result = spawnSync('npx', [
        'tsx',
        'src/apps/cli/index.ts',
        'actors',
        'repair',
        '--project',
        project,
        '--apply',
        '--dry-run'
      ], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        encoding: 'utf8'
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('either --apply or --dry-run');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});
