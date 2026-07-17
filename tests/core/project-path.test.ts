import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashProjectPath } from '../../src/core/registry/project-path.js';

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

  it('keeps a subdirectory of the main checkout on its own pre-existing hash', () => {
    expect(hashProjectPath(mainSubdir)).toBe(legacyPathHash(mainSubdir));
    expect(hashProjectPath(mainSubdir)).not.toBe(hashProjectPath(mainRoot));
  });

  it('keeps a non-git directory on its own pre-existing hash', () => {
    expect(hashProjectPath(standaloneDir)).toBe(legacyPathHash(standaloneDir));
    expect(hashProjectPath(standaloneDir)).not.toBe(hashProjectPath(mainRoot));
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
