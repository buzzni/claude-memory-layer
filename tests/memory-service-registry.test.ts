import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { createMemoryServiceRegistry } from '../src/services/memory-service-registry.js';
import type { SharedStoreConfig } from '../src/core/types.js';

interface FakeService {
  config: Record<string, unknown>;
}

const disabledSharedStoreConfig: SharedStoreConfig = {
  enabled: false,
  autoPromote: false,
  searchShared: false,
  minConfidenceForPromotion: 0.8,
  sharedStoragePath: '/home/test/.claude-code/memory/shared'
};

function createRegistry(sessionProject?: { projectHash: string; projectPath: string }) {
  const createdConfigs: Array<Record<string, unknown>> = [];
  const registry = createMemoryServiceRegistry<FakeService>({
    createService: (config) => {
      createdConfigs.push(config as unknown as Record<string, unknown>);
      return { config: config as unknown as Record<string, unknown> };
    },
    hashProjectPath: (projectPath) => `hash:${projectPath}`,
    getProjectStoragePath: (projectPath) => `/storage/${projectPath}`,
    getSessionProject: (sessionId) => sessionId === 'known-session' ? sessionProject ?? null : null,
    homedir: () => '/home/test',
    disabledSharedStoreConfig
  });

  return { registry, createdConfigs };
}

describe('createMemoryServiceRegistry', () => {
  it('stays independent from the MemoryService facade to avoid service-locator cycles', () => {
    const source = readFileSync('src/services/memory-service-registry.ts', 'utf8');

    expect(source).not.toContain("from './memory-service.js'");
    expect(source).not.toContain('from "./memory-service.js"');
  });

  it('caches the default writable service with global storage and disabled shared store', () => {
    const { registry, createdConfigs } = createRegistry();

    const first = registry.getDefaultMemoryService();
    const second = registry.getDefaultMemoryService();

    expect(first).toBe(second);
    expect(createdConfigs).toHaveLength(1);
    expect(first.config).toMatchObject({
      storagePath: '~/.claude-code/memory',
      analyticsEnabled: false,
      sharedStoreConfig: disabledSharedStoreConfig
    });
  });

  it('creates fresh read-only services to avoid holding locks', () => {
    const { registry, createdConfigs } = createRegistry();

    const first = registry.getReadOnlyMemoryService();
    const second = registry.getReadOnlyMemoryService();

    expect(first).not.toBe(second);
    expect(createdConfigs).toHaveLength(2);
    expect(first.config).toMatchObject({
      storagePath: '~/.claude-code/memory',
      readOnly: true,
      analyticsEnabled: false,
      sharedStoreConfig: disabledSharedStoreConfig
    });
  });

  it('caches project services by project hash and preserves project scope config', () => {
    const { registry, createdConfigs } = createRegistry();

    const first = registry.getMemoryServiceForProject('/workspace/app');
    const second = registry.getMemoryServiceForProject('/workspace/app');

    expect(first).toBe(second);
    expect(createdConfigs).toHaveLength(1);
    expect(first.config).toMatchObject({
      storagePath: '/storage//workspace/app',
      projectHash: 'hash:/workspace/app',
      projectPath: '/workspace/app',
      analyticsEnabled: false,
      sharedStoreConfig: disabledSharedStoreConfig
    });
  });

  it('resolves session services from the session registry and falls back to global service', () => {
    const { registry } = createRegistry({
      projectHash: 'registered-hash',
      projectPath: '/workspace/registered'
    });

    const projectService = registry.getMemoryServiceForSession('known-session');
    const directService = registry.getMemoryServiceForProject('/workspace/registered');
    const fallbackService = registry.getMemoryServiceForSession('unknown-session');

    expect(projectService).toBe(directService);
    expect(fallbackService).toBe(registry.getDefaultMemoryService());
  });

  it('keeps registry methods safe when callers destructure a custom registry', () => {
    const { registry } = createRegistry({
      projectHash: 'registered-hash',
      projectPath: '/workspace/registered'
    });
    const {
      getDefaultMemoryService,
      getMemoryServiceForProject,
      getMemoryServiceForSession
    } = registry;

    const projectService = getMemoryServiceForSession('known-session');
    const directService = getMemoryServiceForProject('/workspace/registered');
    const fallbackService = getMemoryServiceForSession('unknown-session');

    expect(projectService).toBe(directService);
    expect(fallbackService).toBe(getDefaultMemoryService());
  });

  it('caches lightweight services separately for project and global sessions', () => {
    const { registry } = createRegistry({
      projectHash: 'registered-hash',
      projectPath: '/workspace/registered'
    });

    const projectService = registry.getLightweightMemoryService('known-session');
    const sameProjectService = registry.getLightweightMemoryService('known-session');
    const globalService = registry.getLightweightMemoryService('unknown-session');

    expect(projectService).toBe(sameProjectService);
    expect(projectService).not.toBe(globalService);
    expect(projectService.config).toMatchObject({
      storagePath: '/storage//workspace/registered',
      projectHash: 'registered-hash',
      projectPath: '/workspace/registered',
      lightweightMode: true,
      analyticsEnabled: false,
      sharedStoreConfig: disabledSharedStoreConfig
    });
    expect(globalService.config).toMatchObject({
      storagePath: '/home/test/.claude-code/memory',
      lightweightMode: true,
      analyticsEnabled: false,
      sharedStoreConfig: disabledSharedStoreConfig
    });
  });

  it('creates uncached services through the explicit factory facade', () => {
    const { registry } = createRegistry();

    const first = registry.createMemoryService({ storagePath: '/tmp/a' });
    const second = registry.createMemoryService({ storagePath: '/tmp/a' });

    expect(first).not.toBe(second);
    expect(first.config).toMatchObject({ storagePath: '/tmp/a' });
  });
});
