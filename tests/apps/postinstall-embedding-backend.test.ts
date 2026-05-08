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
  createNpmInstallArgs(): string[];
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
  it('keeps the npm-level embedding backend non-fatal and registers a required-backend repair hook', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as {
      scripts: Record<string, string>;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };

    expect(pkg.dependencies ?? {}).not.toHaveProperty('@huggingface/transformers');
    expect(pkg.optionalDependencies).toMatchObject({
      '@huggingface/transformers': '^3.8.1'
    });
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

  it('auto-installs a missing embedding backend when the npm-level optional install did not leave a loadable backend', () => {
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

    expect(postinstall.createRepairEnv({})).toMatchObject({
      ONNXRUNTIME_NODE_INSTALL_CUDA: 'skip',
      npm_config_onnxruntime_node_install_cuda: 'skip',
      CLAUDE_MEMORY_LAYER_EMBEDDING_POSTINSTALL_REPAIR: '1'
    });
    expect(postinstall.createNpmInstallArgs()).toEqual([
      'install',
      '--no-save',
      '--no-package-lock',
      '--omit=dev',
      postinstall.EMBEDDING_BACKEND_PACKAGE
    ]);
  });

  it('treats a resolvable but unloadable backend as unavailable so postinstall can repair it', () => {
    const postinstall = loadPostinstallModule();

    expect(postinstall.isEmbeddingBackendAvailable(process.cwd(), () => {
      throw new Error('native binding missing');
    })).toBe(false);
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
        isEmbeddingBackendAvailableImpl: () => false,
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
      expect(calls[0]?.args).toEqual(postinstall.createNpmInstallArgs());
      expect(calls[0]?.env.ONNXRUNTIME_NODE_INSTALL_CUDA).toBe('skip');
      expect(calls[0]?.env.npm_config_onnxruntime_node_install_cuda).toBe('skip');
      expect(calls[0]?.env.CLAUDE_MEMORY_LAYER_EMBEDDING_POSTINSTALL_REPAIR).toBe('1');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
