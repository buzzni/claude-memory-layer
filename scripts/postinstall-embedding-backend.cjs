#!/usr/bin/env node
'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EMBEDDING_BACKEND_PACKAGE_NAME = '@huggingface/transformers';
const EMBEDDING_BACKEND_VERSION = '3.8.1';
const EMBEDDING_BACKEND_PACKAGE = `${EMBEDDING_BACKEND_PACKAGE_NAME}@${EMBEDDING_BACKEND_VERSION}`;
const MANAGED_EMBEDDING_BACKEND_DIR = '.claude-memory-layer-embedding-backend';
const SHARP_VERSION = '0.35.3';
const REPAIR_GUARD_ENV = 'CLAUDE_MEMORY_LAYER_EMBEDDING_POSTINSTALL_REPAIR';
const SKIP_ENV = 'CLAUDE_MEMORY_LAYER_SKIP_EMBEDDING_POSTINSTALL';
const EMBEDDING_BACKEND_HEALTHCHECK_SCRIPT = `
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const backendRoot = process.argv[1];
const realBackendRoot = realpathSync(backendRoot);
const backendRequire = createRequire(pathToFileURL(backendRoot + '/package.json'));
const transformersEntry = realpathSync(backendRequire.resolve('${EMBEDDING_BACKEND_PACKAGE_NAME}'));
const sharpEntry = realpathSync(backendRequire.resolve('sharp'));
if (!transformersEntry.startsWith(realBackendRoot + sep) || !sharpEntry.startsWith(realBackendRoot + sep)) {
  process.exit(1);
}
Promise.all([
  import(pathToFileURL(transformersEntry).href),
  Promise.resolve().then(() => backendRequire('sharp'))
])
  .then(([, sharp]) => {
    if (sharp.versions?.sharp !== '${SHARP_VERSION}') process.exit(1);
  })
  .catch(() => process.exit(1));
`;

function getManagedBackendDir(rootDir = process.cwd()) {
  return path.join(rootDir, 'node_modules', MANAGED_EMBEDDING_BACKEND_DIR);
}

function createManagedBackendManifest() {
  return {
    private: true,
    dependencies: {
      [EMBEDDING_BACKEND_PACKAGE_NAME]: EMBEDDING_BACKEND_VERSION
    },
    overrides: {
      sharp: SHARP_VERSION
    }
  };
}

function ensureManagedBackendManifest(rootDir = process.cwd(), fsImpl = fs) {
  const backendDir = getManagedBackendDir(rootDir);
  const manifestPath = path.join(backendDir, 'package.json');
  const content = `${JSON.stringify(createManagedBackendManifest(), null, 2)}\n`;
  fsImpl.mkdirSync(backendDir, { recursive: true });
  if (!fsImpl.existsSync(manifestPath) || fsImpl.readFileSync(manifestPath, 'utf8') !== content) {
    fsImpl.writeFileSync(manifestPath, content);
  }
  return backendDir;
}

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
  return false;
}

function isEmbeddingBackendAvailable(rootDir = process.cwd(), execFileSyncImpl = execFileSync) {
  try {
    execFileSyncImpl(process.execPath, [
      '--input-type=module',
      '--eval',
      EMBEDDING_BACKEND_HEALTHCHECK_SCRIPT,
      getManagedBackendDir(rootDir)
    ], {
      cwd: rootDir,
      stdio: 'ignore'
    });
    return true;
  } catch {
    return false;
  }
}

function shouldAttemptAutoInstall({ cudaMajor, transformersAvailable, skipRequested }) {
  return !skipRequested && (!transformersAvailable || cudaMajor === 11);
}

/**
 * npm settings that decide *where* an install lands. The parent `npm install
 * -g claude-memory-layer` exports these, and a child process inherits them —
 * which silently put the nested `npm install --prefix <backend>` into global
 * mode. transformers then landed in <backend>/lib/node_modules (the global
 * layout) rather than <backend>/node_modules, leaving the backend broken and
 * every mem-* tool reporting "Required embedding backend is not installed".
 *
 * Only location settings are stripped; registry, proxy, and auth settings the
 * install needs are left alone.
 */
const INHERITED_NPM_LOCATION_SETTINGS = [
  'npm_config_global',
  'npm_config_location',
  'npm_config_prefix',
  'npm_config_local_prefix'
];

function createRepairEnv(env = process.env) {
  const repairEnv = {
    ...env,
    ONNXRUNTIME_NODE_INSTALL_CUDA: 'skip',
    npm_config_onnxruntime_node_install_cuda: 'skip',
    [REPAIR_GUARD_ENV]: '1'
  };

  for (const setting of INHERITED_NPM_LOCATION_SETTINGS) {
    delete repairEnv[setting];
  }

  return repairEnv;
}

function createNpmInstallArgs(rootDir = process.cwd()) {
  return [
    'install',
    '--prefix',
    getManagedBackendDir(rootDir),
    '--omit=dev'
  ];
}

function runPostinstall({
  rootDir = process.cwd(),
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  execFileSyncImpl = execFileSync,
  isEmbeddingBackendAvailableImpl = isEmbeddingBackendAvailable,
  spawnSyncImpl = spawnSync,
  log = console.log,
  warn = console.warn
} = {}) {
  const transformersAvailable = isEmbeddingBackendAvailableImpl(rootDir, execFileSyncImpl);
  const skipRequested = isSkipRequested(env);
  const cudaMajor = detectCudaMajor({ env, execFileSyncImpl });

  if (!shouldAttemptAutoInstall({ platform, arch, cudaMajor, transformersAvailable, skipRequested })) {
    return { attempted: false, cudaMajor, transformersAvailable, skipRequested };
  }

  log('[claude-memory-layer] Embedding backend is missing or needs CUDA 11 CPU-only repair. Repairing with CPU-only ONNX Runtime...');
  ensureManagedBackendManifest(rootDir);

  const npmCommand = platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSyncImpl(npmCommand, createNpmInstallArgs(rootDir), {
    cwd: rootDir,
    env: createRepairEnv(env),
    stdio: 'inherit'
  });

  // A zero exit only says npm ran, not that the backend is usable — an install
  // that lands in the wrong layout still exits 0. Re-run the health check so a
  // broken backend is reported here instead of surfacing days later as
  // "Required embedding backend is not installed" on every mem-* call.
  const repaired = result.error || result.status !== 0
    ? false
    : isEmbeddingBackendAvailableImpl(rootDir, execFileSyncImpl);

  if (!repaired) {
    warn('[claude-memory-layer] Required embedding backend repair failed. Semantic/vector embeddings may be unavailable until you run:');
    warn(`  ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install -g claude-memory-layer@latest`);
    if (result.error) warn(`  ${result.error.message}`);
    return { attempted: true, success: false, cudaMajor, transformersAvailable, skipRequested };
  }

  log('[claude-memory-layer] Required embedding backend repaired with CPU-only ONNX Runtime.');
  return { attempted: true, success: true, cudaMajor, transformersAvailable, skipRequested };
}

if (require.main === module) {
  runPostinstall();
}

module.exports = {
  EMBEDDING_BACKEND_PACKAGE,
  MANAGED_EMBEDDING_BACKEND_DIR,
  SHARP_VERSION,
  getManagedBackendDir,
  createManagedBackendManifest,
  ensureManagedBackendManifest,
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
