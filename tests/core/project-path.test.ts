import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashProjectPath, resolveProjectAnchorPath } from '../../src/core/registry/project-path.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** The pre-existing hash: sha256 of the realpath, with no git resolution. */
function legacyPathHash(target: string): string {
  return crypto.createHash('sha256').update(fs.realpathSync(target)).digest('hex').slice(0, 8);
}

describe('hashProjectPath worktree convergence', () => {
  let tmpRoot: string;
  let mainRoot: string;
  let mainSubdir: string;
  let worktreeRoot: string;
  let standaloneDir: string;

  beforeAll(() => {
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cml-project-path-')));
    mainRoot = path.join(tmpRoot, 'main');
    mainSubdir = path.join(mainRoot, 'src', 'core');
    worktreeRoot = path.join(tmpRoot, 'worktree');
    standaloneDir = path.join(tmpRoot, 'standalone');

    fs.mkdirSync(mainRoot);
    fs.mkdirSync(mainSubdir, { recursive: true });
    fs.mkdirSync(standaloneDir);

    git(mainRoot, ['init', '-q']);
    git(mainRoot, ['config', 'user.email', 'test@example.com']);
    git(mainRoot, ['config', 'user.name', 'Test']);
    git(mainRoot, ['commit', '-q', '--allow-empty', '-m', 'init']);
    git(mainRoot, ['worktree', 'add', '-q', worktreeRoot, '-b', 'feature']);
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('hashes a worktree checkout the same as its main checkout', () => {
    expect(hashProjectPath(worktreeRoot)).toBe(hashProjectPath(mainRoot));
  });

  it('keeps the main checkout on its pre-existing path hash', () => {
    expect(hashProjectPath(mainRoot)).toBe(legacyPathHash(mainRoot));
  });

  it('hashes a subdirectory of the main checkout the same as the checkout root', () => {
    // A session started from a subdirectory (a monorepo package, a vendored
    // tree) used to get its own hash and therefore a cold, empty store that no
    // other session in the same repository could ever read. It now shares the
    // repository's memory, the same way a worktree does.
    expect(hashProjectPath(mainSubdir)).toBe(hashProjectPath(mainRoot));
    expect(hashProjectPath(mainSubdir)).not.toBe(legacyPathHash(mainSubdir));
  });

  it('keeps a non-git directory on its own pre-existing hash', () => {
    expect(hashProjectPath(standaloneDir)).toBe(legacyPathHash(standaloneDir));
    expect(hashProjectPath(standaloneDir)).not.toBe(hashProjectPath(mainRoot));
  });

  it('anchors a worktree onto its main checkout for durable per-project artifacts', () => {
    expect(resolveProjectAnchorPath(worktreeRoot)).toBe(mainRoot);
  });

  it('anchors a subdirectory onto its checkout root, matching where its hash points', () => {
    expect(resolveProjectAnchorPath(mainSubdir)).toBe(mainRoot);
  });

  it('anchors main checkouts and non-git paths onto themselves', () => {
    expect(resolveProjectAnchorPath(mainRoot)).toBe(mainRoot);
    expect(resolveProjectAnchorPath(standaloneDir)).toBe(standaloneDir);
  });

  it('keeps a nested repository separate from its outer repository', () => {
    // vendored/submodule trees own their .git, so they must not be folded into
    // the outer checkout — only paths inside the same repository converge.
    const nested = path.join(mainRoot, 'vendor', 'inner');
    fs.mkdirSync(nested, { recursive: true });
    git(nested, ['init', '-q']);
    git(nested, ['config', 'user.email', 'test@example.com']);
    git(nested, ['config', 'user.name', 'Test']);
    git(nested, ['commit', '-q', '--allow-empty', '-m', 'init']);

    expect(hashProjectPath(nested)).not.toBe(hashProjectPath(mainRoot));

    const nestedSubdir = path.join(nested, 'pkg');
    fs.mkdirSync(nestedSubdir, { recursive: true });
    expect(hashProjectPath(nestedSubdir)).toBe(hashProjectPath(nested));
  });

  it('converges paths under a .claude-memory-root marker onto the marker directory', () => {
    // A workspace product creates one directory per chat/instance (some of them
    // their own git repositories). Without a marker each instance hashes to its
    // own cold store, so memory never accumulates across instances. Field data
    // (2026-08-19): one workspace had accumulated 9 sibling stores whose
    // grounding was the lowest measured (0.059-0.073) because every instance
    // started from zero.
    const workspaceRoot = path.join(tmpRoot, 'workspace');
    const plainInstance = path.join(workspaceRoot, 'instance-plain');
    const gitInstance = path.join(workspaceRoot, 'instance-git');
    fs.mkdirSync(plainInstance, { recursive: true });
    fs.mkdirSync(gitInstance, { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, '.claude-memory-root'), '');

    git(gitInstance, ['init', '-q']);
    git(gitInstance, ['config', 'user.email', 'test@example.com']);
    git(gitInstance, ['config', 'user.name', 'Test']);
    git(gitInstance, ['commit', '-q', '--allow-empty', '-m', 'init']);

    // The marker directory itself keeps its pre-existing hash, so adopting the
    // marker never orphans a store that already lives at the workspace root.
    expect(hashProjectPath(workspaceRoot)).toBe(legacyPathHash(workspaceRoot));
    // Non-git instances converge onto the workspace root.
    expect(hashProjectPath(plainInstance)).toBe(hashProjectPath(workspaceRoot));
    // The marker outranks the instance's own .git — converging self-owned
    // repositories is exactly what the explicit opt-in is for.
    expect(hashProjectPath(gitInstance)).toBe(hashProjectPath(workspaceRoot));
    // Durable artifacts (markdown mirror) follow the same anchor.
    expect(resolveProjectAnchorPath(plainInstance)).toBe(workspaceRoot);
    expect(resolveProjectAnchorPath(gitInstance)).toBe(workspaceRoot);
  });

  it('lets the nearest marker win when markers nest', () => {
    const outer = path.join(tmpRoot, 'marker-outer');
    const inner = path.join(outer, 'marker-inner');
    const leaf = path.join(inner, 'leaf');
    fs.mkdirSync(leaf, { recursive: true });
    fs.writeFileSync(path.join(outer, '.claude-memory-root'), '');
    fs.writeFileSync(path.join(inner, '.claude-memory-root'), '');

    expect(hashProjectPath(leaf)).toBe(hashProjectPath(inner));
    expect(hashProjectPath(inner)).not.toBe(hashProjectPath(outer));
  });

  it('ignores inherited git env vars that would resolve another repository', () => {
    // A path not hashed above, so the per-process cache cannot mask the env handling.
    const uncachedDir = path.join(tmpRoot, 'standalone-env');
    fs.mkdirSync(uncachedDir);

    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(mainRoot, '.git');
    try {
      expect(hashProjectPath(uncachedDir)).toBe(legacyPathHash(uncachedDir));
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });
});
