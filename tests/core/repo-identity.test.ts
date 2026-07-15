import { describe, expect, it } from 'vitest';

import {
  resolveCanonicalRepoIdentity,
  sanitizeGitRemote
} from '../../src/core/registry/repo-identity.js';

const normalize = (value: string) => value;
const hash = (value: string) => `hash-${value.replace(/[^a-z0-9]/gi, '').slice(-12)}`;

describe('canonical repository identity', () => {
  it('converges repository root, subdirectory, and worktree to one git common-dir identity', () => {
    const responses: Record<string, Record<string, string>> = {
      '/repo': {
        'rev-parse --show-toplevel': '/repo',
        'rev-parse --git-common-dir': '/repo/.git',
        'config --get remote.origin.url': 'https://token:PRIVATE@github.com/acme/memory.git'
      },
      '/repo/packages/app': {
        'rev-parse --show-toplevel': '/repo',
        'rev-parse --git-common-dir': '/repo/.git',
        'config --get remote.origin.url': 'git@github.com:acme/memory.git'
      },
      '/repo/.aplus/worktrees/blue': {
        'rev-parse --show-toplevel': '/repo/.aplus/worktrees/blue',
        'rev-parse --git-common-dir': '/repo/.git',
        'config --get remote.origin.url': 'ssh://git@github.com/acme/memory.git'
      }
    };
    const git = (projectPath: string, args: string[]) => responses[projectPath]?.[args.join(' ')] ?? null;

    const root = resolveCanonicalRepoIdentity('/repo', { normalizeProjectPath: normalize, hashProjectPath: hash, git });
    const nested = resolveCanonicalRepoIdentity('/repo/packages/app', { normalizeProjectPath: normalize, hashProjectPath: hash, git });
    const worktree = resolveCanonicalRepoIdentity('/repo/.aplus/worktrees/blue', { normalizeProjectPath: normalize, hashProjectPath: hash, git });

    expect(root.canonicalId).toBe(nested.canonicalId);
    expect(root.canonicalId).toBe(worktree.canonicalId);
    expect(worktree.isWorktree).toBe(true);
    expect(worktree.writeRouting).toBe('requires-explicit-apply');
    expect(JSON.stringify(worktree)).not.toContain('PRIVATE');
  });

  it('uses a path fallback rather than merging a non-git directory', () => {
    const identity = resolveCanonicalRepoIdentity('/tmp/standalone', {
      normalizeProjectPath: normalize,
      hashProjectPath: hash,
      git: () => null
    });

    expect(identity.kind).toBe('path-fallback');
    expect(identity.writeRouting).toBe('path-fallback');
    expect(identity.candidateLegacyProjectHashes).toEqual(['hash-mpstandalone']);
  });

  it('normalizes remotes without credentials', () => {
    expect(sanitizeGitRemote('https://alice:secret@github.com/Acme/Memory.git?token=nope')).toBe('github.com/acme/memory');
    expect(sanitizeGitRemote('git@github.com:Acme/Memory.git')).toBe('github.com/acme/memory');
  });
});
