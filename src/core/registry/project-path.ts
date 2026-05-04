/**
 * Project path registry utilities.
 *
 * These helpers are intentionally core-level and Claude-agnostic.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
 * Generate a stable 8-character hash from a normalized project path.
 */
export function hashProjectPath(projectPath: string): string {
  const normalizedPath = normalizeProjectPath(projectPath);
  return crypto.createHash('sha256')
    .update(normalizedPath)
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
