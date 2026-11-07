import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

/**
 * Real-Windows check for the npm spawn fix (issue #131). The unit tests in
 * postinstall-embedding-backend.test.ts only assert which command and options
 * are chosen; this file actually spawns npm. It is skipped everywhere but
 * win32 and runs in the `windows` job of .github/workflows/ci.yml.
 */

const require = createRequire(import.meta.url);

type Invocation = { command: string; args: string[]; shell?: true };
type PostinstallModule = {
  createNpmInvocation(input: { args: string[]; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }): Invocation;
  getManagedBackendDir(rootDir?: string): string;
  runPostinstall(input: Record<string, unknown>): { attempted: boolean; success?: boolean };
};

const postinstall = require('../../scripts/postinstall-embedding-backend.cjs') as PostinstallModule;

// Windows allows a space and `&` in a directory name; both are things a naive
// unquoted `shell: true` command line would break on.
const tempDirs: string[] = [];
function makeAwkwardDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cml win & dir '));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// The npm that ships next to the node running this test, which is where
// `npm run` would point npm_execpath.
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

function runInvocation(invocation: Invocation): string {
  return execFileSync(invocation.command, invocation.args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(invocation.shell ? { shell: true as const } : {})
  });
}

describe.skipIf(process.platform !== 'win32')('npm spawn on real Windows', () => {
  it('finds the npm that ships with this node', () => {
    expect(existsSync(npmCli)).toBe(true);
  });

  it('runs npm through node + npm-cli.js with no shell when npm_execpath is set', () => {
    const dir = makeAwkwardDir();
    const invocation = postinstall.createNpmInvocation({
      args: ['config', 'get', 'offline', '--prefix', dir],
      env: { npm_execpath: npmCli }
    });
    expect(invocation.shell).toBeUndefined();
    expect(invocation.command).toBe(process.execPath);

    expect(runInvocation(invocation).trim()).toBe('false');
    const prefix = runInvocation(postinstall.createNpmInvocation({
      args: ['config', 'get', 'prefix', '--prefix', dir],
      env: { npm_execpath: npmCli }
    })).trim();
    expect(resolve(prefix).toLowerCase()).toBe(resolve(dir).toLowerCase());
  });

  it('runs npm.cmd through the quoted shell fallback when npm_execpath is missing', () => {
    const dir = makeAwkwardDir();
    const invocation = postinstall.createNpmInvocation({
      args: ['config', 'get', 'offline', '--prefix', dir],
      env: {}
    });
    expect(invocation.shell).toBe(true);
    expect(invocation.args).toEqual([]);

    expect(runInvocation(invocation).trim()).toBe('false');
    const prefix = runInvocation(postinstall.createNpmInvocation({
      args: ['config', 'get', 'prefix', '--prefix', dir],
      env: {}
    })).trim();
    expect(resolve(prefix).toLowerCase()).toBe(resolve(dir).toLowerCase());
  });

  for (const [label, env] of [
    ['with npm_execpath', { npm_execpath: npmCli }],
    ['without npm_execpath', {}]
  ] as const) {
    it(`runPostinstall really runs npm in the backend dir ${label}`, () => {
      const rootDir = makeAwkwardDir();
      writeFileSync(join(rootDir, 'package.json'), JSON.stringify({ name: 'claude-memory-layer-install-root' }));
      const emptyCache = makeAwkwardDir();

      // Offline against an empty cache makes npm stop right after reading the
      // manifest it was pointed at, so the test needs no network and installs
      // nothing; the package name in npm's error proves it ran in that dir.
      const spawned: Array<{ error?: Error; status: number | null; output: string }> = [];
      const result = postinstall.runPostinstall({
        rootDir,
        env: { ...process.env, ...env, npm_config_offline: 'true', npm_config_cache: emptyCache },
        platform: 'win32',
        arch: 'x64',
        execFileSyncImpl: () => '',
        isEmbeddingBackendAvailableImpl: () => false,
        spawnSyncImpl: (command: string, args: string[], options: Record<string, unknown>) => {
          const real = spawnSync(command, args, { ...options, stdio: 'pipe', encoding: 'utf8' });
          spawned.push({ error: real.error, status: real.status, output: `${real.stdout}${real.stderr}` });
          return real;
        },
        log: () => undefined,
        warn: () => undefined
      });

      expect(spawned).toHaveLength(1);
      // EINVAL/ENOENT would surface here; a normal npm failure has no error.
      expect(spawned[0]?.error).toBeUndefined();
      expect(spawned[0]?.status).toBeGreaterThan(0);
      expect(spawned[0]?.output).toMatch(/huggingface/i);
      expect(result).toMatchObject({ attempted: true, success: false });
      expect(postinstall.getManagedBackendDir(rootDir)).toContain('&');
    });
  }
});
