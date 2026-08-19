/**
 * `claude-memory-layer doctor` — aggregate environment diagnostics.
 *
 * Every check here maps to an incident this project has actually hit:
 * embedding backend postinstall silently landing in the wrong npm layout,
 * an old nvm-managed Node version shadowing the current one on PATH so MCP
 * spawns the wrong binary, and empty project stores appearing because a
 * store-path check ran before the store existed. `status` reports plugin
 * installation state; `doctor` reports whether the runtime environment
 * around it is sound. Each check is a pure function over injected
 * dependencies so it can be unit tested without touching the real
 * filesystem, PATH, or Node process.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  hasHook,
  PLUGIN_HOOKS,
  REQUIRED_HOOK_FILES,
  type ClaudeSettingsWithHooks,
  type PluginHookName
} from './claude-settings-hooks.js';

export type DoctorStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheckResult {
  name: string;
  status: DoctorStatus;
  detail: string;
  fix?: string;
}

/**
 * Fallback only — the caller passes the live `engines.node` range read from
 * the shipped package.json, so a bumped engine floor is enforced without
 * anyone remembering to update a constant here.
 */
const FALLBACK_NODE_RANGE = '>=20.19.0';

function parseNodeVersion(version: string): { major: number; minor: number } | null {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function parseMinimumFromRange(range: string): { major: number; minor: number } | null {
  const match = />=\s*v?(\d+)\.(\d+)/.exec(range);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export function checkNodeVersion(
  nodeVersion: string = process.version,
  requiredRange: string = FALLBACK_NODE_RANGE
): DoctorCheckResult {
  const minimum = parseMinimumFromRange(requiredRange) ?? parseMinimumFromRange(FALLBACK_NODE_RANGE)!;
  const parsed = parseNodeVersion(nodeVersion);
  const required = `${minimum.major}.${minimum.minor}.0`;
  if (!parsed) {
    return {
      name: 'node',
      status: 'fail',
      detail: `Could not parse Node version from "${nodeVersion}"`,
      fix: `Install Node ${required} or newer.`
    };
  }
  const meetsMinimum = parsed.major > minimum.major
    || (parsed.major === minimum.major && parsed.minor >= minimum.minor);
  if (!meetsMinimum) {
    return {
      name: 'node',
      status: 'fail',
      detail: `${nodeVersion} is below the required ${required}`,
      fix: `Upgrade Node: nvm install ${minimum.major} && nvm use ${minimum.major}`
    };
  }
  return { name: 'node', status: 'pass', detail: nodeVersion };
}

export function checkPluginFiles(
  pluginPath: string,
  existsImpl: (p: string) => boolean = fs.existsSync
): DoctorCheckResult {
  const missing = REQUIRED_HOOK_FILES.filter((file) => !existsImpl(path.join(pluginPath, 'hooks', file)));
  if (missing.length > 0) {
    return {
      name: 'plugin-files',
      status: 'fail',
      detail: `Missing hook file(s) under ${pluginPath}/hooks: ${missing.join(', ')}`,
      fix: 'Reinstall: npm install -g claude-memory-layer@latest'
    };
  }
  return { name: 'plugin-files', status: 'pass', detail: pluginPath };
}

export function checkHooksInstalled(settings: ClaudeSettingsWithHooks): DoctorCheckResult {
  // Derived from PLUGIN_HOOKS — the map `install` writes from — so a hook
  // added there is automatically checked here instead of doctor reporting
  // "all hooks installed" while the new one is missing. The file name is a
  // valid hasHook fragment (commands embed it).
  const missing = (Object.entries(PLUGIN_HOOKS) as Array<[PluginHookName, string]>)
    .filter(([hookName, fileName]) => !hasHook(settings, hookName, fileName))
    .map(([hookName]) => hookName);

  if (missing.length > 0) {
    return {
      name: 'hooks',
      status: 'fail',
      detail: `Not installed in Claude settings: ${missing.join(', ')}`,
      fix: 'claude-memory-layer install'
    };
  }
  return { name: 'hooks', status: 'pass', detail: 'all hooks installed' };
}

export function checkEmbeddingBackend(
  packageRoot: string,
  isAvailableImpl: ((rootDir: string) => boolean) | null
): DoctorCheckResult {
  if (!isAvailableImpl) {
    return {
      name: 'embedding-backend',
      status: 'fail',
      detail: 'Could not load the embedding backend healthcheck script',
      fix: 'Reinstall: npm install -g claude-memory-layer@latest'
    };
  }
  const available = isAvailableImpl(packageRoot);
  if (!available) {
    return {
      name: 'embedding-backend',
      status: 'fail',
      detail: 'Required embedding backend is not installed — semantic/vector search will not work',
      fix: 'ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install -g claude-memory-layer@latest'
    };
  }
  return { name: 'embedding-backend', status: 'pass', detail: 'installed' };
}

interface PathBinaryProbe {
  dir: string;
  resolvedPath: string;
}

/**
 * Finds every distinct install a binary name resolves to across PATH. A
 * shadowed old install (e.g. an nvm-managed Node version ahead of the active
 * one) makes `which -a` return more than one, and processes launched by
 * different tools (a shell vs. an MCP client) can end up running different
 * binaries silently.
 */
export function findPathInstalls(
  binaryName: string,
  pathEnv: string,
  deps: {
    existsImpl?: (p: string) => boolean;
    realpathImpl?: (p: string) => string;
    pathSeparator?: string;
  } = {}
): PathBinaryProbe[] {
  const existsImpl = deps.existsImpl ?? fs.existsSync;
  const realpathImpl = deps.realpathImpl ?? fs.realpathSync;
  const pathSeparator = deps.pathSeparator ?? path.delimiter;

  const results: PathBinaryProbe[] = [];
  const seenRealpaths = new Set<string>();

  for (const dir of pathEnv.split(pathSeparator).filter((entry) => entry.length > 0)) {
    const candidate = path.join(dir, binaryName);
    if (!existsImpl(candidate)) continue;
    let resolvedPath: string;
    try {
      resolvedPath = realpathImpl(candidate);
    } catch {
      resolvedPath = candidate;
    }
    if (seenRealpaths.has(resolvedPath)) continue;
    seenRealpaths.add(resolvedPath);
    results.push({ dir, resolvedPath });
  }

  return results;
}

export function checkPathConsistency(
  binaryName: string,
  pathEnv: string,
  deps: Parameters<typeof findPathInstalls>[2] = {}
): DoctorCheckResult {
  const installs = findPathInstalls(binaryName, pathEnv, deps);

  if (installs.length === 0) {
    return {
      name: `path:${binaryName}`,
      status: 'pass',
      detail: `${binaryName} not found on PATH (not run as an installed binary)`
    };
  }
  if (installs.length === 1) {
    return { name: `path:${binaryName}`, status: 'pass', detail: installs[0].resolvedPath };
  }
  return {
    name: `path:${binaryName}`,
    status: 'warn',
    detail: `PATH resolves ${binaryName} to ${installs.length} different installs: `
      + installs.map((install) => install.resolvedPath).join(', '),
    fix: `Remove the stale install, or reorder PATH so the intended one (usually the first entry above) wins. `
      + `An MCP client and your shell can pick different ones silently.`
  };
}

/**
 * Non-mutating: never creates the project store as a side effect of checking
 * it. Walks up to the nearest existing ancestor and checks that directory is
 * writable, which is what "a store could be created here" actually requires.
 */
export function checkProjectStoreAccess(
  storePath: string,
  deps: {
    existsImpl?: (p: string) => boolean;
    accessImpl?: (p: string, mode: number) => void;
  } = {}
): DoctorCheckResult {
  const existsImpl = deps.existsImpl ?? fs.existsSync;
  const accessImpl = deps.accessImpl ?? fs.accessSync;

  let cursor = storePath;
  let parent = path.dirname(cursor);
  while (!existsImpl(cursor) && parent !== cursor) {
    cursor = parent;
    parent = path.dirname(cursor);
  }

  try {
    accessImpl(cursor, fs.constants.W_OK);
  } catch {
    return {
      name: 'project-store',
      status: 'fail',
      detail: `${cursor} is not writable`,
      fix: `Check ownership and permissions of ${cursor}.`
    };
  }
  return { name: 'project-store', status: 'pass', detail: storePath };
}

export function formatDoctorReport(checks: DoctorCheckResult[]): string {
  const icon: Record<DoctorStatus, string> = { pass: '✅', warn: '⚠️ ', fail: '❌' };
  const nameWidth = Math.max(...checks.map((check) => check.name.length));
  const lines = ['', 'Claude Memory Layer Doctor', ''];

  for (const check of checks) {
    const pad = ' '.repeat(nameWidth - check.name.length + 1);
    lines.push(`  ${check.name}:${pad}${icon[check.status]}  ${check.detail}`);
    if (check.fix) {
      lines.push(`  ${' '.repeat(nameWidth + 2)}Fix: ${check.fix}`);
    }
  }

  const failed = checks.filter((check) => check.status === 'fail').length;
  const warned = checks.filter((check) => check.status === 'warn').length;
  lines.push('');
  if (failed > 0) {
    lines.push(`  ${failed} check(s) failed. See above for fix suggestions.`);
  } else if (warned > 0) {
    lines.push(`  ${warned} warning(s). Review the suggestions above.`);
  } else {
    lines.push('  All checks passed.');
  }
  lines.push('');

  return lines.join('\n');
}

export function doctorExitCode(checks: DoctorCheckResult[]): number {
  return checks.some((check) => check.status === 'fail') ? 1 : 0;
}
