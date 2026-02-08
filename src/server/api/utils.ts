/**
 * API Utilities
 * Shared helpers for API endpoints
 */

import type { Context } from 'hono';
import * as path from 'path';
import * as os from 'os';
import { getReadOnlyMemoryService } from '../../services/memory-service.js';
import { MemoryService } from '../../services/memory-service.js';

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
  const project = c.req.query('project');
  if (project) {
    // Check if it's a hash (8 hex chars) or a path
    const isHash = /^[a-f0-9]{8}$/.test(project);
    let storagePath: string;

    if (isHash) {
      storagePath = path.join(os.homedir(), '.claude-code', 'memory', 'projects', project);
    } else {
      // Import hashProjectPath dynamically to compute the hash from path
      const crypto = require('crypto');
      const normalized = project.replace(/\/+$/, '') || '/';
      const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 8);
      storagePath = path.join(os.homedir(), '.claude-code', 'memory', 'projects', hash);
    }

    return new MemoryService({
      storagePath,
      readOnly: true,
      analyticsEnabled: false,
      sharedStoreConfig: { enabled: false }
    });
  }
  return getReadOnlyMemoryService();
}
