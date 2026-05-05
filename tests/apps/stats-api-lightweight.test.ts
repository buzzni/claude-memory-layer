import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => {
  const service = {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    getStats: vi.fn(),
    getRecentEvents: vi.fn(),
    getRetrievalTraceStats: vi.fn()
  };

  return {
    service,
    getServiceFromQuery: vi.fn(),
    getLightweightServiceFromQuery: vi.fn(() => service)
  };
});

vi.mock('../../src/apps/server/api/utils.js', () => ({
  getServiceFromQuery: mocks.getServiceFromQuery,
  getLightweightServiceFromQuery: mocks.getLightweightServiceFromQuery
}));

vi.mock('../../src/services/memory-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/memory-service.js')>();
  return {
    ...actual,
    getMemoryServiceForProject: vi.fn(() => mocks.service)
  };
});

const { statsRouter } = await import('../../src/server/api/stats.js');

function createApp() {
  const app = new Hono();
  app.route('/api/stats', statsRouter);
  return app;
}

describe('stats API lightweight read paths', () => {
  beforeEach(() => {
    mocks.service.initialize.mockReset().mockResolvedValue(undefined);
    mocks.service.shutdown.mockReset().mockResolvedValue(undefined);
    mocks.service.getStats.mockReset().mockResolvedValue({ totalEvents: 2, vectorCount: 0, levelStats: [] });
    mocks.service.getRecentEvents.mockReset().mockResolvedValue([
      { id: 'e1', eventType: 'user_prompt', sessionId: 's1', timestamp: new Date('2026-05-01T00:00:00.000Z'), content: 'prompt', metadata: {} },
      { id: 'e2', eventType: 'agent_response', sessionId: 's1', timestamp: new Date('2026-05-01T00:01:00.000Z'), content: 'response', metadata: {} }
    ]);
    mocks.service.getRetrievalTraceStats.mockReset().mockResolvedValue({ totalQueries: 0, avgCandidateCount: 0, avgSelectedCount: 0, selectionRate: 0 });
    mocks.getServiceFromQuery.mockClear();
    mocks.getLightweightServiceFromQuery.mockClear();
  });

  it('GET /api/stats uses the lightweight read-only service instead of full initialization service', async () => {
    const res = await createApp().request('/api/stats?project=abc12345');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.storage).toEqual({ eventCount: 2, vectorCount: 0 });
    expect(body.sessions).toEqual({ total: 1 });
    expect(mocks.getLightweightServiceFromQuery).toHaveBeenCalledTimes(1);
    expect(mocks.getServiceFromQuery).not.toHaveBeenCalled();
    expect(mocks.service.initialize).toHaveBeenCalledTimes(1);
    expect(mocks.service.shutdown).toHaveBeenCalledTimes(1);
  });
});
