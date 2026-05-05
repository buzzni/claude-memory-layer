/**
 * API Utilities
 * Shared helpers for API endpoints
 */

import type { Context } from 'hono';
import {
  DISABLED_SHARED_STORE_CONFIG,
  getReadOnlyMemoryService,
  MemoryService
} from '../../../services/memory-service.js';
import { resolveProjectStoragePath } from '../../../core/registry/project-path.js';

/**
 * Get the appropriate MemoryService based on the ?project= query parameter.
 * - If ?project=<hash> is set (8 hex chars), resolves directly to project storage
 * - If ?project=<path> is set, computes hash from path
 * - Otherwise, returns the global read-only service
 *
 * Always creates read-only services for the dashboard API to avoid
 * VectorWorker lifecycle issues with per-request services.
 */
export function getServiceFromQuery(c: Context): MemoryService {
  const project = c.req.query('project') || c.req.query('projectId');
  if (project) {
    const storagePath = resolveProjectStoragePath(project);

    return new MemoryService({
      storagePath,
      readOnly: true,
      analyticsEnabled: false,
      sharedStoreConfig: DISABLED_SHARED_STORE_CONFIG
    });
  }
  return getReadOnlyMemoryService();
}


/**
 * Read-only lightweight service for API paths that only need sqlite/keyword reads.
 * This avoids per-request vector/embedder/shared-store initialization for stats and
 * explicit fast searches while preserving the same project query resolution rules.
 */
export function getLightweightServiceFromQuery(c: Context): MemoryService {
  const project = c.req.query('project') || c.req.query('projectId');
  if (project) {
    const storagePath = resolveProjectStoragePath(project);

    return new MemoryService({
      storagePath,
      readOnly: true,
      lightweightMode: true,
      analyticsEnabled: false,
      sharedStoreConfig: DISABLED_SHARED_STORE_CONFIG
    });
  }

  return new MemoryService({
    storagePath: '~/.claude-code/memory',
    readOnly: true,
    lightweightMode: true,
    analyticsEnabled: false,
    sharedStoreConfig: DISABLED_SHARED_STORE_CONFIG
  });
}
