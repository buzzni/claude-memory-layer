import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vm from 'node:vm';

const mocks = vi.hoisted(() => {
  const service = {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    getRecentEvents: vi.fn(),
    getHelpfulnessStats: vi.fn(),
    getRecentRetrievalTraces: vi.fn(),
  };

  return {
    service,
    getServiceFromQuery: vi.fn(() => service),
    getLightweightServiceFromQuery: vi.fn(() => service),
  };
});

vi.mock('../../src/apps/server/api/utils.js', () => ({
  getServiceFromQuery: mocks.getServiceFromQuery,
  getLightweightServiceFromQuery: mocks.getLightweightServiceFromQuery,
}));

vi.mock('../../src/services/memory-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/memory-service.js')>();
  return {
    ...actual,
    getMemoryServiceForProject: vi.fn(() => mocks.service),
  };
});

const { statsRouter } = await import('../../src/server/api/stats.js');

function createApp() {
  const app = new Hono();
  app.route('/api/stats', statsRouter);
  return app;
}

function event(id: string, eventType: string, timestamp: string, metadata: Record<string, unknown> = {}) {
  return {
    id,
    eventType,
    sessionId: `session-${id}`,
    timestamp: new Date(timestamp),
    content: `${eventType} ${id}`,
    metadata,
  };
}

class TestElement {
  innerHTML = '';
  textContent = '';
  className = '';
  style: Record<string, string> = {};
  classList = { add() {}, remove() {}, toggle() {} };
}

function loadOverviewWithElements(elements: Record<string, TestElement>) {
  const dashboardDir = join(process.cwd(), 'src/apps/dashboard/assets/js');
  const source = ['state.js', 'views.js', 'overview.js']
    .map(file => readFileSync(join(dashboardDir, file), 'utf-8'))
    .join('\n');
  const context = {
    console,
    URL,
    ApexCharts: function () { return { render() {}, destroy() {} }; },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    window: { location: { origin: 'http://localhost:37777' } },
    document: {
      addEventListener() {},
      getElementById(id: string) { return elements[id] ?? null; },
      querySelectorAll() { return []; },
      querySelector() { return null; },
    },
  };

  vm.runInNewContext(
    `${source}\n;globalThis.__dashboardTestHooks = { state, updateMemoryUsefulnessUI };`,
    context
  );
  return (context as unknown as { __dashboardTestHooks: {
    state: Record<string, any>;
    updateMemoryUsefulnessUI: () => void;
  }}).__dashboardTestHooks;
}

describe('dashboard memory usefulness stats', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T12:00:00.000Z'));
    mocks.service.initialize.mockReset().mockResolvedValue(undefined);
    mocks.service.shutdown.mockReset().mockResolvedValue(undefined);
    mocks.service.getRecentEvents.mockReset().mockResolvedValue([
      event('p1', 'user_prompt', '2026-05-08T10:00:00.000Z', { adherence: { checked: true, reason: 'memory_context' } }),
      event('p2', 'user_prompt', '2026-05-08T11:00:00.000Z', { adherence: { checked: false, reason: 'simple_task' } }),
      event('p3', 'user_prompt', '2026-05-07T11:00:00.000Z'),
      event('old', 'user_prompt', '2026-04-01T00:00:00.000Z', { adherence: { checked: true } }),
    ]);
    mocks.service.getHelpfulnessStats.mockReset().mockResolvedValue({
      avgScore: 0.8,
      totalEvaluated: 4,
      totalRetrievals: 5,
      helpful: 3,
      neutral: 1,
      unhelpful: 0,
    });
    mocks.service.getRecentRetrievalTraces.mockReset().mockResolvedValue([
      {
        traceId: 't1',
        rawQueryText: '응 다음 단계 진행',
        queryText: 'Previous user: implement retrieval\nCurrent user: 응 다음 단계 진행',
        queryRewriteKind: 'follow-up-context',
        candidateCount: 5,
        selectedCount: 2,
        candidateEventIds: [],
        selectedEventIds: [],
        candidateDetails: [],
        selectedDetails: [],
        fallbackTrace: [],
        createdAt: new Date('2026-05-08T10:10:00.000Z')
      },
      {
        traceId: 't2',
        rawQueryText: 'self contained query',
        queryText: 'self contained query',
        queryRewriteKind: 'none',
        candidateCount: 3,
        selectedCount: 0,
        candidateEventIds: [],
        selectedEventIds: [],
        candidateDetails: [],
        selectedDetails: [],
        fallbackTrace: [],
        createdAt: new Date('2026-05-07T10:10:00.000Z')
      },
      { traceId: 'old-trace', rawQueryText: 'old', queryText: 'old', queryRewriteKind: 'none', candidateCount: 10, selectedCount: 10, candidateEventIds: [], selectedEventIds: [], candidateDetails: [], selectedDetails: [], fallbackTrace: [], createdAt: new Date('2026-04-01T00:00:00.000Z') },
    ]);
    mocks.getServiceFromQuery.mockClear();
    mocks.getLightweightServiceFromQuery.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a numeric usefulness summary from helpfulness, adherence, and retrieval traces', async () => {
    const res = await createApp().request('/api/stats/usefulness?window=7d&project=abc12345');

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.window).toBe('7d');
    expect(body.score).toEqual({ value: 64.4, label: 'good', confidence: 1 });
    expect(body.generatedAt).toBe('2026-05-08T12:00:00.000Z');
    expect(body.metrics).toMatchObject({
      avgHelpfulnessScore: 0.8,
      usefulRecallRate: 0.75,
      memoryHitRate: 0.3333,
      retrievalUsageRate: 0.6667,
      queryYieldRate: 0.5,
      evaluationCoverage: 0.8,
      retrievalsPerPrompt: 0.6667,
      avgCandidatesPerQuery: 4,
      avgSelectedPerQuery: 1,
      selectionRate: 0.25,
      queryRewriteRate: 0.5,
      rewrittenQueryYieldRate: 1,
      rawQueryYieldRate: 0,
      avgSelectedPerRewrittenQuery: 2,
      avgSelectedPerRawQuery: 0,
    });
    expect(body.counts).toMatchObject({
      promptCount: 3,
      memoryCheckedPrompts: 1,
      retrievalQueries: 2,
      queriesWithSelected: 1,
      rewrittenQueries: 1,
      rawQueries: 1,
      rewrittenQueriesWithSelected: 1,
      rawQueriesWithSelected: 0,
      helpful: 3,
      neutral: 1,
      unhelpful: 0,
      totalEvaluated: 4,
      totalRetrievals: 5,
    });
    expect(body.components.map((c: any) => c.key)).toEqual([
      'avgHelpfulnessScore',
      'usefulRecallRate',
      'memoryHitRate',
      'retrievalUsageRate',
      'queryYieldRate',
    ]);
    expect(body.diagnostics.map((d: any) => d.key)).toEqual([
      'low-memory-hit-rate',
      'low-query-yield-rate',
    ]);
    expect(body.diagnostics[0]).toMatchObject({
      severity: 'warn',
      metric: 'memoryHitRate',
      value: 0.3333,
      target: 0.5,
    });
    expect(body.diagnostics[0].detail).toContain('1 of 3 prompts');
    expect(body.diagnostics[0].action).toContain('adherence triggers');
    expect(body.limits).toEqual({
      eventsLimit: 20000,
      tracesLimit: 5000,
      eventWindowTruncated: false,
      traceWindowTruncated: false,
    });
    expect(JSON.stringify(body)).not.toContain('user_prompt p1');
    expect(JSON.stringify(body)).not.toContain('Previous user: implement retrieval');
    expect(JSON.stringify(body)).not.toContain('응 다음 단계 진행');
    expect(JSON.stringify(body)).not.toContain('self contained query');
    expect(mocks.service.getHelpfulnessStats).toHaveBeenCalledWith(new Date('2026-05-01T12:00:00.000Z'));
    expect(mocks.getLightweightServiceFromQuery).toHaveBeenCalledTimes(1);
    expect(mocks.getServiceFromQuery).not.toHaveBeenCalled();
    expect(mocks.service.shutdown).toHaveBeenCalledTimes(1);
  });

  it('distinguishes no telemetry from available telemetry with a zero score', async () => {
    mocks.service.getHelpfulnessStats.mockResolvedValue({
      avgScore: 0,
      totalEvaluated: 0,
      totalRetrievals: 0,
      helpful: 0,
      neutral: 0,
      unhelpful: 0,
    });

    mocks.service.getRecentEvents.mockResolvedValue([event('p-zero', 'user_prompt', '2026-05-08T10:00:00.000Z')]);
    mocks.service.getRecentRetrievalTraces.mockResolvedValue([]);
    const zeroRes = await createApp().request('/api/stats/usefulness?window=24h');
    const zeroBody = await zeroRes.json();
    expect(zeroBody.score).toEqual({ value: 0, label: 'low', confidence: 0.35 });

    mocks.service.getRecentEvents.mockResolvedValue([]);
    mocks.service.getRecentRetrievalTraces.mockResolvedValue([]);
    const emptyRes = await createApp().request('/api/stats/usefulness?window=24h');
    const emptyBody = await emptyRes.json();
    expect(emptyBody.score).toEqual({ value: 0, label: 'unknown', confidence: 0 });
  });

  it('returns a generic error when usefulness calculation fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.service.getRecentEvents.mockRejectedValue(new Error('/Users/example/private-store failed'));

    const res = await createApp().request('/api/stats/usefulness?window=7d');
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'Unable to calculate memory usefulness statistics' });
    expect(JSON.stringify(body)).not.toContain('/Users/example/private-store');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('renders the usefulness score and component percentages in the overview dashboard', () => {
    const elements = {
      'memory-usefulness-score': new TestElement(),
      'memory-usefulness-summary': new TestElement(),
      'memory-usefulness-breakdown': new TestElement(),
      'memory-usefulness-diagnostics': new TestElement(),
    };
    const hooks = loadOverviewWithElements(elements);

    hooks.state.memoryUsefulness = {
      score: { value: 64.4, label: 'good', confidence: 1 },
      metrics: { usefulRecallRate: 0.75, memoryHitRate: 0.3333, retrievalUsageRate: 0.6667, queryYieldRate: 0.5 },
      counts: { retrievalQueries: 2, promptCount: 3, totalEvaluated: 4, rewrittenQueries: 1, rewrittenQueriesWithSelected: 1 },
      components: [
        { key: 'usefulRecallRate', label: 'Useful recall rate', value: 0.75, available: true },
        { key: 'memoryHitRate', label: 'Memory hit rate', value: 0.3333, available: true },
        { key: 'retrievalUsageRate', label: 'Retrieval usage rate', value: 0.6667, available: true },
      ],
      diagnostics: [
        {
          key: 'low-memory-hit-rate',
          severity: 'warn',
          title: 'Memory checks are missing many prompts',
          detail: 'Only 1 of 3 prompts had an adherence check in this window.',
          action: 'Broaden adherence triggers for continuation, write-intent, and project-specific prompts.',
        },
      ],
    };

    hooks.updateMemoryUsefulnessUI();

    expect(elements['memory-usefulness-score'].textContent).toBe('64.4');
    expect(elements['memory-usefulness-summary'].innerHTML).toContain('good');
    expect(elements['memory-usefulness-summary'].innerHTML).toContain('<strong>2</strong> queries');
    expect(elements['memory-usefulness-summary'].innerHTML).toContain('<strong>1</strong> rewritten');
    expect(elements['memory-usefulness-summary'].innerHTML).toContain('<strong>3</strong> prompts');
    expect(elements['memory-usefulness-breakdown'].innerHTML).toContain('Useful recall rate');
    expect(elements['memory-usefulness-breakdown'].innerHTML).toContain('75.0%');
    expect(elements['memory-usefulness-diagnostics'].innerHTML).toContain('Top improvement actions');
    expect(elements['memory-usefulness-diagnostics'].innerHTML).toContain('Memory checks are missing many prompts');
    expect(elements['memory-usefulness-diagnostics'].innerHTML).toContain('Broaden adherence triggers');
  });
});
