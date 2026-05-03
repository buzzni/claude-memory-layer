/**
 * Memory Service Registry
 *
 * Owns process-local MemoryService instance caching and project/session service
 * resolution. Keeping this out of MemoryService prevents the compatibility
 * facade from also being the application-level service locator.
 */

import * as path from 'path';

import type { SharedStoreConfig } from '../core/types.js';
import type { MemoryServiceConfig } from './memory-service-config.js';

export type MemoryServiceRegistryConfig = MemoryServiceConfig & {
  projectHash?: string;
  projectPath?: string;
  sharedStoreConfig?: SharedStoreConfig;
};

export interface MemoryServiceRegistryDeps<TService> {
  createService: (config: MemoryServiceRegistryConfig) => TService;
  hashProjectPath: (projectPath: string) => string;
  getProjectStoragePath: (projectPath: string) => string;
  getSessionProject: (sessionId: string) => { projectHash: string; projectPath: string } | null;
  homedir: () => string;
  disabledSharedStoreConfig: SharedStoreConfig;
  serviceCache?: Map<string, TService>;
}

export interface MemoryServiceRegistry<TService> {
  getDefaultMemoryService(): TService;
  getReadOnlyMemoryService(): TService;
  getMemoryServiceForProject(projectPath: string, sharedStoreConfig?: SharedStoreConfig): TService;
  getMemoryServiceForSession(sessionId: string): TService;
  getLightweightMemoryService(sessionId: string): TService;
  createMemoryService(config: MemoryServiceConfig): TService;
}

const GLOBAL_KEY = '__global__';

export function createMemoryServiceRegistry<TService>(
  deps: MemoryServiceRegistryDeps<TService>
): MemoryServiceRegistry<TService> {
  const serviceCache = deps.serviceCache ?? new Map<string, TService>();

  const getDefaultMemoryService = (): TService => {
    if (!serviceCache.has(GLOBAL_KEY)) {
      serviceCache.set(GLOBAL_KEY, deps.createService({
        storagePath: '~/.claude-code/memory',
        analyticsEnabled: false,
        sharedStoreConfig: deps.disabledSharedStoreConfig
      }));
    }
    return serviceCache.get(GLOBAL_KEY)!;
  };

  const getReadOnlyMemoryService = (): TService => deps.createService({
    storagePath: '~/.claude-code/memory',
    readOnly: true,
    analyticsEnabled: false,
    sharedStoreConfig: deps.disabledSharedStoreConfig
  });

  const getMemoryServiceForProject = (
    projectPath: string,
    sharedStoreConfig?: SharedStoreConfig
  ): TService => {
    const hash = deps.hashProjectPath(projectPath);

    if (!serviceCache.has(hash)) {
      serviceCache.set(hash, deps.createService({
        storagePath: deps.getProjectStoragePath(projectPath),
        projectHash: hash,
        projectPath,
        sharedStoreConfig: sharedStoreConfig ?? deps.disabledSharedStoreConfig,
        analyticsEnabled: false
      }));
    }

    return serviceCache.get(hash)!;
  };

  const getMemoryServiceForSession = (sessionId: string): TService => {
    const projectInfo = deps.getSessionProject(sessionId);

    if (projectInfo) {
      return getMemoryServiceForProject(projectInfo.projectPath);
    }

    return getDefaultMemoryService();
  };

  const getLightweightMemoryService = (sessionId: string): TService => {
    const projectInfo = deps.getSessionProject(sessionId);
    const key = projectInfo ? `lightweight_${projectInfo.projectHash}` : 'lightweight_global';

    if (!serviceCache.has(key)) {
      const storagePath = projectInfo
        ? deps.getProjectStoragePath(projectInfo.projectPath)
        : path.join(deps.homedir(), '.claude-code', 'memory');

      serviceCache.set(key, deps.createService({
        storagePath,
        projectHash: projectInfo?.projectHash,
        projectPath: projectInfo?.projectPath,
        lightweightMode: true,
        analyticsEnabled: false,
        sharedStoreConfig: deps.disabledSharedStoreConfig
      }));
    }

    return serviceCache.get(key)!;
  };

  return {
    getDefaultMemoryService,
    getReadOnlyMemoryService,
    getMemoryServiceForProject,
    getMemoryServiceForSession,
    getLightweightMemoryService,
    createMemoryService: (config: MemoryServiceConfig): TService => deps.createService(config)
  };
}
