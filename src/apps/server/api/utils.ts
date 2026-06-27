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

type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500;

/**
 * Return a generic JSON error to the client while logging the real error
 * server-side. Raw exception messages can leak internal details (filesystem
 * paths, SQLite/driver errors, embedding-backend context), so handlers should
 * never reflect `(error as Error).message` straight back to the caller.
 */
export function jsonError(
  c: Context,
  error: unknown,
  options: { status?: ApiErrorStatus; message?: string } = {}
) {
  const status: ApiErrorStatus = options.status ?? 500;
  console.error(`[api] ${c.req.method} ${c.req.path} failed:`, error);
  return c.json({ error: options.message ?? 'Internal server error' }, status);
}

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
 * Writable lightweight service for explicit maintenance endpoints.
 * Dashboard read endpoints intentionally use read-only services; recovery needs
 * a write-capable SQLite store but still avoids vector/embedder initialization.
 */
export function getWritableServiceFromQuery(c: Context): MemoryService {
  const project = c.req.query('project') || c.req.query('projectId');
  if (project) {
    const storagePath = resolveProjectStoragePath(project);

    return new MemoryService({
      storagePath,
      readOnly: false,
      lightweightMode: true,
      analyticsEnabled: false,
      sharedStoreConfig: DISABLED_SHARED_STORE_CONFIG
    });
  }

  return new MemoryService({
    storagePath: '~/.claude-code/memory',
    readOnly: false,
    lightweightMode: true,
    analyticsEnabled: false,
    sharedStoreConfig: DISABLED_SHARED_STORE_CONFIG
  });
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
