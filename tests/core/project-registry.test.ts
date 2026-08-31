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

  it('preserves a newer registration when transient cleanup finishes late', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cml-registry-transient-race-'));
    const homeDir = path.join(root, 'home');
    const projectDir = path.join(root, 'project');
    await fs.mkdir(projectDir, { recursive: true });
    const registryModule = await import('../../src/core/registry/session-registry.js');

    await registryModule.withRegisteredSession('shared-id', projectDir, async () => {
      registryModule.registerSession('shared-id', projectDir, { homeDir });
    }, { homeDir });

    expect(registryModule.getSessionProject('shared-id', { homeDir })).toMatchObject({ terminal: false });
  });

  it('repairs malformed registry containers when registering a session', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cml-registry-malformed-'));
    const homeDir = path.join(root, 'home');
    const projectDir = path.join(root, 'project');
    const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(memoryRoot, { recursive: true });
    await fs.writeFile(path.join(memoryRoot, 'session-registry.json'), JSON.stringify({ version: 2, sessions: [] }));
    const registryModule = await import('../../src/core/registry/session-registry.js');

    registryModule.registerSession('repaired', projectDir, { homeDir });

    expect(registryModule.getSessionProject('repaired', { homeDir })).toMatchObject({
      projectHash: hashProjectPath(projectDir),
      terminal: false
    });
  });

  it('preserves recent active sessions while evicting expired terminal entries over capacity', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cml-registry-retention-'));
    const homeDir = path.join(root, 'home');
    const projectDir = path.join(root, 'project');
    const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(memoryRoot, { recursive: true });
    const recentAt = '2026-08-30T00:00:00.000Z';
    const sessions: Record<string, Record<string, unknown>> = {};
    for (let index = 0; index < 1001; index += 1) {
      sessions[`recent-${index}`] = {
        projectPath: projectDir,
        projectHash: hashProjectPath(projectDir),
        registeredAt: recentAt,
        lastSeenAt: recentAt,
        identityKind: 'path-fallback',
        terminal: false
      };
    }
    for (let index = 0; index < 10; index += 1) {
      sessions[`expired-${index}`] = {
        projectPath: projectDir,
        projectHash: hashProjectPath(projectDir),
        registeredAt: '2025-01-01T00:00:00.000Z',
        lastSeenAt: '2025-01-01T00:00:00.000Z',
        identityKind: 'path-fallback',
        terminal: true
      };
    }
    await fs.writeFile(path.join(memoryRoot, 'session-registry.json'), JSON.stringify({ version: 2, sessions }));
    const registryModule = await import('../../src/core/registry/session-registry.js');

    registryModule.registerSession('new-live', projectDir, {
      homeDir,
      now: () => new Date('2026-08-31T00:00:00.000Z')
    });

    const saved = registryModule.loadSessionRegistry({ homeDir });
    expect(saved.version).toBe(2);
    expect(saved.sessions['recent-0']).toBeDefined();
    expect(saved.sessions['new-live']).toMatchObject({
      lastSeenAt: '2026-08-31T00:00:00.000Z',
      terminal: false
    });
    expect(Object.keys(saved.sessions).filter((id) => id.startsWith('expired-'))).toEqual([]);
    expect(Object.keys(saved.sessions)).toHaveLength(1002);
  });

  it('preserves old terminal mappings for a project store with recent event activity', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cml-registry-event-retention-'));
    const homeDir = path.join(root, 'home');
    const projectDir = path.join(root, 'project');
    const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
    const projectHash = hashProjectPath(projectDir);
    const storagePath = path.join(memoryRoot, 'projects', projectHash);
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(storagePath, { recursive: true });
    const activityPath = path.join(storagePath, 'events.sqlite');
    await fs.writeFile(activityPath, 'activity marker');
    const recentActivity = new Date('2026-08-30T00:00:00.000Z');
    await fs.utimes(activityPath, recentActivity, recentActivity);

    const sessions: Record<string, Record<string, unknown>> = {
      'recent-project-history': {
        projectPath: projectDir,
        projectHash,
        registeredAt: '2024-01-01T00:00:00.000Z',
        lastSeenAt: '2024-01-01T00:00:00.000Z',
        terminal: true
      }
    };
    for (let index = 0; index < 1_000; index += 1) {
      sessions[`expired-${index}`] = {
        projectPath: path.join(root, `expired-${index}`),
        projectHash: index.toString(16).padStart(8, '0'),
        registeredAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: '2026-01-01T00:00:00.000Z',
        terminal: true
      };
    }
    await fs.mkdir(memoryRoot, { recursive: true });
    await fs.writeFile(path.join(memoryRoot, 'session-registry.json'), JSON.stringify({ version: 2, sessions }));
    const registryModule = await import('../../src/core/registry/session-registry.js');

    registryModule.registerSession('new-live', projectDir, {
      homeDir,
      now: () => new Date('2026-08-31T00:00:00.000Z')
    });

    const saved = registryModule.loadSessionRegistry({ homeDir });
    expect(saved.sessions['recent-project-history']).toBeDefined();
    expect(saved.sessions['new-live']).toBeDefined();
    expect(Object.keys(saved.sessions)).toHaveLength(1_000);
  });

  it('does not mark a newer registration terminal through a stale SessionEnd generation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cml-registry-generation-'));
    const homeDir = path.join(root, 'home');
    const projectDir = path.join(root, 'project');
    await fs.mkdir(projectDir, { recursive: true });
    const registryModule = await import('../../src/core/registry/session-registry.js');

    registryModule.registerSession('resumed', projectDir, { homeDir });
    const previousRegistrationId = registryModule.getSessionProject('resumed', { homeDir })?.registrationId ?? null;
    registryModule.registerSession('resumed', projectDir, { homeDir });
    const currentRegistrationId = registryModule.getSessionProject('resumed', { homeDir })?.registrationId ?? null;

    expect(currentRegistrationId).not.toBe(previousRegistrationId);
    expect(registryModule.markSessionTerminalIfCurrent('resumed', previousRegistrationId, { homeDir })).toBe(false);
    expect(registryModule.getSessionProject('resumed', { homeDir })?.terminal).toBe(false);
    expect(registryModule.markSessionTerminalIfCurrent('resumed', currentRegistrationId, { homeDir })).toBe(true);
    expect(registryModule.getSessionProject('resumed', { homeDir })?.terminal).toBe(true);
  });

  it('registers completed imports as terminal in one registry transition', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cml-registry-import-terminal-'));
    const homeDir = path.join(root, 'home');
    const projectDir = path.join(root, 'project');
    await fs.mkdir(projectDir, { recursive: true });
    const registryModule = await import('../../src/core/registry/session-registry.js');

    const registrationId = registryModule.registerTerminalSession('imported', projectDir, { homeDir });

    expect(registryModule.getSessionProject('imported', { homeDir })).toMatchObject({
      terminal: true,
      registrationId
    });
  });

  it('recovers an orphaned registry lock left by a dead process', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cml-registry-lock-'));
    const homeDir = path.join(root, 'home');
    const projectDir = path.join(root, 'project');
    const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(memoryRoot, { recursive: true });
    const lockPath = path.join(memoryRoot, 'session-registry.json.lock');
    await fs.writeFile(lockPath, JSON.stringify({
      pid: 2_147_483_647,
      ownerId: 'orphaned-test-owner',
      acquiredAt: '2025-01-01T00:00:00.000Z'
    }));
    const registryModule = await import('../../src/core/registry/session-registry.js');

    registryModule.registerSession('recovered', projectDir, { homeDir });

    expect(registryModule.getSessionProject('recovered', { homeDir })).not.toBeNull();
    await expect(fs.access(lockPath)).rejects.toThrow();
  });
});
