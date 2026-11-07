import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type SpawnCall = {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  shell?: boolean;
};

type ExecFileSyncLike = (cmd: string, args: string[], options?: unknown) => string | Buffer;

type PostinstallEmbeddingBackend = {
  EMBEDDING_BACKEND_PACKAGE: string;
  MANAGED_EMBEDDING_BACKEND_DIR: string;
  SHARP_VERSION: string;
  getManagedBackendDir(rootDir?: string): string;
  createManagedBackendManifest(): Record<string, unknown>;
  parseCudaMajor(output: string): number | null;
  isSkipRequested(env: NodeJS.ProcessEnv): boolean;
  isEmbeddingBackendAvailable(rootDir?: string, execFileSyncImpl?: ExecFileSyncLike): boolean;
  shouldAttemptAutoInstall(input: {
    platform: NodeJS.Platform;
    arch: string;
    cudaMajor: number | null;
    transformersAvailable: boolean;
    skipRequested: boolean;
  }): boolean;
  createRepairEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  createNpmInstallArgs(rootDir?: string): string[];
  createNpmInvocation(input: {
    args: string[];
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    execPath?: string;
    existsSyncImpl?: (filePath: string) => boolean;
  }): { command: string; args: string[]; shell?: true };
  runPostinstall(input?: {
    rootDir?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    arch?: string;
    execFileSyncImpl?: ExecFileSyncLike;
    isEmbeddingBackendAvailableImpl?: (rootDir: string, execFileSyncImpl: ExecFileSyncLike) => boolean;
    existsSyncImpl?: (filePath: string) => boolean;
    spawnSyncImpl?: (cmd: string, args: string[], options: { env: NodeJS.ProcessEnv; shell?: boolean }) => { status: number };
    log?: () => void;
    warn?: () => void;
  }): { attempted: boolean; success?: boolean; cudaMajor: number | null; transformersAvailable: boolean; skipRequested: boolean };
};

function loadPostinstallModule(): PostinstallEmbeddingBackend {
  return require('../../scripts/postinstall-embedding-backend.cjs') as PostinstallEmbeddingBackend;
}

describe('embedding backend postinstall repair', () => {
  it('pins security-patched server and image dependencies on the supported Node runtime', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as {
      engines?: Record<string, string>;
      dependencies?: Record<string, string>;
      overrides?: Record<string, string>;
    };

    expect(pkg.engines?.node).toBe('>=20.19.0');
    expect(pkg.dependencies?.['@hono/node-server']).toBe('^2.0.12');
    expect(pkg.overrides?.sharp).toBe('0.35.4');
  });

  it('installs the secured embedding backend through the required-backend repair hook', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as {
      scripts: Record<string, string>;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(pkg.dependencies ?? {}).not.toHaveProperty('@huggingface/transformers');
    expect(pkg.optionalDependencies ?? {}).not.toHaveProperty('@huggingface/transformers');
    expect(pkg.devDependencies?.['@huggingface/transformers']).toBe('3.8.1');
    expect(pkg.scripts.postinstall).toBe('node scripts/postinstall-embedding-backend.cjs');
  });

  it('only skips required-backend repair when the explicit repair guards are set', () => {
    const postinstall = loadPostinstallModule();

    expect(postinstall.isSkipRequested({ CLAUDE_MEMORY_LAYER_SKIP_EMBEDDING_POSTINSTALL: '1' })).toBe(true);
    expect(postinstall.isSkipRequested({ CLAUDE_MEMORY_LAYER_EMBEDDING_POSTINSTALL_REPAIR: '1' })).toBe(true);
    expect(postinstall.isSkipRequested({ npm_config_optional: 'false' })).toBe(false);
    expect(postinstall.isSkipRequested({ npm_config_omit: 'optional' })).toBe(false);
  });

  it('detects CUDA major version from nvcc output', () => {
    const postinstall = loadPostinstallModule();

    expect(postinstall.parseCudaMajor('Cuda compilation tools, release 11.8, V11.8.89')).toBe(11);
    expect(postinstall.parseCudaMajor('Cuda compilation tools, release 12.4, V12.4.131')).toBe(12);
    expect(postinstall.parseCudaMajor('nvcc: NVIDIA (R) Cuda compiler driver')).toBeNull();
  });

  it('auto-installs a missing managed embedding backend', () => {
    const postinstall = loadPostinstallModule();

    expect(postinstall.shouldAttemptAutoInstall({
      platform: 'linux',
      arch: 'x64',
      cudaMajor: 11,
      transformersAvailable: false,
      skipRequested: false
    })).toBe(true);

    expect(postinstall.shouldAttemptAutoInstall({
      platform: 'linux',
      arch: 'x64',
      cudaMajor: null,
      transformersAvailable: false,
      skipRequested: false
    })).toBe(true);

    expect(postinstall.shouldAttemptAutoInstall({
      platform: 'linux',
      arch: 'x64',
      cudaMajor: 12,
      transformersAvailable: false,
      skipRequested: false
    })).toBe(true);

    expect(postinstall.shouldAttemptAutoInstall({
      platform: 'linux',
      arch: 'x64',
      cudaMajor: null,
      transformersAvailable: true,
      skipRequested: false
    })).toBe(false);

    expect(postinstall.shouldAttemptAutoInstall({
      platform: 'linux',
      arch: 'x64',
      cudaMajor: 11,
      transformersAvailable: true,
      skipRequested: false
    })).toBe(true);

    expect(postinstall.shouldAttemptAutoInstall({
      platform: 'linux',
      arch: 'arm64',
      cudaMajor: null,
      transformersAvailable: false,
      skipRequested: false
    })).toBe(true);

    expect(postinstall.shouldAttemptAutoInstall({
      platform: 'darwin',
      arch: 'x64',
      cudaMajor: null,
      transformersAvailable: false,
      skipRequested: false
    })).toBe(true);

    expect(postinstall.shouldAttemptAutoInstall({
      platform: 'linux',
      arch: 'x64',
      cudaMajor: null,
      transformersAvailable: false,
      skipRequested: true
    })).toBe(false);
  });

  it('repairs missing transformers with CPU-only onnxruntime install settings', () => {
    const postinstall = loadPostinstallModule();
    const rootDir = '/tmp/claude-memory-layer-package';

    expect(postinstall.createRepairEnv({})).toMatchObject({
      ONNXRUNTIME_NODE_INSTALL_CUDA: 'skip',
      npm_config_onnxruntime_node_install_cuda: 'skip',
      CLAUDE_MEMORY_LAYER_EMBEDDING_POSTINSTALL_REPAIR: '1'
    });
    expect(postinstall.createManagedBackendManifest()).toEqual({
      private: true,
      dependencies: { '@huggingface/transformers': '3.8.1' },
      overrides: { sharp: '0.35.4' }
    });
    expect(postinstall.createNpmInstallArgs(rootDir)).toEqual([
      'install',
      '--prefix',
      join(rootDir, 'node_modules', postinstall.MANAGED_EMBEDDING_BACKEND_DIR),
      '--omit=dev'
    ]);
  });

  it('drops the parent npm run\'s global-install settings from the repair env', () => {
    // `npm install -g claude-memory-layer` exports its own config to this
    // script. Inheriting it put the nested `npm install --prefix <backend>`
    // into global mode, so transformers landed in <backend>/lib/node_modules
    // (the global layout) instead of <backend>/node_modules and every mem-*
    // tool failed with "Required embedding backend is not installed".
    const postinstall = loadPostinstallModule();

    const repairEnv = postinstall.createRepairEnv({
      npm_config_global: 'true',
      npm_config_location: 'global',
      npm_config_prefix: '/Users/someone/.hermes/node',
      npm_config_local_prefix: '/Users/someone/.hermes/node/lib/node_modules/claude-memory-layer',
      npm_config_registry: 'https://registry.example.com/',
      PATH: '/usr/bin'
    });

    expect(repairEnv.npm_config_global).toBeUndefined();
    expect(repairEnv.npm_config_location).toBeUndefined();
    expect(repairEnv.npm_config_prefix).toBeUndefined();
    expect(repairEnv.npm_config_local_prefix).toBeUndefined();

    // Unrelated npm settings the user needs to reach the registry must survive.
    expect(repairEnv.npm_config_registry).toBe('https://registry.example.com/');
    expect(repairEnv.PATH).toBe('/usr/bin');
    expect(repairEnv.ONNXRUNTIME_NODE_INSTALL_CUDA).toBe('skip');
  });

  it('reports failure when the install exits 0 but leaves the backend unusable', () => {
    // The npm child can succeed while installing into the wrong layout, which
    // is how a broken backend previously passed as "repaired" and stayed
    // broken until every mem-* tool failed days later.
    const postinstall = loadPostinstallModule();
    const warnings: string[] = [];

    const result = postinstall.runPostinstall({
      rootDir: '/tmp/claude-memory-layer-package',
      env: {},
      isEmbeddingBackendAvailableImpl: () => false,
      spawnSyncImpl: () => ({ status: 0 }),
      log: () => {},
      warn: (message: string) => warnings.push(String(message))
    });

    expect(result).toMatchObject({ attempted: true, success: false });
    expect(warnings.join('\n')).toMatch(/repair failed|unavailable/i);
  });

  it('treats a resolvable but unloadable backend as unavailable so postinstall can repair it', () => {
    const postinstall = loadPostinstallModule();

    expect(postinstall.isEmbeddingBackendAvailable(process.cwd(), () => {
      throw new Error('native binding missing');
    })).toBe(false);
  });

  it('does not mistake the checkout dependency for an installed managed backend', () => {
    const postinstall = loadPostinstallModule();
    const rootDir = mkdtempSync(join(process.cwd(), '.cml-healthcheck-test-'));

    try {
      expect(postinstall.isEmbeddingBackendAvailable(rootDir)).toBe(false);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('runs the repair command when Linux x64 is missing the required backend without detectable CUDA', () => {
    const postinstall = loadPostinstallModule();
    const rootDir = mkdtempSync(join(tmpdir(), 'cml-postinstall-test-'));
    const calls: SpawnCall[] = [];

    try {
      writeFileSync(join(rootDir, 'package.json'), JSON.stringify({ name: 'claude-memory-layer-install-root' }));

      const result = postinstall.runPostinstall({
        rootDir,
        env: {},
        platform: 'linux',
        arch: 'x64',
        execFileSyncImpl: () => '',
        // Unavailable on the pre-check, usable once the repair has run — the
        // health check is consulted on both sides of the install.
        isEmbeddingBackendAvailableImpl: () => calls.length > 0,
        spawnSyncImpl: (cmd, args, options) => {
          calls.push({ cmd, args, env: options.env });
          return { status: 0 };
        },
        log: () => undefined,
        warn: () => undefined
      });

      expect(result).toMatchObject({ attempted: true, success: true, cudaMajor: null, transformersAvailable: false });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.cmd).toBe('npm');
      expect(calls[0]?.args).toEqual(postinstall.createNpmInstallArgs(rootDir));
      expect(calls[0]?.env.ONNXRUNTIME_NODE_INSTALL_CUDA).toBe('skip');
      expect(calls[0]?.env.npm_config_onnxruntime_node_install_cuda).toBe('skip');
      expect(calls[0]?.env.CLAUDE_MEMORY_LAYER_EMBEDDING_POSTINSTALL_REPAIR).toBe('1');
      const backendManifest = JSON.parse(readFileSync(
        join(postinstall.getManagedBackendDir(rootDir), 'package.json'),
        'utf-8'
      ));
      expect(backendManifest).toEqual(postinstall.createManagedBackendManifest());
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  describe('npm invocation on Windows', () => {
    // Node 18.20.2+/20.12.2+ (CVE-2024-27980) throws EINVAL when a .cmd/.bat is
    // spawned without a shell, so Windows never gets a bare `npm.cmd` spawn.
    const NPM_CLI = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
    const NODE_EXE = 'C:\\Program Files\\nodejs\\node.exe';
    const args = ['install', '--prefix', 'C:\\Users\\Jane Doe\\backend dir', '--omit=dev'];

    it('keeps the plain npm command on POSIX, even when npm_execpath is set', () => {
      const postinstall = loadPostinstallModule();
      for (const platform of ['linux', 'darwin'] as const) {
        expect(postinstall.createNpmInvocation({
          args,
          platform,
          env: { npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' },
          existsSyncImpl: () => true
        })).toEqual({ command: 'npm', args });
      }
    });

    it('runs npm-cli.js with the current node on Windows, without a shell', () => {
      const postinstall = loadPostinstallModule();
      expect(postinstall.createNpmInvocation({
        args,
        platform: 'win32',
        env: { npm_execpath: NPM_CLI },
        execPath: NODE_EXE,
        existsSyncImpl: (file) => file === NPM_CLI
      })).toEqual({ command: NODE_EXE, args: [NPM_CLI, ...args] });
    });

    it('falls back to a quoted shell command when npm_execpath is missing', () => {
      const postinstall = loadPostinstallModule();
      expect(postinstall.createNpmInvocation({
        args,
        platform: 'win32',
        env: {},
        execPath: NODE_EXE,
        existsSyncImpl: () => true
      })).toEqual({
        // One pre-built command line and no args: on Node 24+ args plus
        // shell:true is DEP0190, and Node sends the same string either way.
        command: 'npm.cmd install --prefix "C:\\Users\\Jane Doe\\backend dir" --omit=dev',
        args: [],
        shell: true
      });
    });

    it('does not trust an npm_execpath that is another package manager or does not exist', () => {
      const postinstall = loadPostinstallModule();
      const shellFallback = {
        command: 'npm.cmd install --prefix "C:\\Users\\Jane Doe\\backend dir" --omit=dev',
        args: [],
        shell: true
      };
      expect(postinstall.createNpmInvocation({
        args,
        platform: 'win32',
        env: { npm_execpath: 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs' },
        execPath: NODE_EXE,
        existsSyncImpl: () => true
      })).toEqual(shellFallback);
      expect(postinstall.createNpmInvocation({
        args,
        platform: 'win32',
        env: { npm_execpath: NPM_CLI },
        execPath: NODE_EXE,
        existsSyncImpl: () => false
      })).toEqual(shellFallback);
    });

    it('quotes only the shell-fallback arguments that need it', () => {
      const postinstall = loadPostinstallModule();
      const invocation = postinstall.createNpmInvocation({
        args: ['config', 'get', 'offline', '--prefix', 'C:\\a&b\\x', 'C:\\plain\\dir', 'C:\\trail dir\\'],
        platform: 'win32',
        env: {}
      });
      expect(invocation.args).toEqual([]);
      expect(invocation.command).toBe(
        'npm.cmd config get offline --prefix "C:\\a&b\\x" C:\\plain\\dir "C:\\trail dir\\\\"'
      );
    });

    it('refuses to build a shell command from an argument cmd.exe would expand or split', () => {
      const postinstall = loadPostinstallModule();
      for (const bad of ['C:\\50%\\dir', 'C:\\say "hi"\\dir', 'C:\\a\nb']) {
        expect(() => postinstall.createNpmInvocation({ args: ['--prefix', bad], platform: 'win32', env: {} })).toThrow(/cannot be passed safely/);
      }
      // Without the shell nothing is interpreted, so the same path is fine.
      expect(postinstall.createNpmInvocation({
        args: ['--prefix', 'C:\\50%\\dir'],
        platform: 'win32',
        env: { npm_execpath: NPM_CLI },
        execPath: NODE_EXE,
        existsSyncImpl: () => true
      }).args).toEqual([NPM_CLI, '--prefix', 'C:\\50%\\dir']);
    });

    function runOnWindows(env: NodeJS.ProcessEnv, existsSyncImpl: (file: string) => boolean) {
      const postinstall = loadPostinstallModule();
      const rootDir = mkdtempSync(join(tmpdir(), 'cml postinstall win '));
      const calls: SpawnCall[] = [];
      try {
        writeFileSync(join(rootDir, 'package.json'), JSON.stringify({ name: 'claude-memory-layer-install-root' }));
        const result = postinstall.runPostinstall({
          rootDir,
          env,
          platform: 'win32',
          arch: 'x64',
          execFileSyncImpl: () => '',
          isEmbeddingBackendAvailableImpl: () => calls.length > 0,
          existsSyncImpl,
          spawnSyncImpl: (cmd, spawnArgs, options) => {
            calls.push({ cmd, args: spawnArgs, env: options.env, shell: options.shell });
            return { status: 0 };
          },
          log: () => undefined,
          warn: () => undefined
        });
        return { result, calls, installArgs: postinstall.createNpmInstallArgs(rootDir) };
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    }

    it('spawns node + npm-cli.js with no shell option when npm_execpath is usable', () => {
      const { result, calls, installArgs } = runOnWindows({ npm_execpath: NPM_CLI }, () => true);
      expect(result).toMatchObject({ attempted: true, success: true });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.cmd).toBe(process.execPath);
      expect(calls[0]?.args).toEqual([NPM_CLI, ...installArgs]);
      expect(calls[0]?.shell).toBeUndefined();
    });

    it('spawns npm.cmd through a shell with the backend path quoted otherwise', () => {
      const { result, calls, installArgs } = runOnWindows({}, () => false);
      expect(result).toMatchObject({ attempted: true, success: true });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.shell).toBe(true);
      // No args alongside the shell (DEP0190); the temp root has spaces, so
      // every path-bearing argument is quoted inside the command line.
      expect(calls[0]?.args).toEqual([]);
      expect(calls[0]?.cmd).toBe(['npm.cmd', ...installArgs.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))].join(' '));
      expect(calls[0]?.cmd).toContain('"');
    });

    it('reports a path it cannot quote as a failed repair instead of throwing', () => {
      const postinstall = loadPostinstallModule();
      const rootDir = mkdtempSync(join(tmpdir(), 'cml-postinstall-pct-%x-'));
      const warnings: string[] = [];
      try {
        writeFileSync(join(rootDir, 'package.json'), JSON.stringify({ name: 'claude-memory-layer-install-root' }));
        const result = postinstall.runPostinstall({
          rootDir,
          env: {},
          platform: 'win32',
          arch: 'x64',
          execFileSyncImpl: () => '',
          isEmbeddingBackendAvailableImpl: () => false,
          spawnSyncImpl: () => {
            throw new Error('must not spawn');
          },
          log: () => undefined,
          warn: ((message: string) => warnings.push(message)) as () => void
        });
        expect(result).toMatchObject({ attempted: true, success: false });
        expect(warnings.join('\n')).toContain('cannot be passed safely');
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });
  });
});
