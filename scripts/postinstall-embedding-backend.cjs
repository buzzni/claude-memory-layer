#!/usr/bin/env node
'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const { createRequire } = require('node:module');

const EMBEDDING_BACKEND_PACKAGE_NAME = '@huggingface/transformers';
const EMBEDDING_BACKEND_VERSION = '3.8.1';
const EMBEDDING_BACKEND_PACKAGE = `${EMBEDDING_BACKEND_PACKAGE_NAME}@${EMBEDDING_BACKEND_VERSION}`;
const REPAIR_GUARD_ENV = 'CLAUDE_MEMORY_LAYER_EMBEDDING_POSTINSTALL_REPAIR';
const SKIP_ENV = 'CLAUDE_MEMORY_LAYER_SKIP_EMBEDDING_POSTINSTALL';

function parseCudaMajor(output) {
  const releaseMatch = String(output).match(/release\s+(\d+)(?:\.\d+)?/i);
  if (releaseMatch) return Number(releaseMatch[1]);

  const versionMatch = String(output).match(/\bV(\d+)\.\d+/i);
  if (versionMatch) return Number(versionMatch[1]);

  return null;
}

function parseCudaMajorFromEnv(env = process.env) {
  const value = env.ONNXRUNTIME_NODE_INSTALL_CUDA || env.npm_config_onnxruntime_node_install_cuda;
  if (!value) return null;
  if (value === 'v11' || value === '11') return 11;
  if (value === 'v12' || value === '12') return 12;
  return null;
}

function detectCudaMajor({ env = process.env, execFileSyncImpl = execFileSync } = {}) {
  const envMajor = parseCudaMajorFromEnv(env);
  if (envMajor) return envMajor;

  try {
    return parseCudaMajor(execFileSyncImpl('nvcc', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }));
  } catch {
    return null;
  }
}

function isSkipRequested(env = process.env) {
  if (env[SKIP_ENV] === '1' || env[REPAIR_GUARD_ENV] === '1') return true;
  if (env.npm_config_optional === 'false') return true;
  if (String(env.npm_config_omit || '').split(',').map((item) => item.trim()).includes('optional')) return true;
  return false;
}

function isEmbeddingBackendAvailable(rootDir = process.cwd()) {
  try {
    const requireFromRoot = createRequire(path.join(rootDir, 'package.json'));
    requireFromRoot.resolve(EMBEDDING_BACKEND_PACKAGE_NAME);
    return true;
  } catch {
    return false;
  }
}

function shouldAttemptAutoInstall({ platform, arch, transformersAvailable, skipRequested }) {
  return platform === 'linux' &&
    arch === 'x64' &&
    !transformersAvailable &&
    !skipRequested;
}

function createRepairEnv(env = process.env) {
  return {
    ...env,
    ONNXRUNTIME_NODE_INSTALL_CUDA: 'skip',
    [REPAIR_GUARD_ENV]: '1'
  };
}

function createNpmInstallArgs() {
  return [
    'install',
    '--no-save',
    '--no-package-lock',
    '--omit=dev',
    EMBEDDING_BACKEND_PACKAGE
  ];
}

function runPostinstall({
  rootDir = process.cwd(),
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  execFileSyncImpl = execFileSync,
  spawnSyncImpl = spawnSync,
  log = console.log,
  warn = console.warn
} = {}) {
  const transformersAvailable = isEmbeddingBackendAvailable(rootDir);
  const skipRequested = isSkipRequested(env);
  const cudaMajor = detectCudaMajor({ env, execFileSyncImpl });

  if (!shouldAttemptAutoInstall({ platform, arch, cudaMajor, transformersAvailable, skipRequested })) {
    return { attempted: false, cudaMajor, transformersAvailable, skipRequested };
  }

  log('[claude-memory-layer] Optional embedding backend is missing on Linux x64. Installing CPU-only embedding backend...');

  const npmCommand = platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSyncImpl(npmCommand, createNpmInstallArgs(), {
    cwd: rootDir,
    env: createRepairEnv(env),
    stdio: 'inherit'
  });

  if (result.error || result.status !== 0) {
    warn('[claude-memory-layer] Optional embedding backend repair failed. Claude Memory Layer is installed, but semantic/vector embeddings may be unavailable until you run:');
    warn(`  ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install -g claude-memory-layer@latest`);
    if (result.error) warn(`  ${result.error.message}`);
    return { attempted: true, success: false, cudaMajor, transformersAvailable, skipRequested };
  }

  log('[claude-memory-layer] Optional embedding backend installed with CPU-only ONNX Runtime.');
  return { attempted: true, success: true, cudaMajor, transformersAvailable, skipRequested };
}

if (require.main === module) {
  runPostinstall();
}

module.exports = {
  EMBEDDING_BACKEND_PACKAGE,
  parseCudaMajor,
  parseCudaMajorFromEnv,
  detectCudaMajor,
  isSkipRequested,
  isEmbeddingBackendAvailable,
  shouldAttemptAutoInstall,
  createRepairEnv,
  createNpmInstallArgs,
  runPostinstall
};
