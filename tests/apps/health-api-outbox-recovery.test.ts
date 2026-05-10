import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => {
  const service = {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    getStats: vi.fn(),
    getOutboxStats: vi.fn(),
    recoverStuckOutboxItems: vi.fn()
  };

  return {
    service,
    getServiceFromQuery: vi.fn(() => service),
    getWritableServiceFromQuery: vi.fn(() => service)
  };
});

vi.mock('../../src/apps/server/api/utils.js', () => ({
  getServiceFromQuery: mocks.getServiceFromQuery,
  getWritableServiceFromQuery: mocks.getWritableServiceFromQuery
}));

const { healthRouter } = await import('../../src/apps/server/api/health.js');

function createApp() {
  const app = new Hono();
  app.route('/api/health', healthRouter);
  return app;
}

describe('health API outbox recovery', () => {
  beforeEach(() => {
    mocks.service.initialize.mockReset().mockResolvedValue(undefined);
    mocks.service.shutdown.mockReset().mockResolvedValue(undefined);
    mocks.service.getStats.mockReset().mockResolvedValue({
      totalEvents: 51,
      vectorCount: 0,
      levelStats: []
    });
    mocks.service.getOutboxStats.mockReset().mockResolvedValue({
      embedding: { pending: 1, processing: 0, failed: 0, total: 1 },
      vector: { pending: 0, processing: 0, failed: 0, total: 0 }
    });
    mocks.service.recoverStuckOutboxItems.mockReset().mockResolvedValue({
      embedding: { recoveredProcessing: 34, retriedFailed: 0 },
      vector: { recoveredProcessing: 2, retriedFailed: 1 }
    });
    mocks.getServiceFromQuery.mockClear();
    mocks.getWritableServiceFromQuery.mockClear();
  });

  it('recovers stuck outbox items through an authenticated dashboard-safe API seam', async () => {
    const res = await createApp().request('/api/health/recover?project=abc12345', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stuckThresholdMs: 60000, maxRetries: 5 })
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.recovered).toEqual({
      embedding: { recoveredProcessing: 34, retriedFailed: 0 },
      vector: { recoveredProcessing: 2, retriedFailed: 1 }
    });
    expect(json.before.outbox.embedding.pending).toBe(1);
    expect(json.after.outbox.embedding.pending).toBe(1);
    expect(mocks.service.getOutboxStats).toHaveBeenCalledTimes(2);
    expect(mocks.service.recoverStuckOutboxItems).toHaveBeenCalledWith({
      stuckThresholdMs: 60000,
      maxRetries: 5
    });
    expect(mocks.getWritableServiceFromQuery).toHaveBeenCalledTimes(1);
    expect(mocks.getServiceFromQuery).not.toHaveBeenCalled();
    expect(mocks.service.shutdown).toHaveBeenCalledTimes(1);
  });
});
