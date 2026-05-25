/**
 * Health API
 * Operational health checks including outbox backlog/failures
 */

import { Hono } from 'hono';
import { getLightweightServiceFromQuery, getWritableServiceFromQuery } from './utils.js';

export const healthRouter = new Hono();

// GET /api/health
healthRouter.get('/', async (c) => {
  const memoryService = getLightweightServiceFromQuery(c);
  try {
    await memoryService.initialize();

    const [stats, outbox] = await Promise.all([
      memoryService.getStats(),
      memoryService.getOutboxStats()
    ]);

    const outboxPending = outbox.embedding.pending + outbox.vector.pending;
    const outboxProcessing = outbox.embedding.processing + outbox.vector.processing;
    const outboxFailed = outbox.embedding.failed + outbox.vector.failed;
    const outboxStuckProcessing = outbox.embedding.stuckProcessing + outbox.vector.stuckProcessing;
    const oldestProcessingAgeMs = Math.max(
      outbox.embedding.oldestProcessingAgeMs ?? 0,
      outbox.vector.oldestProcessingAgeMs ?? 0
    ) || null;

    const status = outboxFailed > 0 || outboxStuckProcessing > 0 ? 'needs-attention' : 'ok';

    return c.json({
      status,
      timestamp: new Date().toISOString(),
      storage: {
        totalEvents: stats.totalEvents,
        vectorCount: stats.vectorCount
      },
      outbox: {
        embedding: outbox.embedding,
        vector: outbox.vector,
        totals: {
          pending: outboxPending,
          processing: outboxProcessing,
          failed: outboxFailed,
          stuckProcessing: outboxStuckProcessing,
          oldestProcessingAgeMs
        }
      },
      levelStats: stats.levelStats
    });
  } catch {
    return c.json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: 'Health check failed'
    }, 500);
  } finally {
    await memoryService.shutdown();
  }
});

// POST /api/health/recover
// Recover stale processing/failed outbox work before another worker pass.
healthRouter.post('/recover', async (c) => {
  const memoryService = getWritableServiceFromQuery(c);
  try {
    await memoryService.initialize();

    const body = await c.req.json().catch(() => ({})) as {
      stuckThresholdMs?: unknown;
      maxRetries?: unknown;
    };
    const options: { stuckThresholdMs?: number; maxRetries?: number } = {};
    if (typeof body.stuckThresholdMs === 'number' && Number.isFinite(body.stuckThresholdMs)) {
      options.stuckThresholdMs = body.stuckThresholdMs;
    }
    if (typeof body.maxRetries === 'number' && Number.isFinite(body.maxRetries)) {
      options.maxRetries = body.maxRetries;
    }

    const before = await memoryService.getOutboxStats();
    const recovered = await memoryService.recoverStuckOutboxItems(options);
    const [stats, outbox] = await Promise.all([
      memoryService.getStats(),
      memoryService.getOutboxStats()
    ]);

    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      recovered,
      before: {
        outbox: before
      },
      after: {
        storage: {
          totalEvents: stats.totalEvents,
          vectorCount: stats.vectorCount
        },
        outbox
      }
    });
  } catch {
    return c.json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: 'Outbox recovery failed'
    }, 500);
  } finally {
    await memoryService.shutdown();
  }
});
