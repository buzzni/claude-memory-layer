import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => {
  const service = {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    getEvent: vi.fn(),
    getRecentEvents: vi.fn(),
    getSessionHistory: vi.fn(),
    getSessionTurns: vi.fn(),
    countSessionTurns: vi.fn(),
    getEventsByTurn: vi.fn(),
  };

  return {
    service,
    getServiceFromQuery: vi.fn(() => {
      throw new Error('full service should not be initialized for dashboard read endpoints');
    }),
    getLightweightServiceFromQuery: vi.fn(() => service),
  };
});

vi.mock('../../src/apps/server/api/utils.js', () => ({
  getServiceFromQuery: mocks.getServiceFromQuery,
  getLightweightServiceFromQuery: mocks.getLightweightServiceFromQuery,
}));

const { eventsRouter } = await import('../../src/server/api/events.js');
const { sessionsRouter } = await import('../../src/server/api/sessions.js');
const { turnsRouter } = await import('../../src/server/api/turns.js');

function createApp() {
  const app = new Hono();
  app.route('/api/events', eventsRouter);
  app.route('/api/sessions', sessionsRouter);
  app.route('/api/turns', turnsRouter);
  return app;
}

const fixtureEvents = [
  {
    id: 'e1',
    eventType: 'user_prompt',
    sessionId: 's1',
    timestamp: new Date('2026-05-01T00:00:00.000Z'),
    content: 'legacy dashboard prompt about query rewrite stats',
    metadata: { level: 'L1' },
  },
  {
    id: 'e2',
    eventType: 'agent_response',
    sessionId: 's1',
    timestamp: new Date('2026-05-01T00:01:00.000Z'),
    content: 'legacy dashboard response',
    metadata: { level: 'L1' },
  },
];

describe('dashboard read APIs use lightweight services', () => {
  beforeEach(() => {
    mocks.service.initialize.mockReset().mockResolvedValue(undefined);
    mocks.service.shutdown.mockReset().mockResolvedValue(undefined);
    mocks.service.getEvent.mockReset().mockImplementation(async (id: string) => fixtureEvents.find((e) => e.id === id) ?? null);
    mocks.service.getRecentEvents.mockReset().mockResolvedValue(fixtureEvents);
    mocks.service.getSessionHistory.mockReset().mockResolvedValue(fixtureEvents);
    mocks.service.getSessionTurns.mockReset().mockResolvedValue([
      {
        turnId: 'turn-1',
        startedAt: new Date('2026-05-01T00:00:00.000Z'),
        promptPreview: 'legacy dashboard prompt about query rewrite stats',
        eventCount: 2,
        toolCount: 0,
        hasResponse: true,
        events: fixtureEvents,
      },
    ]);
    mocks.service.countSessionTurns.mockReset().mockResolvedValue(1);
    mocks.service.getEventsByTurn.mockReset().mockResolvedValue(fixtureEvents);
    mocks.getServiceFromQuery.mockClear();
    mocks.getLightweightServiceFromQuery.mockClear();
  });

  it('GET /api/events uses lightweight read service instead of full vector/embedder service', async () => {
    const res = await createApp().request('/api/events?project=abc12345&limit=5');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.events).toHaveLength(2);
    expect(mocks.getLightweightServiceFromQuery).toHaveBeenCalledTimes(1);
    expect(mocks.getServiceFromQuery).not.toHaveBeenCalled();
    expect(mocks.service.initialize).toHaveBeenCalledTimes(1);
    expect(mocks.service.shutdown).toHaveBeenCalledTimes(1);
  });

  it('GET /api/events/:id resolves the event by indexed id lookup, not a full scan', async () => {
    const res = await createApp().request('/api/events/e1?project=abc12345');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.event).toMatchObject({ id: 'e1', sessionId: 's1' });
    // Surrounding context comes from the same session and excludes the target.
    expect(body.context.map((e: { id: string }) => e.id)).toEqual(['e2']);
    // Indexed lookup + session-scoped context — never the 10k getRecentEvents scan.
    expect(mocks.service.getEvent).toHaveBeenCalledWith('e1');
    expect(mocks.service.getSessionHistory).toHaveBeenCalledWith('s1');
    expect(mocks.service.getRecentEvents).not.toHaveBeenCalled();
  });

  it('GET /api/events/:id returns 404 for an unknown id without scanning', async () => {
    const res = await createApp().request('/api/events/missing?project=abc12345');

    expect(res.status).toBe(404);
    expect(mocks.service.getRecentEvents).not.toHaveBeenCalled();
  });

  it('GET /api/sessions uses lightweight read service instead of full vector/embedder service', async () => {
    const res = await createApp().request('/api/sessions?project=abc12345&pageSize=5');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.sessions[0]).toMatchObject({ id: 's1', eventCount: 2 });
    expect(mocks.getLightweightServiceFromQuery).toHaveBeenCalledTimes(1);
    expect(mocks.getServiceFromQuery).not.toHaveBeenCalled();
    expect(mocks.service.initialize).toHaveBeenCalledTimes(1);
    expect(mocks.service.shutdown).toHaveBeenCalledTimes(1);
  });

  it('GET /api/sessions returns human-readable previews and aggregate counts for the session inspector', async () => {
    mocks.service.getRecentEvents.mockResolvedValueOnce([
      {
        id: 'tool-private',
        eventType: 'tool_observation',
        sessionId: 's-ux',
        timestamp: new Date('2026-05-01T00:02:00.000Z'),
        content: 'PRIVATE_TOOL_OUTPUT_SHOULD_NOT_BECOME_TITLE',
        metadata: { level: 'L0' },
      },
      {
        id: 'prompt-1',
        eventType: 'user_prompt',
        sessionId: 's-ux',
        timestamp: new Date('2026-05-01T00:00:00.000Z'),
        content: 'Improve the memory dashboard project scope and session inspector UX',
        metadata: { source: 'hermes', level: 'L1' },
      },
      {
        id: 'agent-1',
        eventType: 'agent_response',
        sessionId: 's-ux',
        timestamp: new Date('2026-05-01T00:03:00.000Z'),
        content: 'Implemented the requested dashboard changes.',
        metadata: { level: 'L2' },
      },
    ]);

    const res = await createApp().request('/api/sessions?project=abc12345&pageSize=5');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessions[0]).toMatchObject({
      id: 's-ux',
      eventCount: 3,
      promptPreview: 'Improve the memory dashboard project scope and session inspector UX',
      firstUserPromptAt: '2026-05-01T00:00:00.000Z',
      toolCount: 1,
      responseCount: 1,
      source: 'hermes',
    });
    expect(body.sessions[0].eventTypeCounts).toMatchObject({
      user_prompt: 1,
      tool_observation: 1,
      agent_response: 1,
    });
    expect(JSON.stringify(body.sessions[0])).not.toContain('PRIVATE_TOOL_OUTPUT_SHOULD_NOT_BECOME_TITLE');
  });

  it('GET /api/sessions/:id uses lightweight read service for session details', async () => {
    const res = await createApp().request('/api/sessions/s1?project=abc12345');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session).toMatchObject({ id: 's1', eventCount: 2 });
    expect(body.events).toHaveLength(2);
    expect(mocks.getLightweightServiceFromQuery).toHaveBeenCalledTimes(1);
    expect(mocks.getServiceFromQuery).not.toHaveBeenCalled();
    expect(mocks.service.getSessionHistory).toHaveBeenCalledWith('s1');
    expect(mocks.service.shutdown).toHaveBeenCalledTimes(1);
  });

  it('GET /api/turns uses lightweight read service for session turns', async () => {
    const res = await createApp().request('/api/turns?project=abc12345&sessionId=s1&limit=5');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.turns[0]).toMatchObject({ turnId: 'turn-1', eventCount: 2 });
    expect(mocks.getLightweightServiceFromQuery).toHaveBeenCalledTimes(1);
    expect(mocks.getServiceFromQuery).not.toHaveBeenCalled();
    expect(mocks.service.getSessionTurns).toHaveBeenCalledWith('s1', { limit: 5, offset: 0 });
    expect(mocks.service.countSessionTurns).toHaveBeenCalledWith('s1');
    expect(mocks.service.shutdown).toHaveBeenCalledTimes(1);
  });

  it('GET /api/turns/:turnId uses lightweight read service for turn details', async () => {
    const res = await createApp().request('/api/turns/turn-1?project=abc12345');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.turnId).toBe('turn-1');
    expect(body.totalEvents).toBe(2);
    expect(mocks.getLightweightServiceFromQuery).toHaveBeenCalledTimes(1);
    expect(mocks.getServiceFromQuery).not.toHaveBeenCalled();
    expect(mocks.service.getEventsByTurn).toHaveBeenCalledWith('turn-1');
    expect(mocks.service.shutdown).toHaveBeenCalledTimes(1);
  });
});
