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

/**
 * Cache of hash basis per normalized path. Git layout does not change within a
 * process run; a marker file can (the README tells users to `touch` it), so a
 * long-lived process (MCP server, dashboard) picks a new marker up only after
 * restart. Hooks are fresh processes and see it immediately.
 */
const hashBasisCache = new Map<string, string>();

/**
 * Explicit convergence marker. A workspace product that creates one directory
 * per chat/instance (each often its own git repository) can drop this file at
 * the workspace root so every path beneath it shares one store. Without it,
 * each instance hashes to its own cold store and memory never accumulates
 * across instances.
 */
export const MEMORY_ROOT_MARKER = '.claude-memory-root';

/**
 * The marker must be a regular file. A directory of the same name is ignored,
 * and an unreadable path (EACCES on a TCC-protected ancestor, a flaky mount)
 * degrades to "no marker" rather than failing resolution.
 */
function markerFileExists(markerPath: string): boolean {
  try {
    return fs.statSync(markerPath, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

/**
 * Find the nearest ancestor (including the directory itself) that carries the
 * convergence marker. Nearest wins so a nested workspace stays separate from
 * an outer one. Returns null when no marker exists — the common case, which
 * keeps default behavior untouched.
 *
 * The walk never accepts a marker at the home directory, the system temp
 * directory, or the filesystem root: a stray marker there would silently
 * collapse every project on the machine (or, for the world-writable temp
 * root, let any local process converge other users' temp projects) into one
 * store. Markers strictly below those ceilings are honored.
 */
function findMemoryRootMarker(startDir: string): string | null {
  const ceilings = new Set([
    normalizeProjectPath(os.homedir()),
    normalizeProjectPath(os.tmpdir())
  ]);

  let current = startDir;
  for (;;) {
    if (ceilings.has(current) || path.dirname(current) === current) return null;
    if (markerFileExists(path.join(current, MEMORY_ROOT_MARKER))) return current;
    current = path.dirname(current);
  }
}

function computeHashBasisPath(normalizedPath: string): string {
  // Git convergence runs first, then the marker walk starts from the
  // git-resolved basis. This ordering is load-bearing three ways: a worktree
  // checked out outside the marker tree still reaches the marker through its
  // main checkout; a marker committed into a repository (and therefore
  // materialized in every worktree checkout) resolves to the main checkout
  // root instead of splitting each worktree onto a cold store; and a marker
  // in a repository subdirectory cannot detach that subtree from the store
  // the repository has been accumulating. The marker still outranks an
  // instance's *own* .git — the git basis of such an instance is its checkout
  // root, and the walk climbs from there to the workspace marker above it.
  const gitBasis = computeGitBasisPath(normalizedPath);
  const markerRoot = findMemoryRootMarker(gitBasis);
  // Re-normalized because the basis may come from the plain path.resolve
  // fallback when the directory does not exist yet, so an existing ancestor
  // carrying the marker can still contain unresolved symlinks.
  return markerRoot !== null ? normalizeProjectPath(markerRoot) : gitBasis;
}

function computeGitBasisPath(normalizedPath: string): string {
  // One spawn for both values: resolution runs in every short-lived hook
  // process and the git spawn dominates its cost. rev-parse prints results in
  // flag order. A bare repo (a common dir but no work tree) fails
  // --show-toplevel and with it the whole command — same outcome as the
  // previous separate guard: such a path keeps hashing to itself.
  const output = runGit(normalizedPath, ['rev-parse', '--git-common-dir', '--show-toplevel']);
  if (!output) return normalizedPath;
  const [commonDir, toplevel] = output.split('\n').map((line) => line.trim());
  if (!commonDir || !toplevel) return normalizedPath;

  const absoluteCommonDir = path.isAbsolute(commonDir)
    ? commonDir
    : path.resolve(normalizedPath, commonDir);
  if (path.basename(absoluteCommonDir) !== '.git') return normalizedPath;
  const mainCheckoutRoot = normalizeProjectPath(path.dirname(absoluteCommonDir));

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
