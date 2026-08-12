import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => {
  const service = {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    getStats: vi.fn(),
    getRecentEvents: vi.fn(),
    getEventsAfter: vi.fn(),
    getEventTypeCounts: vi.fn(),
    getDistinctSessionCount: vi.fn(),
    getDailyEventCounts: vi.fn(),
    getRetrievalTraceStats: vi.fn(),
    getSharedStoreStats: vi.fn(),
    getEventsByLevel: vi.fn(),
    getMostAccessedMemories: vi.fn(),
    getHelpfulnessStats: vi.fn(),
    getHelpfulnessStatsByDay: vi.fn(),
    getRetrievalTelemetryStats: vi.fn(),
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
    mocks.service.getEventsAfter.mockReset().mockResolvedValue([
      { id: 'e1', eventType: 'user_prompt', sessionId: 's1', timestamp: new Date('2026-05-01T00:00:00.000Z'), content: 'prompt', metadata: {} },
      { id: 'e2', eventType: 'agent_response', sessionId: 's1', timestamp: new Date('2026-05-01T00:01:00.000Z'), content: 'response', metadata: {} }
    ]);
    mocks.service.getEventTypeCounts.mockReset().mockResolvedValue([
      { eventType: 'user_prompt', count: 1 },
      { eventType: 'agent_response', count: 1 }
    ]);
    mocks.service.getDistinctSessionCount.mockReset().mockResolvedValue(1);
    mocks.service.getDailyEventCounts.mockReset().mockResolvedValue([
      { day: '2026-05-01', total: 2, prompts: 1, responses: 1, tools: 0 }
    ]);
    mocks.service.getRetrievalTraceStats.mockReset().mockResolvedValue({ totalQueries: 0, avgCandidateCount: 0, avgSelectedCount: 0, selectionRate: 0 });
    mocks.service.getSharedStoreStats.mockReset().mockResolvedValue({ total: 0, totalUsageCount: 0 });
    mocks.service.getEventsByLevel.mockReset().mockResolvedValue([]);
    mocks.service.getMostAccessedMemories.mockReset().mockResolvedValue([]);
    mocks.service.getHelpfulnessStats.mockReset().mockResolvedValue({ avgScore: 0, totalEvaluated: 0, totalRetrievals: 0, helpful: 0, neutral: 0, unhelpful: 0 });
    mocks.service.getHelpfulnessStatsByDay.mockReset().mockResolvedValue([]);
    mocks.service.getRetrievalTelemetryStats.mockReset().mockResolvedValue({
      deliveries: { totalTraces: 0, totalItems: 0, byPresentation: [], byTrigger: [], legacyUnknownRows: 0 },
      evidenceGrounding: { evaluatedDeliveries: 0, groundedDeliveries: 0, groundingRate: 0, averageContentOverlap: 0 },
      referenceNavigation: { eligibleTraces: 0, navigatedTraces: 0, navigationRate: 0, attributedOpenCount: 0, ambiguousOpenCount: 0, unattributedOpenCount: 0 }
    });
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

  it('GET /api/stats returns sanitized aggregate retrieval trace stats', async () => {
    mocks.service.getRetrievalTraceStats.mockResolvedValue({
      totalQueries: 1,
      avgCandidateCount: 2,
      avgSelectedCount: 1,
      selectionRate: 0.5,
      rewrittenQueries: 0,
      rewriteRate: 0,
      rewrittenQueriesWithSelection: 0,
      rawQueriesWithSelection: 1,
      rewrittenSelectionRate: 0,
      rawSelectionRate: 1,
      avgSelectedCountForRewrittenQueries: 0,
      avgSelectedCountForRawQueries: 1,
      rawQueryText: 'PRIVATE_ROOT_RAW_QUERY_SHOULD_NOT_LEAK',
      queryText: 'PRIVATE_ROOT_EFFECTIVE_QUERY_SHOULD_NOT_LEAK',
      strategyBreakdown: [
        {
          strategy: 'PRIVATE_ROOT_STRATEGY_LABEL_SHOULD_NOT_LEAK',
          totalQueries: 1,
          queriesWithSelection: 1,
          rewrittenQueries: 0,
          rewriteRate: 0,
          totalCandidateCount: 2,
          totalSelectedCount: 1,
          avgCandidateCount: 2,
          avgSelectedCount: 1,
          selectionRate: 0.5,
          queryYieldRate: 1,
          rawQueryText: 'PRIVATE_ROOT_STRATEGY_QUERY_SHOULD_NOT_LEAK',
          queryText: 'PRIVATE_ROOT_STRATEGY_EFFECTIVE_QUERY_SHOULD_NOT_LEAK'
        }
      ]
    });

    const res = await createApp().request('/api/stats?project=abc12345');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.retrievalTrace.strategyBreakdown).toEqual([
      expect.objectContaining({
        strategy: 'unknown',
        totalQueries: 1,
        totalCandidateCount: 2,
        totalSelectedCount: 1,
        selectionRate: 0.5,
        queryYieldRate: 1
      })
    ]);
    expect(body.retrievalTrace).not.toHaveProperty('rawQueryText');
    expect(body.retrievalTrace).not.toHaveProperty('queryText');
    expect(body.retrievalTrace.strategyBreakdown[0]).not.toHaveProperty('rawQueryText');
    expect(body.retrievalTrace.strategyBreakdown[0]).not.toHaveProperty('queryText');
    expect(JSON.stringify(body)).not.toContain('PRIVATE_ROOT_RAW_QUERY_SHOULD_NOT_LEAK');
    expect(JSON.stringify(body)).not.toContain('PRIVATE_ROOT_EFFECTIVE_QUERY_SHOULD_NOT_LEAK');
    expect(JSON.stringify(body)).not.toContain('PRIVATE_ROOT_STRATEGY_LABEL_SHOULD_NOT_LEAK');
    expect(JSON.stringify(body)).not.toContain('PRIVATE_ROOT_STRATEGY_QUERY_SHOULD_NOT_LEAK');
    expect(JSON.stringify(body)).not.toContain('PRIVATE_ROOT_STRATEGY_EFFECTIVE_QUERY_SHOULD_NOT_LEAK');
  });

  it('dashboard-read stats subroutes avoid full embedder-backed service initialization', async () => {
    const app = createApp();
    const paths = [
      '/api/stats/shared?project=abc12345',
      '/api/stats/endless?project=abc12345',
      '/api/stats/levels/L0?project=abc12345',
      '/api/stats/most-accessed?project=abc12345&limit=10',
      '/api/stats/helpfulness?project=abc12345&limit=5',
      '/api/stats/retrieval-telemetry?project=abc12345',
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

  it('GET /api/stats/retrieval-telemetry preserves source-specific denominators', async () => {
    const telemetry = {
      deliveries: {
        totalTraces: 4,
        totalItems: 7,
        byPresentation: [
          { presentationMode: 'evidence', traceCount: 2, deliveredItemCount: 4 },
          { presentationMode: 'reference', traceCount: 1, deliveredItemCount: 2 },
          { presentationMode: 'core', traceCount: 1, deliveredItemCount: 1 }
        ],
        byTrigger: [],
        legacyUnknownRows: 3
      },
      evidenceGrounding: { evaluatedDeliveries: 4, groundedDeliveries: 3, groundingRate: 0.75, averageContentOverlap: 0.42 },
      referenceNavigation: { eligibleTraces: 1, navigatedTraces: 1, navigationRate: 1, attributedOpenCount: 2, ambiguousOpenCount: 1, unattributedOpenCount: 0 }
    };
    mocks.service.getRetrievalTelemetryStats.mockResolvedValue(telemetry);

    const res = await createApp().request('/api/stats/retrieval-telemetry?project=abc12345');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(telemetry);
    expect(mocks.service.getRetrievalTelemetryStats).toHaveBeenCalledTimes(1);
    expect(mocks.getServiceFromQuery).not.toHaveBeenCalled();
  });

  it('GET /api/stats/kpi window-scopes its event fetch instead of a 20k scan', async () => {
    const res = await createApp().request('/api/stats/kpi?project=abc12345&window=7d');

    expect(res.status).toBe(200);
    expect(mocks.service.getEventsAfter).toHaveBeenCalledTimes(1);
    expect(mocks.service.getRecentEvents).not.toHaveBeenCalled();
    // The lookback cutoff is a past ISO timestamp (>= 30d for a 7d window).
    const cutoff = mocks.service.getEventsAfter.mock.calls[0][0];
    expect(typeof cutoff).toBe('string');
    expect(new Date(cutoff).getTime()).toBeLessThan(Date.now());
    expect(mocks.service.getHelpfulnessStats).toHaveBeenCalledTimes(2);
    const [currentSince, currentUntil] = mocks.service.getHelpfulnessStats.mock.calls[0];
    const [previousSince, previousUntil] = mocks.service.getHelpfulnessStats.mock.calls[1];
    expect(previousUntil.getTime()).toBe(currentSince.getTime());
    expect(currentUntil.getTime() - currentSince.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    expect(previousSince).toBeInstanceOf(Date);
  });

  it('GET /api/stats/kpi uses distinct helpfulness windows for current, previous, and daily trend', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T12:00:00.000Z'));
    try {
      mocks.service.getEventsAfter.mockResolvedValue([
        { id: 'p1', eventType: 'user_prompt', sessionId: 's1', timestamp: new Date('2026-05-08T10:00:00.000Z'), content: 'prompt', metadata: {} }
      ]);
      mocks.service.getHelpfulnessStats
        .mockResolvedValueOnce({ totalEvaluated: 2, helpful: 1 })
        .mockResolvedValueOnce({ totalEvaluated: 2, helpful: 2 });
      mocks.service.getHelpfulnessStatsByDay.mockResolvedValue([
        { date: '2026-05-08', totalEvaluated: 4, helpful: 3 }
      ]);

      const res = await createApp().request('/api/stats/kpi?project=abc12345&window=7d');
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.metrics.usefulRecallRate).toBe(0.5);
      expect(body.previousMetrics.usefulRecallRate).toBe(1);
      expect(body.deltas.usefulRecallRate).toBe(-0.5);
      expect(body.availability.usefulRecallRate).toEqual({
        currentEvaluated: 2,
        previousEvaluated: 2,
        currentAvailable: true,
        previousAvailable: true,
      });
      expect(body.trend.daily[0].usefulRecallRate).toBe(0.75);
      expect(mocks.service.getHelpfulnessStats).toHaveBeenCalledTimes(2);
      expect(mocks.service.getHelpfulnessStatsByDay).toHaveBeenCalledTimes(1);
      expect(mocks.service.getHelpfulnessStatsByDay).toHaveBeenCalledWith(
        new Date('2026-04-08T00:00:00.000Z'),
        new Date('2026-05-09T00:00:00.000Z')
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('GET /api/stats/kpi distinguishes missing recall evaluations from a measured zero', async () => {
    mocks.service.getEventsAfter.mockResolvedValue([
      { id: 'p1', eventType: 'user_prompt', sessionId: 's1', timestamp: new Date(), content: 'prompt', metadata: {} }
    ]);
    mocks.service.getHelpfulnessStats.mockResolvedValue({ totalEvaluated: 0, helpful: 0 });
    mocks.service.getHelpfulnessStatsByDay.mockResolvedValue([
      { date: new Date().toISOString().slice(0, 10), totalEvaluated: 0, helpful: 0 }
    ]);

    const res = await createApp().request('/api/stats/kpi?project=abc12345&window=7d');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.metrics.usefulRecallRate).toBe(0);
    expect(body.deltas.usefulRecallRate).toBeNull();
    expect(body.availability.usefulRecallRate.currentAvailable).toBe(false);
    expect(body.trend.daily[0].usefulRecallRate).toBeNull();
    expect(body.alerts.some((alert: any) => alert.metric === 'usefulRecallRate')).toBe(false);
  });
});
