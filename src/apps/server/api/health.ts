/**
 * Health API
 * Operational health checks including outbox backlog/failures
 */

import { Hono } from 'hono';
import { getServiceFromQuery } from './utils.js';

export const healthRouter = new Hono();

// GET /api/health
healthRouter.get('/', async (c) => {
  const memoryService = getServiceFromQuery(c);
  try {
    await memoryService.initialize();

    const [stats, outbox] = await Promise.all([
      memoryService.getStats(),
      memoryService.getOutboxStats()
    ]);

    const outboxPending = outbox.embedding.pending + outbox.vector.pending;
    const outboxFailed = outbox.embedding.failed + outbox.vector.failed;

    const status = outboxFailed > 0 ? 'needs-attention' : 'ok';

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
          failed: outboxFailed
        }
      },
      levelStats: stats.levelStats
    });
  } catch (error) {
    return c.json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: (error as Error).message
    }, 500);
  } finally {
    await memoryService.shutdown();
  }
});
