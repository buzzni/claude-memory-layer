import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The ceiling guard reads os.homedir() at resolution time, so the mock swaps
// the home directory for a sandbox we can safely plant marker files in —
// never the real home.
const mocked = vi.hoisted(() => ({ homedir: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => mocked.homedir || actual.homedir() };
});

const { hashProjectPath, MEMORY_ROOT_MARKER } = await import('../../src/core/registry/project-path.js');

function legacyPathHash(target: string): string {
  return crypto.createHash('sha256').update(fs.realpathSync(target)).digest('hex').slice(0, 8);
}

describe('memory root marker ceilings', () => {
  let sandboxHome: string;

  beforeAll(() => {
    const os = require('node:os') as typeof import('os');
    sandboxHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cml-marker-home-')));
    mocked.homedir = sandboxHome;
  });

  afterAll(() => {
    mocked.homedir = '';
    fs.rmSync(sandboxHome, { recursive: true, force: true });
  });

  it('ignores a marker at the home directory itself', () => {
    // A stray `touch ~/.claude-memory-root` (a fat-fingered cd, a dotfiles
    // repo shipping one) must not collapse every project on the machine into
    // one store.
    const project = path.join(sandboxHome, 'some-project');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(sandboxHome, MEMORY_ROOT_MARKER), '');

    expect(hashProjectPath(project)).toBe(legacyPathHash(project));
    expect(hashProjectPath(project)).not.toBe(legacyPathHash(sandboxHome));
  });

  it('honors a marker strictly below the home directory', () => {
    const workspace = path.join(sandboxHome, 'workspace');
    const instance = path.join(workspace, 'instance');
    fs.mkdirSync(instance, { recursive: true });
    fs.writeFileSync(path.join(workspace, MEMORY_ROOT_MARKER), '');

    expect(hashProjectPath(instance)).toBe(legacyPathHash(workspace));
  });
});
