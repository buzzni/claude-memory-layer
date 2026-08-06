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
  runPostinstall(input?: {
    rootDir?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    arch?: string;
    execFileSyncImpl?: ExecFileSyncLike;
    isEmbeddingBackendAvailableImpl?: (rootDir: string, execFileSyncImpl: ExecFileSyncLike) => boolean;
    spawnSyncImpl?: (cmd: string, args: string[], options: { env: NodeJS.ProcessEnv }) => { status: number };
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
    expect(pkg.overrides?.sharp).toBe('0.35.3');
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
      overrides: { sharp: '0.35.3' }
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
    const rootDir = mkdtempSync(join(process.cwd(), 'node_modules', '.cml-healthcheck-test-'));

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
});
