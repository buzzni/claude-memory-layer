import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getProjectStoragePath,
  hashProjectPath,
  normalizeProjectPath,
  resolveProjectStoragePath
} from '../../src/core/registry/project-path.js';

describe('project-path registry utilities', () => {
  it('normalizes paths and generates stable hashes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cml-project-path-'));
    const projectDir = path.join(root, 'project');
    await fs.mkdir(projectDir, { recursive: true });

    const hashA = hashProjectPath(projectDir);
    const hashB = hashProjectPath(projectDir + '/');

    const normalized = normalizeProjectPath(projectDir + '/');

    expect(normalized.endsWith('/project')).toBe(true);
    expect(hashA).toBe(hashB);
    expect(hashA).toMatch(/^[a-f0-9]{8}$/);
  });

  it('resolves storage paths for both project paths and explicit hashes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cml-storage-path-'));
    const projectDir = path.join(root, 'project');
    await fs.mkdir(projectDir, { recursive: true });

    const projectHash = hashProjectPath(projectDir);
    const storageFromPath = getProjectStoragePath(projectDir);
    const storageFromResolverPath = resolveProjectStoragePath(projectDir);
    const storageFromResolverHash = resolveProjectStoragePath(projectHash);

    expect(storageFromPath).toBe(storageFromResolverPath);
    expect(storageFromResolverHash).toContain(path.join('.claude-code', 'memory', 'projects', projectHash));
  });
});

describe('session registry utilities', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('os');
  });

  it('registers and loads project mapping from the isolated home directory', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cml-home-'));
    const projectDir = path.join(tempHome, 'workspace', 'project');
    await fs.mkdir(projectDir, { recursive: true });

    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof import('os')>('os');
      return {
        ...actual,
        homedir: () => tempHome
      };
    });

    const registryModule = await import('../../src/core/registry/session-registry.js');

    registryModule.registerSession('session-123', projectDir);
    const projectInfo = registryModule.getSessionProject('session-123');

    expect(projectInfo).not.toBeNull();
    expect(projectInfo?.projectPath.endsWith('/workspace/project')).toBe(true);
    expect(projectInfo?.projectHash).toBe(hashProjectPath(projectDir));

    const registryPath = path.join(tempHome, '.claude-code', 'memory', 'session-registry.json');
    const saved = JSON.parse(await fs.readFile(registryPath, 'utf8')) as {
      sessions: Record<string, { projectPath: string }>;
    };

    expect(saved.sessions['session-123']?.projectPath.endsWith('/workspace/project')).toBe(true);

    registryModule.unregisterSession('session-123');
    expect(registryModule.getSessionProject('session-123')).toBeNull();

    const afterRemoval = JSON.parse(await fs.readFile(registryPath, 'utf8')) as {
      sessions: Record<string, { projectPath: string }>;
    };
    expect(afterRemoval.sessions['session-123']).toBeUndefined();
  });

  it('removes a transient mapping when the registered action fails', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cml-home-'));
    const fixtureHome = path.join(tempHome, 'frozen-fixture-home');
    const projectDir = path.join(tempHome, 'workspace', 'project');
    await fs.mkdir(projectDir, { recursive: true });

    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof import('os')>('os');
      return {
        ...actual,
        homedir: () => tempHome
      };
    });

    const registryModule = await import('../../src/core/registry/session-registry.js');
    await expect(registryModule.withRegisteredSession('field-eval-failure', projectDir, async () => {
      expect(registryModule.getSessionProject('field-eval-failure', { homeDir: fixtureHome })).not.toBeNull();
      throw new Error('forced evaluation failure');
    }, { homeDir: fixtureHome })).rejects.toThrow('forced evaluation failure');

    expect(registryModule.getSessionProject('field-eval-failure', { homeDir: fixtureHome })).toBeNull();
    expect(registryModule.getSessionProject('field-eval-failure')).toBeNull();
  });
});
