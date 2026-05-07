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

type PostinstallEmbeddingBackend = {
  EMBEDDING_BACKEND_PACKAGE: string;
  parseCudaMajor(output: string): number | null;
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
    execFileSyncImpl?: () => string;
    spawnSyncImpl?: (cmd: string, args: string[], options: { env: NodeJS.ProcessEnv }) => { status: number };
    log?: () => void;
    warn?: () => void;
  }): { attempted: boolean; success?: boolean; cudaMajor: number | null; transformersAvailable: boolean; skipRequested: boolean };
};

function loadPostinstallModule(): PostinstallEmbeddingBackend {
  return require('../../scripts/postinstall-embedding-backend.cjs') as PostinstallEmbeddingBackend;
}

describe('embedding backend postinstall repair', () => {
  it('keeps the install-time embedding backend optional and registers postinstall repair', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as {
      scripts: Record<string, string>;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };

    expect(pkg.dependencies).not.toHaveProperty('@huggingface/transformers');
    expect(pkg.optionalDependencies).toMatchObject({
      '@huggingface/transformers': '^3.8.1'
    });
    expect(pkg.scripts.postinstall).toBe('node scripts/postinstall-embedding-backend.cjs');
  });

  it('detects CUDA major version from nvcc output', () => {
    const postinstall = loadPostinstallModule();

    expect(postinstall.parseCudaMajor('Cuda compilation tools, release 11.8, V11.8.89')).toBe(11);
    expect(postinstall.parseCudaMajor('Cuda compilation tools, release 12.4, V12.4.131')).toBe(12);
    expect(postinstall.parseCudaMajor('nvcc: NVIDIA (R) Cuda compiler driver')).toBeNull();
  });

  it('only auto-installs the embedding backend for Linux x64 CUDA 11 when it is missing', () => {
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
      cudaMajor: 11,
      transformersAvailable: true,
      skipRequested: false
    })).toBe(false);

    expect(postinstall.shouldAttemptAutoInstall({
      platform: 'linux',
      arch: 'arm64',
      cudaMajor: 11,
      transformersAvailable: false,
      skipRequested: false
    })).toBe(false);

    expect(postinstall.shouldAttemptAutoInstall({
      platform: 'darwin',
      arch: 'x64',
      cudaMajor: 11,
      transformersAvailable: false,
      skipRequested: false
    })).toBe(false);

    expect(postinstall.shouldAttemptAutoInstall({
      platform: 'linux',
      arch: 'x64',
      cudaMajor: 12,
      transformersAvailable: false,
      skipRequested: false
    })).toBe(false);

    expect(postinstall.shouldAttemptAutoInstall({
      platform: 'linux',
      arch: 'x64',
      cudaMajor: 11,
      transformersAvailable: false,
      skipRequested: true
    })).toBe(false);
  });

  it('repairs missing transformers with CPU-only onnxruntime install settings', () => {
    const postinstall = loadPostinstallModule();

    expect(postinstall.createRepairEnv({})).toMatchObject({
      ONNXRUNTIME_NODE_INSTALL_CUDA: 'skip',
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

  it('runs the automatic repair command when Linux x64 CUDA 11 skipped the optional backend', () => {
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
        execFileSyncImpl: () => 'Cuda compilation tools, release 11.8, V11.8.89',
        spawnSyncImpl: (cmd, args, options) => {
          calls.push({ cmd, args, env: options.env });
          return { status: 0 };
        },
        log: () => undefined,
        warn: () => undefined
      });

      expect(result).toMatchObject({ attempted: true, success: true, cudaMajor: 11, transformersAvailable: false });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.cmd).toBe('npm');
      expect(calls[0]?.args).toEqual(postinstall.createNpmInstallArgs());
      expect(calls[0]?.env.ONNXRUNTIME_NODE_INSTALL_CUDA).toBe('skip');
      expect(calls[0]?.env.CLAUDE_MEMORY_LAYER_EMBEDDING_POSTINSTALL_REPAIR).toBe('1');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
