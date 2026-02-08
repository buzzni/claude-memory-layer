/**
 * Sessions API
 * Endpoints for session management
 */

import { Hono } from 'hono';
import { getServiceFromQuery } from './utils.js';

export const sessionsRouter = new Hono();

// GET /api/sessions - List all sessions
sessionsRouter.get('/', async (c) => {
  const page = parseInt(c.req.query('page') || '1', 10);
  const pageSize = parseInt(c.req.query('pageSize') || '20', 10);
  const memoryService = getServiceFromQuery(c);

  try {
    await memoryService.initialize();

    // Get recent events and extract sessions
    const recentEvents = await memoryService.getRecentEvents(1000);

    // Group by session
    const sessionMap = new Map<string, {
      id: string;
      startedAt: Date;
      eventCount: number;
      lastEventAt: Date;
    }>();

    for (const event of recentEvents) {
      const existing = sessionMap.get(event.sessionId);
      if (!existing) {
        sessionMap.set(event.sessionId, {
          id: event.sessionId,
          startedAt: event.timestamp,
          eventCount: 1,
          lastEventAt: event.timestamp
        });
      } else {
        existing.eventCount++;
        if (event.timestamp < existing.startedAt) {
          existing.startedAt = event.timestamp;
        }
        if (event.timestamp > existing.lastEventAt) {
          existing.lastEventAt = event.timestamp;
        }
      }
    }

    const sessions = Array.from(sessionMap.values())
      .sort((a, b) => b.lastEventAt.getTime() - a.lastEventAt.getTime());

    const total = sessions.length;
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const paginatedSessions = sessions.slice(start, end);

    return c.json({
      sessions: paginatedSessions,
      total,
      page,
      pageSize,
      hasMore: end < total
    });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  } finally {
    await memoryService.shutdown();
  }
});

// GET /api/sessions/:id - Get session details
sessionsRouter.get('/:id', async (c) => {
  const { id } = c.req.param();
  const memoryService = getServiceFromQuery(c);

  try {
    await memoryService.initialize();

    const events = await memoryService.getSessionHistory(id);

    if (events.length === 0) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const session = {
      id,
      startedAt: events[0].timestamp,
      endedAt: events[events.length - 1].timestamp,
      eventCount: events.length
    };

    const eventsByType = {
      user_prompt: events.filter(e => e.eventType === 'user_prompt').length,
      agent_response: events.filter(e => e.eventType === 'agent_response').length,
      tool_observation: events.filter(e => e.eventType === 'tool_observation').length
    };

    return c.json({
      session,
      events: events.slice(0, 100).map(e => ({
        id: e.id,
        eventType: e.eventType,
        timestamp: e.timestamp,
        preview: e.content.slice(0, 200) + (e.content.length > 200 ? '...' : '')
      })),
      stats: eventsByType
    });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  } finally {
    await memoryService.shutdown();
  }
});
