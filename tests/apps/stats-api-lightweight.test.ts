import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => {
  const service = {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    getStats: vi.fn(),
    getRecentEvents: vi.fn(),
    getRetrievalTraceStats: vi.fn(),
    getSharedStoreStats: vi.fn(),
    getEventsByLevel: vi.fn(),
    getMostAccessedMemories: vi.fn(),
    getHelpfulnessStats: vi.fn(),
    getHelpfulMemories: vi.fn(),
    getRecentRetrievalTraces: vi.fn(),
    getEndlessModeStatus: vi.fn()
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
    mocks.service.getSharedStoreStats.mockReset().mockResolvedValue({ total: 0, totalUsageCount: 0 });
    mocks.service.getEventsByLevel.mockReset().mockResolvedValue([]);
    mocks.service.getMostAccessedMemories.mockReset().mockResolvedValue([]);
    mocks.service.getHelpfulnessStats.mockReset().mockResolvedValue({ avgScore: 0, totalEvaluated: 0, totalRetrievals: 0, helpful: 0, neutral: 0, unhelpful: 0 });
    mocks.service.getHelpfulMemories.mockReset().mockResolvedValue([]);
    mocks.service.getRecentRetrievalTraces.mockReset().mockResolvedValue([]);
    mocks.service.getEndlessModeStatus.mockReset().mockResolvedValue({ mode: 'session', continuityScore: 0, workingSetSize: 0, consolidatedCount: 0 });
    mocks.getServiceFromQuery.mockReset().mockImplementation(() => {
      throw new Error('full service must not be initialized for read-only stats endpoints');
    });
    mocks.getLightweightServiceFromQuery.mockReset().mockReturnValue(mocks.service);
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

  it('dashboard-read stats subroutes avoid full embedder-backed service initialization', async () => {
    const app = createApp();
    const paths = [
      '/api/stats/shared?project=abc12345',
      '/api/stats/endless?project=abc12345',
      '/api/stats/levels/L0?project=abc12345',
      '/api/stats/most-accessed?project=abc12345&limit=10',
      '/api/stats/helpfulness?project=abc12345&limit=5',
      '/api/stats/timeline?project=abc12345&days=14',
      '/api/stats/kpi?project=abc12345&window=7d',
      '/api/stats/retrieval-traces?project=abc12345&limit=20',
      '/api/stats/retrieval-review-queue?project=abc12345&limit=10'
    ];

    const responses = await Promise.all(paths.map(async (path) => ({ path, res: await app.request(path) })));

    for (const { path, res } of responses) {
      expect(res.status, path).toBe(200);
    }
    expect(mocks.getServiceFromQuery).not.toHaveBeenCalled();
    expect(mocks.getLightweightServiceFromQuery).toHaveBeenCalledTimes(paths.length);
  });
});
