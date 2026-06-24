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
    getLightweightServiceFromQuery: vi.fn(() => service),
    getWritableServiceFromQuery: vi.fn(() => service)
  };
});

vi.mock('../../src/apps/server/api/utils.js', () => ({
  getServiceFromQuery: mocks.getServiceFromQuery,
  getLightweightServiceFromQuery: mocks.getLightweightServiceFromQuery,
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
      embedding: { pending: 1, processing: 0, failed: 0, retryableFailed: 0, quarantinedFailed: 0, total: 1, stuckProcessing: 0, oldestProcessingAgeMs: null },
      vector: { pending: 0, processing: 0, failed: 0, retryableFailed: 0, quarantinedFailed: 0, total: 0, stuckProcessing: 0, oldestProcessingAgeMs: null }
    });
    mocks.service.recoverStuckOutboxItems.mockReset().mockResolvedValue({
      embedding: { recoveredProcessing: 34, retriedFailed: 0 },
      vector: { recoveredProcessing: 2, retriedFailed: 1 }
    });
    mocks.getServiceFromQuery.mockReset().mockImplementation(() => {
      throw new Error('full service must not initialize dashboard read health');
    });
    mocks.getLightweightServiceFromQuery.mockReset().mockImplementation(() => mocks.service);
    mocks.getWritableServiceFromQuery.mockReset().mockImplementation(() => mocks.service);
  });

  it('reads dashboard health through the lightweight service instead of full embedder initialization', async () => {
    const res = await createApp().request('/api/health?project=abc12345');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.storage).toEqual({ totalEvents: 51, vectorCount: 0 });
    expect(json.outbox.totals).toEqual({ pending: 1, processing: 0, failed: 0, retryableFailed: 0, quarantinedFailed: 0, stuckProcessing: 0, oldestProcessingAgeMs: null });
    expect(mocks.getLightweightServiceFromQuery).toHaveBeenCalledTimes(1);
    expect(mocks.getServiceFromQuery).not.toHaveBeenCalled();
    expect(mocks.getWritableServiceFromQuery).not.toHaveBeenCalled();
    expect(mocks.service.shutdown).toHaveBeenCalledTimes(1);
  });

  it('marks health as needs-attention and returns aggregate stuck-processing totals', async () => {
    mocks.service.getOutboxStats.mockResolvedValueOnce({
      embedding: { pending: 2, processing: 3, failed: 0, total: 5, stuckProcessing: 1, oldestProcessingAgeMs: 600000 },
      vector: { pending: 1, processing: 2, failed: 0, total: 4, stuckProcessing: 2, oldestProcessingAgeMs: 1200000 }
    });

    const res = await createApp().request('/api/health?project=abc12345');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('needs-attention');
    expect(json.outbox.embedding).toMatchObject({ processing: 3, stuckProcessing: 1, oldestProcessingAgeMs: 600000 });
    expect(json.outbox.vector).toMatchObject({ processing: 2, stuckProcessing: 2, oldestProcessingAgeMs: 1200000 });
    expect(json.outbox.totals).toEqual({
      pending: 3,
      processing: 5,
      failed: 0,
      retryableFailed: 0,
      quarantinedFailed: 0,
      stuckProcessing: 3,
      oldestProcessingAgeMs: 1200000
    });
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

  it('does not leak raw health check errors in dashboard API responses', async () => {
    mocks.service.getStats.mockRejectedValueOnce(
      new Error('PRIVATE_HEALTH_ERROR_SENTINEL /Users/private/project/raw-source.txt')
    );

    const res = await createApp().request('/api/health?project=abc12345');

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toEqual({
      status: 'error',
      timestamp: expect.any(String),
      error: 'Health check failed'
    });
    expect(JSON.stringify(json)).not.toContain('PRIVATE_HEALTH_ERROR_SENTINEL');
    expect(JSON.stringify(json)).not.toContain('/Users/private/project/raw-source.txt');
  });

  it('does not leak raw recovery errors in dashboard API responses', async () => {
    mocks.service.recoverStuckOutboxItems.mockRejectedValueOnce(
      new Error('PRIVATE_RECOVERY_ERROR_SENTINEL outbox-row-id=raw-123')
    );

    const res = await createApp().request('/api/health/recover?project=abc12345', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toEqual({
      status: 'error',
      timestamp: expect.any(String),
      error: 'Outbox recovery failed'
    });
    expect(JSON.stringify(json)).not.toContain('PRIVATE_RECOVERY_ERROR_SENTINEL');
    expect(JSON.stringify(json)).not.toContain('raw-123');
  });
});
