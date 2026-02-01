/**
 * Events API
 * Endpoints for event management
 */

import { Hono } from 'hono';
import { getDefaultMemoryService } from '../../services/memory-service.js';

export const eventsRouter = new Hono();

// GET /api/events - List events with filters
eventsRouter.get('/', async (c) => {
  const sessionId = c.req.query('sessionId');
  const eventType = c.req.query('type');
  const limit = parseInt(c.req.query('limit') || '100', 10);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  try {
    const memoryService = getDefaultMemoryService();
    await memoryService.initialize();

    let events = await memoryService.getRecentEvents(limit + offset + 1000);

    // Filter by session
    if (sessionId) {
      events = events.filter(e => e.sessionId === sessionId);
    }

    // Filter by type
    if (eventType) {
      events = events.filter(e => e.eventType === eventType);
    }

    // Pagination
    const total = events.length;
    events = events.slice(offset, offset + limit);

    return c.json({
      events: events.map(e => ({
        id: e.id,
        eventType: e.eventType,
        timestamp: e.timestamp,
        sessionId: e.sessionId,
        preview: e.content.slice(0, 200) + (e.content.length > 200 ? '...' : ''),
        contentLength: e.content.length
      })),
      total,
      limit,
      offset,
      hasMore: offset + limit < total
    });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  }
});

// GET /api/events/:id - Get event details
eventsRouter.get('/:id', async (c) => {
  const { id } = c.req.param();

  try {
    const memoryService = getDefaultMemoryService();
    await memoryService.initialize();

    const recentEvents = await memoryService.getRecentEvents(10000);
    const event = recentEvents.find(e => e.id === id);

    if (!event) {
      return c.json({ error: 'Event not found' }, 404);
    }

    // Get surrounding events for context
    const sessionEvents = recentEvents
      .filter(e => e.sessionId === event.sessionId)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const eventIndex = sessionEvents.findIndex(e => e.id === id);
    const start = Math.max(0, eventIndex - 2);
    const end = Math.min(sessionEvents.length, eventIndex + 3);
    const context = sessionEvents.slice(start, end).filter(e => e.id !== id);

    return c.json({
      event: {
        id: event.id,
        eventType: event.eventType,
        timestamp: event.timestamp,
        sessionId: event.sessionId,
        content: event.content,
        metadata: event.metadata
      },
      context: context.map(e => ({
        id: e.id,
        eventType: e.eventType,
        timestamp: e.timestamp,
        preview: e.content.slice(0, 100) + (e.content.length > 100 ? '...' : '')
      }))
    });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  }
});
