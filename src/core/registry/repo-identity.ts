/**
 * Canonical repository identity resolution.
 *
 * This resolver is deliberately read-only.  It supports safe alias discovery
 * for root/subdirectory/worktree stores without moving or merging any existing
 * SQLite database.  Write routing is a separate explicit migration step.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';

import {
  hashProjectPath,
  hashProjectPathIgnoringMarker,
  normalizeProjectPath,
  resolveMemoryRootMarkerPath
} from './project-path.js';
import { runGit } from './git-utils.js';

export type RepoIdentityKind = 'memory-root-marker' | 'git-remote-common-dir' | 'git-common-dir' | 'path-fallback';

export interface CanonicalRepoIdentity {
  canonicalId: string;
  kind: RepoIdentityKind;
  projectHash: string;
  repoRootHash: string | null;
  commonDirHash: string | null;
  remoteFingerprint: string | null;
  isWorktree: boolean;
  /** The .claude-memory-root directory governing this path, when one applies. */
  memoryRootMarkerPath: string | null;
  candidateLegacyProjectHashes: string[];
  writeRouting: 'requires-explicit-apply' | 'path-fallback';
}

export interface RepoIdentityDeps {
  normalizeProjectPath?: (projectPath: string) => string;
  hashProjectPath?: (projectPath: string) => string;
  hashProjectPathIgnoringMarker?: (projectPath: string) => string;
  resolveMemoryRootMarkerPath?: (projectPath: string) => string | null;
  git?: (projectPath: string, args: string[]) => string | null;
}

export function resolveCanonicalRepoIdentity(
  projectPath: string,
  deps: RepoIdentityDeps = {}
): CanonicalRepoIdentity {
  const normalize = deps.normalizeProjectPath ?? normalizeProjectPath;
  const hash = deps.hashProjectPath ?? hashProjectPath;
  const hashIgnoringMarker = deps.hashProjectPathIgnoringMarker ?? hashProjectPathIgnoringMarker;
  const resolveMarker = deps.resolveMemoryRootMarkerPath ?? resolveMemoryRootMarkerPath;
  const git = deps.git ?? runGit;
  const normalizedPath = normalize(projectPath);
  const projectHash = hash(normalizedPath);
  const memoryRootMarkerPath = resolveMarker(normalizedPath);
  const repoRoot = normalizeGitPath(git(normalizedPath, ['rev-parse', '--show-toplevel']), normalizedPath);
  const commonDir = normalizeGitPath(git(normalizedPath, ['rev-parse', '--git-common-dir']), repoRoot ?? normalizedPath);

  if (!repoRoot || !commonDir) {
    // A marker converges paths that share no .git, so under a marker even a
    // non-git instance folds into the marker identity instead of a
    // per-directory path fallback.
    if (memoryRootMarkerPath) {
      return {
        canonicalId: stableId(`memory-root:${memoryRootMarkerPath}`),
        kind: 'memory-root-marker',
        projectHash,
        repoRootHash: null,
        commonDirHash: null,
        remoteFingerprint: null,
        isWorktree: false,
        memoryRootMarkerPath,
        candidateLegacyProjectHashes: unique([projectHash, hashIgnoringMarker(normalizedPath)]),
        writeRouting: 'requires-explicit-apply'
      };
    }
    return {
      canonicalId: stableId(`path:${normalizedPath}`),
      kind: 'path-fallback',
      projectHash,
      repoRootHash: null,
      commonDirHash: null,
      remoteFingerprint: null,
      isWorktree: false,
      memoryRootMarkerPath: null,
      candidateLegacyProjectHashes: [projectHash],
      writeRouting: 'path-fallback'
    };
  }

  const remoteFingerprint = sanitizeGitRemote(git(normalizedPath, ['config', '--get', 'remote.origin.url']));
  const repoRootHash = hash(repoRoot);
  const commonDirHash = stableId(`common-dir:${commonDir}`);
  const isWorktree = normalizePathForComparison(repoRoot) !== normalizePathForComparison(commonDir.replace(/[\\/]\.git$/, ''));
  // Pre-marker hashes keep the fragment stores a marker superseded nameable:
  // those stores are keyed by exactly the git-only hash of the paths that
  // wrote them, and alias discovery exists to find them.
  const candidateLegacyProjectHashes = memoryRootMarkerPath
    ? unique([projectHash, repoRootHash, hashIgnoringMarker(normalizedPath), hashIgnoringMarker(repoRoot)])
    : unique([projectHash, repoRootHash]);
  // The marker outranks git identity: every repository under one marker is one
  // memory identity, which is what lets a scan started from any instance find
  // its sibling instances' stores.
  const kind: RepoIdentityKind = memoryRootMarkerPath
    ? 'memory-root-marker'
    : remoteFingerprint ? 'git-remote-common-dir' : 'git-common-dir';
  const canonicalBasis = memoryRootMarkerPath
    ? `memory-root:${memoryRootMarkerPath}`
    : remoteFingerprint
      ? `remote:${remoteFingerprint}|common:${commonDir}`
      : `common:${commonDir}`;

  return {
    canonicalId: stableId(canonicalBasis),
    kind,
    projectHash,
    repoRootHash,
    commonDirHash,
    remoteFingerprint,
    isWorktree,
    memoryRootMarkerPath,
    candidateLegacyProjectHashes,
    writeRouting: 'requires-explicit-apply'
  };
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

/** Remove credentials, query fragments, and protocol distinctions from a git remote. */
export function sanitizeGitRemote(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;

  const withoutScheme = raw
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^[^@\s/]+@/, '')
    .replace(/[?#].*$/, '')
    .replace(/\.git$/i, '')
    .replace(/:/, '/');
  const safe = withoutScheme.replace(/^[^@\s/]+@/, '').replace(/\/+/g, '/').toLowerCase();
  return safe.length > 0 ? safe : null;
}

function normalizeGitPath(value: string | null, basePath: string): string | null {
  if (!value) return null;
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(basePath, value);
}

function normalizePathForComparison(value: string): string {
  return path.normalize(value).replace(/[\\/]$/, '');
}

function stableId(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}
