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

  // Guard against a git layout that reports a common dir but no work tree
  // (a bare repo); such a path keeps hashing to itself.
  if (!runGit(normalizedPath, ['rev-parse', '--show-toplevel'])) return normalizedPath;

  // Every path inside one repository resolves onto the checkout that owns the
  // shared .git — a worktree, the checkout root, or any subdirectory of it.
  //
  // The root itself already hashes to this value, so existing project hashes
  // are unchanged. Subdirectories converge onto it: a session started from a
  // monorepo package or a vendored tree used to get its own hash, and with it
  // a cold store no other session in the repository could read.
  //
  // A nested repository owns its own .git, so its common dir differs and it
  // stays separate rather than folding into the outer checkout.
  return mainCheckoutRoot;
}

/**
 * Resolve the path a project hash should be derived from, so that every path
 * belonging to one repository — worktree, checkout root, or subdirectory —
 * hashes to the main checkout that owns the shared .git. Nested repositories
 * and non-git paths hash to themselves.
 */
function resolveHashBasisPath(normalizedPath: string): string {
  const cached = hashBasisCache.get(normalizedPath);
  if (cached !== undefined) return cached;

  const basis = computeHashBasisPath(normalizedPath);
  hashBasisCache.set(normalizedPath, basis);
  return basis;
}

/**
 * Resolve the durable on-disk anchor for per-project artifacts (e.g. the
 * markdown mirror): worktrees and subdirectories anchor onto the main checkout
 * they share a .git with, so artifacts survive worktree removal and land where
 * the project hash already points. Nested repositories and non-git paths
 * anchor onto themselves.
 */
export function resolveProjectAnchorPath(projectPath: string): string {
  return resolveHashBasisPath(normalizeProjectPath(projectPath));
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
