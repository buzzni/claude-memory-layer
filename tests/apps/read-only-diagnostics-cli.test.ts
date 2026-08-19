import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { hashProjectPath } from '../../src/core/registry/project-path.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { diffMemoryRootSnapshots, snapshotMemoryRoot } from '../helpers/memory-root-snapshot.js';

// Resolve tsx through module resolution instead of a hardcoded
// node_modules/.bin path: a git worktree without its own install inherits
// node_modules from an ancestor, where the .bin path does not exist.
const require = createRequire(import.meta.url);
const tsxCli = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');

function runCli(homeDir: string, args: string[]) {
  return spawnSync(process.execPath, [tsxCli, 'src/apps/cli/index.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeDir,
      CLAUDE_MEMORY_DISABLE_VECTOR: '1'
    }
  });
}

async function createProjectStore(homeDir: string, projectPath: string): Promise<void> {
  const projectHash = hashProjectPath(projectPath);
  const store = new SQLiteEventStore(path.join(
    homeDir,
    '.claude-code',
    'memory',
    'projects',
    projectHash,
    'events.sqlite'
  ));
  await store.initialize();
  await store.close();
}

describe('read-only diagnostic CLI filesystem invariance', () => {
  it('does not create a store for missing stats, health, or vector-status targets', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-read-cli-missing-'));
    const homeDir = path.join(root, 'home');
    const projectPath = path.join(root, 'missing-project');
    mkdirSync(homeDir);
    const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
    const before = snapshotMemoryRoot(memoryRoot);

    const stats = runCli(homeDir, ['stats', '--project', projectPath]);
    const health = runCli(homeDir, ['health', '--productivity', '--json', '--project', projectPath]);
    const vector = runCli(homeDir, ['vector-status', '--json', '--project', projectPath]);
    const recoveryPreview = runCli(homeDir, ['process', '--dry-run-recovery', '--project', projectPath]);
    const endlessStatus = runCli(homeDir, ['endless', 'status', '--project', projectPath]);
    const retentionAudit = runCli(homeDir, ['retention', 'audit', '--project', projectPath, '--json']);
    const scopeAudit = runCli(homeDir, ['project', 'scope-audit', '--json']);

    expect(stats.status).toBe(0);
    expect(stats.stdout).toContain('Store Status: missing');
    expect(health.status).toBe(0);
    expect(JSON.parse(health.stdout).signals.storage.totalEvents).toBe(0);
    expect(vector.status).toBe(0);
    expect(JSON.parse(vector.stdout).store.status).toBe('missing');
    expect(recoveryPreview.status).toBe(0);
    expect(endlessStatus.status).toBe(0);
    expect(retentionAudit.status).toBe(0);
    expect(scopeAudit.status).toBe(0);
    expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(memoryRoot))).toEqual([]);
  });

  it('does not change an existing store during stats, health, or vector-status reads', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-read-cli-existing-'));
    const homeDir = path.join(root, 'home');
    const projectPath = path.join(root, 'project');
    mkdirSync(homeDir);
    mkdirSync(projectPath);
    await createProjectStore(homeDir, projectPath);
    const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
    const before = snapshotMemoryRoot(memoryRoot);

    expect(runCli(homeDir, ['stats', '--project', projectPath]).status).toBe(0);
    expect(runCli(homeDir, ['health', '--productivity', '--json', '--project', projectPath]).status).toBe(0);
    expect(runCli(homeDir, ['vector-status', '--json', '--project', projectPath]).status).toBe(0);
    expect(runCli(homeDir, ['process', '--dry-run-recovery', '--project', projectPath]).status).toBe(0);
    expect(runCli(homeDir, ['endless', 'status', '--project', projectPath]).status).toBe(0);
    expect(runCli(homeDir, ['retention', 'audit', '--project', projectPath, '--json']).status).toBe(0);

    expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(memoryRoot))).toEqual([]);
  });
});
