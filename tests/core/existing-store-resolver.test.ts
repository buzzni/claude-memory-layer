import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveExistingStore } from '../../src/core/registry/existing-store.js';
import { hashProjectPath } from '../../src/core/registry/project-path.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { diffMemoryRootSnapshots, snapshotMemoryRoot } from '../helpers/memory-root-snapshot.js';

async function createStore(homeDir: string, projectHash: string): Promise<string> {
  const storagePath = path.join(homeDir, '.claude-code', 'memory', 'projects', projectHash);
  const store = new SQLiteEventStore(path.join(storagePath, 'events.sqlite'));
  await store.initialize();
  await store.close();
  return storagePath;
}

describe('existing memory store resolver', () => {
  it('returns missing for paths and hashes without creating a memory root', () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-resolver-missing-'));
    const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
    const before = snapshotMemoryRoot(memoryRoot);

    const byPath = resolveExistingStore('/workspace/does-not-exist', { homeDir });
    const byHash = resolveExistingStore('abc12345', { homeDir });

    expect(byPath).toMatchObject({ status: 'missing', inputKind: 'project-path' });
    expect(byHash).toMatchObject({ status: 'missing', inputKind: 'project-hash', projectHash: 'abc12345' });
    expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(memoryRoot))).toEqual([]);
  });

  it('resolves an existing store by project path, hash, and real symlink target', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-resolver-existing-'));
    const homeDir = path.join(root, 'home');
    const projectPath = path.join(root, 'project');
    const symlinkPath = path.join(root, 'project-link');
    mkdirSync(projectPath, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    symlinkSync(projectPath, symlinkPath);
    const projectHash = hashProjectPath(projectPath);
    await createStore(homeDir, projectHash);

    expect(resolveExistingStore(projectPath, { homeDir })).toMatchObject({
      status: 'existing', inputKind: 'project-path', projectHash
    });
    expect(resolveExistingStore(projectHash, { homeDir })).toMatchObject({
      status: 'existing', inputKind: 'project-hash', projectHash
    });
    expect(resolveExistingStore(symlinkPath, { homeDir })).toMatchObject({
      status: 'existing', inputKind: 'project-path', projectHash
    });
  });

  it('classifies invalid, unreadable, corrupt, and symlinked storage safely', async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-resolver-errors-'));
    expect(resolveExistingStore('   ', { homeDir }).status).toBe('invalid');
    expect(resolveExistingStore('bad\0path', { homeDir }).status).toBe('invalid');

    const unreadableHash = 'aaa11111';
    const unreadableStorage = await createStore(homeDir, unreadableHash);
    chmodSync(path.join(unreadableStorage, 'events.sqlite'), 0o000);
    expect(resolveExistingStore(unreadableHash, { homeDir }).status).toBe('unreadable');
    chmodSync(path.join(unreadableStorage, 'events.sqlite'), 0o600);

    const corruptHash = 'bbb22222';
    const corruptStorage = path.join(homeDir, '.claude-code', 'memory', 'projects', corruptHash);
    mkdirSync(corruptStorage, { recursive: true });
    writeFileSync(path.join(corruptStorage, 'events.sqlite'), 'not a sqlite database');
    expect(resolveExistingStore(corruptHash, { homeDir }).status).toBe('corrupt');

    const targetHash = 'ccc33333';
    const targetStorage = await createStore(homeDir, targetHash);
    const symlinkHash = 'ddd44444';
    symlinkSync(targetStorage, path.join(homeDir, '.claude-code', 'memory', 'projects', symlinkHash));
    expect(resolveExistingStore(symlinkHash, { homeDir }).status).toBe('invalid');
  });
});
