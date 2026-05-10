import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => {
  const service = {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    getRecentEvents: vi.fn(),
    getSessionHistory: vi.fn(),
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

function createApp() {
  const app = new Hono();
  app.route('/api/events', eventsRouter);
  app.route('/api/sessions', sessionsRouter);
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
    mocks.service.getRecentEvents.mockReset().mockResolvedValue(fixtureEvents);
    mocks.service.getSessionHistory.mockReset().mockResolvedValue(fixtureEvents);
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
});
