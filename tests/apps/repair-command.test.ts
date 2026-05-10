import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  formatLegacyProjectScopeRepairResult,
  resolveLegacyProjectScopeRepairOptions
} from '../../src/apps/cli/repair-command.js';

describe('legacy project scope repair CLI helpers', () => {
  it('defaults to dry-run repair using the current project path', () => {
    expect(resolveLegacyProjectScopeRepairOptions({ project: '/repo/app' })).toEqual({
      projectPath: '/repo/app',
      projectHash: undefined,
      dryRun: true
    });
  });

  it('requires either project path or project hash', () => {
    expect(() => resolveLegacyProjectScopeRepairOptions({})).toThrow(/requires --project or --project-hash/);
  });

  it('rejects an explicitly empty --project instead of falling back to cwd', () => {
    expect(() => resolveLegacyProjectScopeRepairOptions({ project: '' })).toThrow(/--project must not be empty/);
    expect(() => resolveLegacyProjectScopeRepairOptions({ project: '   ' })).toThrow(/--project must not be empty/);
  });

  it('uses --apply to opt into mutation', () => {
    expect(resolveLegacyProjectScopeRepairOptions({ projectHash: 'abc12345', apply: true })).toEqual({
      projectPath: undefined,
      projectHash: 'abc12345',
      dryRun: false
    });
  });

  it('rejects mismatched --project and --project-hash instead of using a foreign hash on the selected store', () => {
    expect(() => resolveLegacyProjectScopeRepairOptions({
      project: '/repo/app',
      projectHash: 'deadbeef'
    })).toThrow(/different project stores/);
  });

  it('formats aggregate repair results without raw project paths', () => {
    const output = formatLegacyProjectScopeRepairResult({
      dryRun: true,
      projectHash: 'abc12345',
      scanned: 4,
      repaired: 1,
      quarantined: 2,
      alreadyScoped: 1,
      skipped: 0,
      samples: [
        { eventId: 'event-a', action: 'repaired', reason: 'same-project-path' },
        { eventId: 'event-b', action: 'quarantined', reason: 'project-path-mismatch' }
      ]
    });

    expect(output).toContain('Mode: dry-run');
    expect(output).toContain('Project: abc12345');
    expect(output).toContain('Repaired: 1');
    expect(output).toContain('Quarantined: 2');
    expect(output).toContain('event-b quarantined project-path-mismatch');
    expect(output).not.toContain('/repo/');
  });

  it('does not create missing hash-only project storage during dry-run', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cml-repair-cli-home-'));
    try {
      const result = spawnSync('npx', ['tsx', 'src/apps/cli/index.ts', 'repair', 'legacy-project-scope', '--project-hash', 'deadbeef'], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        encoding: 'utf8'
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Mode: dry-run');
      expect(result.stdout).toContain('Scanned: 0');
      expect(existsSync(path.join(home, '.claude-code'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
