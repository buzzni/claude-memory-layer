/**
 * Project path registry utilities.
 *
 * These helpers are intentionally core-level and Claude-agnostic.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runGit } from './git-utils.js';

/**
 * Normalize and resolve a project path, handling symlinks when possible.
 */
export function normalizeProjectPath(projectPath: string): string {
  const expanded = projectPath.startsWith('~')
    ? path.join(os.homedir(), projectPath.slice(1))
    : projectPath;

  try {
    return fs.realpathSync(expanded);
  } catch {
    return path.resolve(expanded);
  }
}

/** Cache of hash basis per normalized path; git layout does not change within a process run. */
const hashBasisCache = new Map<string, string>();

function computeHashBasisPath(normalizedPath: string): string {
  const commonDir = runGit(normalizedPath, ['rev-parse', '--git-common-dir']);
  if (!commonDir) return normalizedPath;

  const absoluteCommonDir = path.isAbsolute(commonDir)
    ? commonDir
    : path.resolve(normalizedPath, commonDir);
  if (path.basename(absoluteCommonDir) !== '.git') return normalizedPath;
  const mainCheckoutRoot = normalizeProjectPath(path.dirname(absoluteCommonDir));

  const topLevel = runGit(normalizedPath, ['rev-parse', '--show-toplevel']);
  if (!topLevel) return normalizedPath;

  // Inside the main checkout (its root or any subdirectory) the top level is
  // the main checkout root, and the caller's own path is kept so existing
  // project hashes never shift. Only a worktree, whose top level differs from
  // the checkout owning the shared .git, is redirected onto the main checkout.
  return normalizeProjectPath(topLevel) === mainCheckoutRoot ? normalizedPath : mainCheckoutRoot;
}

/**
 * Resolve the path a project hash should be derived from, so that a git
 * worktree hashes to the same value as the main checkout it shares a .git
 * with. Main checkouts, subdirectories, and non-git paths hash to themselves.
 */
function resolveHashBasisPath(normalizedPath: string): string {
  const cached = hashBasisCache.get(normalizedPath);
  if (cached !== undefined) return cached;

  const basis = computeHashBasisPath(normalizedPath);
  hashBasisCache.set(normalizedPath, basis);
  return basis;
}

/**
 * Generate a stable 8-character hash from a normalized project path.
 */
export function hashProjectPath(projectPath: string): string {
  const normalizedPath = normalizeProjectPath(projectPath);
  const hashBasis = resolveHashBasisPath(normalizedPath);
  return crypto.createHash('sha256')
    .update(hashBasis)
    .digest('hex')
    .slice(0, 8);
}

/**
 * Get the storage path for a project-local memory database.
 */
export function getProjectStoragePath(projectPath: string): string {
  const hash = hashProjectPath(projectPath);
  return path.join(os.homedir(), '.claude-code', 'memory', 'projects', hash);
}

/**
 * Resolve either an explicit project hash or a project path into a storage path.
 */
export function resolveProjectStoragePath(projectOrHash: string): string {
  const isHash = /^[a-f0-9]{8}$/.test(projectOrHash);
  return isHash
    ? path.join(os.homedir(), '.claude-code', 'memory', 'projects', projectOrHash)
    : getProjectStoragePath(projectOrHash);
}
