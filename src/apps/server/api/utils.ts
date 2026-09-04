/**
 * API Utilities
 * Shared helpers for API endpoints
 */

import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  DISABLED_SHARED_STORE_CONFIG,
  getReadOnlyMemoryService,
  MemoryService
} from '../../../services/memory-service.js';
import { hashProjectPath, resolveProjectStoragePath } from '../../../core/registry/project-path.js';
import { resolveExistingStore } from '../../../core/registry/existing-store.js';
import { SQLiteEventStore } from '../../../core/sqlite-event-store.js';
import {
  createReadOnlyDiagnosticsService,
  MemoryStoreResolutionError,
  type ReadOnlyDiagnosticsService
} from '../../../services/read-only-diagnostics-service.js';

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
    const projectHash = /^[a-f0-9]{8}$/.test(project) ? project : hashProjectPath(project);

    return new MemoryService({
      storagePath,
      projectHash,
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
    const projectHash = /^[a-f0-9]{8}$/.test(project) ? project : hashProjectPath(project);

    return new MemoryService({
      storagePath,
      projectHash,
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
    const projectHash = /^[a-f0-9]{8}$/.test(project) ? project : hashProjectPath(project);

    return new MemoryService({
      storagePath,
      projectHash,
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

/**
 * Resolve a WRITABLE event store for the few routes that mutate (currently only
 * `DELETE /api/events/:id`). Deliberately separate from the read-only diagnostics
 * factory above: that one opens the database with `readonly: true, snapshot: true`,
 * which is what every dashboard read wants and what a delete must not get.
 *
 * Returns null when the store does not exist yet — the caller answers 404 rather than
 * creating a database as a side effect of a delete.
 *
 * The caller owns the returned store and must `close()` it.
 */
export function getWritableEventStoreFromQuery(
  c: Context
): { store: SQLiteEventStore; storagePath?: string } | null {
  const project = c.req.query('project') || c.req.query('projectId');
  let resolution;
  try {
    resolution = resolveExistingStore(project || undefined);
  } catch (error) {
    if (error instanceof MemoryStoreResolutionError) {
      throw storeUnavailable(error.storeStatus);
    }
    throw error;
  }
  if (resolution.status === 'missing') return null;
  if (resolution.status !== 'existing' || !resolution.databasePath) {
    throw storeUnavailable(resolution.status);
  }
  return {
    store: new SQLiteEventStore(resolution.databasePath, { readonly: false }),
    storagePath: resolution.storagePath
  };
}

/** Same 422 envelope both store factories use for an unusable target. */
function storeUnavailable(storeStatus: string): HTTPException {
  return new HTTPException(422, {
    res: new Response(
      JSON.stringify({
        status: 'error',
        timestamp: new Date().toISOString(),
        error: `Memory store is ${storeStatus}`
      }),
      { status: 422, headers: { 'content-type': 'application/json' } }
    )
  });
}

/**
 * Resolve an uncached, existing-store-only reader for dashboard diagnostics.
 * Missing stores produce an empty reader; invalid, unreadable, and corrupt
 * targets fail without exposing their resolved filesystem path.
 */
export function getDiagnosticsServiceFromQuery(c: Context): ReadOnlyDiagnosticsService {
  const project = c.req.query('project') || c.req.query('projectId');
  try {
    return createReadOnlyDiagnosticsService(project || undefined);
  } catch (error) {
    // Routes call this factory before their try/catch, so an invalid,
    // unreadable, or corrupt store must become a structured HTTP response
    // here rather than an unhandled Hono 500 with a raw stack.
    if (error instanceof MemoryStoreResolutionError) {
      throw new HTTPException(422, {
        res: new Response(
          JSON.stringify({
            status: 'error',
            timestamp: new Date().toISOString(),
            error: `Memory store is ${error.storeStatus}`
          }),
          { status: 422, headers: { 'content-type': 'application/json' } }
        )
      });
    }
    throw error;
  }
}
