/**
 * Low-level git helpers shared by project identity resolvers.
 */

import { execFileSync } from 'node:child_process';

/**
 * These take precedence over `-C <dir>`, so an inherited value would silently
 * resolve a different repository than the one being asked about.
 */
const REPO_OVERRIDING_GIT_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'];

/** Run a read-only git command in the given directory. Returns trimmed stdout, or null on any failure. */
export function runGit(projectPath: string, args: string[]): string | null {
  const env = { ...process.env };
  for (const key of REPO_OVERRIDING_GIT_ENV) delete env[key];

  try {
    const output = execFileSync('git', ['-C', projectPath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_000,
      env
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}
