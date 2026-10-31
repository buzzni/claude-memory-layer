import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const repoPackageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

function writeJson(filePath: string, data: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function readJson<T = Record<string, unknown>>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

/**
 * The scripts resolve the repository root from their own location, so copying
 * them into a temp tree makes that tree the root they guard and rewrite.
 */
function makeFixtureRepo(name: string, versions: { pkg: string; plugin: string }): string {
  const root = mkdtempSync(path.join(tmpdir(), `cml-manifest-versions-${name}-`));
  mkdirSync(path.join(root, 'scripts'));
  mkdirSync(path.join(root, '.claude-plugin'));
  for (const script of ['guard-release-artifact.cjs', 'sync-manifest-versions.cjs']) {
    copyFileSync(path.join(repoRoot, 'scripts', script), path.join(root, 'scripts', script));
  }
  writeJson(path.join(root, 'package.json'), {
    name: 'cml-fixture',
    version: versions.pkg,
    scripts: { version: repoPackageJson.scripts.version }
  });
  writeJson(path.join(root, 'package-lock.json'), {
    name: 'cml-fixture',
    version: versions.pkg,
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'cml-fixture', version: versions.pkg } }
  });
  writeJson(path.join(root, '.claude-plugin', 'plugin.json'), {
    name: 'cml-fixture',
    description: 'fixture plugin',
    version: versions.plugin,
    keywords: ['memory']
  });
  return root;
}

function runGuard(root: string) {
  return spawnSync('node', [path.join(root, 'scripts', 'guard-release-artifact.cjs'), 'manifest-versions'], {
    cwd: root,
    encoding: 'utf8'
  });
}

function run(root: string, command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'cml-test',
      GIT_AUTHOR_EMAIL: 'cml-test@example.invalid',
      GIT_COMMITTER_NAME: 'cml-test',
      GIT_COMMITTER_EMAIL: 'cml-test@example.invalid'
    }
  });
  expect(result.status, `${command} ${args.join(' ')}\n${result.stdout}${result.stderr}`).toBe(0);
  return result;
}

describe('release manifest version guard', () => {
  it('fails when a plugin manifest version drifts from package.json', () => {
    const root = makeFixtureRepo('drift', { pkg: '2.4.17', plugin: '1.0.0' });

    const result = runGuard(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.claude-plugin/plugin.json');
    expect(result.stderr).toContain('1.0.0');
    expect(result.stderr).toContain('2.4.17');
  });

  it('fails when a plugin manifest has no version field', () => {
    const root = makeFixtureRepo('missing', { pkg: '2.4.17', plugin: '2.4.17' });
    const pluginPath = path.join(root, '.claude-plugin', 'plugin.json');
    const { version: _version, ...withoutVersion } = readJson(pluginPath);
    writeJson(pluginPath, withoutVersion);

    const result = runGuard(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.claude-plugin/plugin.json');
  });

  it('passes when every manifest matches package.json', () => {
    const root = makeFixtureRepo('match', { pkg: '2.4.17', plugin: '2.4.17' });

    const result = runGuard(root);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ check: 'manifest-versions', version: '2.4.17', ok: true });
  });

  it('passes on this repository', () => {
    const result = spawnSync('node', ['scripts/guard-release-artifact.cjs', 'manifest-versions'], {
      cwd: repoRoot,
      encoding: 'utf8'
    });

    expect(result.status, result.stderr).toBe(0);
  });
});

describe('manifest version sync on npm version', () => {
  it('lets the documented `npm version` + `git commit -am` release commit carry synced manifests', () => {
    const root = makeFixtureRepo('npm-version', { pkg: '2.4.17', plugin: '2.4.17' });
    run(root, 'git', ['init', '-q']);
    run(root, 'git', ['add', '-A']);
    run(root, 'git', ['commit', '-q', '-m', 'init']);

    run(root, 'npm', ['version', 'patch', '--no-git-tag-version']);
    run(root, 'git', ['commit', '-q', '-am', 'chore(release): v2.4.18']);

    expect(run(root, 'git', ['status', '--porcelain']).stdout).toBe('');
    const committedPlugin = JSON.parse(run(root, 'git', ['show', 'HEAD:.claude-plugin/plugin.json']).stdout);
    expect(committedPlugin.version).toBe('2.4.18');
    expect(runGuard(root).status).toBe(0);
  });

  it('rewrites only the version field and keeps the manifest formatting', () => {
    const root = makeFixtureRepo('format', { pkg: '3.0.0', plugin: '1.0.0' });

    run(root, 'node', ['scripts/sync-manifest-versions.cjs']);

    expect(readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).toBe(`${JSON.stringify({
      name: 'cml-fixture',
      description: 'fixture plugin',
      version: '3.0.0',
      keywords: ['memory']
    }, null, 2)}\n`);
  });
});
