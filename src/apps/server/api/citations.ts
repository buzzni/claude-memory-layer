/**
 * Citations API
 * Endpoints for citation management
 */

import { Hono } from 'hono';
import { getServiceFromQuery, jsonError } from './utils.js';
import { generateCitationId, parseCitationId } from '../../../core/citation-generator.js';

export const citationsRouter = new Hono();

// GET /api/citations/:id - Get citation by ID
citationsRouter.get('/:id', async (c) => {
  const { id } = c.req.param();

  // Support both formats: "a7Bc3x" or "mem:a7Bc3x"
  const citationId = parseCitationId(id) || id;
  const memoryService = getServiceFromQuery(c);

  try {
    await memoryService.initialize();

    // Indexed reverse lookup instead of scanning the 10k most-recent events and
    // hashing each id (which also missed citations older than that window).
    const event = await memoryService.getEventByCitationId(citationId);

    if (!event) {
      return c.json({ error: 'Citation not found' }, 404);
    }

    return c.json({
      citation: {
        id: citationId,
        eventId: event.id
      },
      event: {
        id: event.id,
        eventType: event.eventType,
        timestamp: event.timestamp,
        sessionId: event.sessionId,
        content: event.content,
        metadata: event.metadata
      }
    });
  } catch (error) {
    return jsonError(c, error);
  } finally {
    await memoryService.shutdown();
  }
});

// GET /api/citations/:id/related - Get related citations
citationsRouter.get('/:id/related', async (c) => {
  const { id } = c.req.param();
  const citationId = parseCitationId(id) || id;
  const memoryService = getServiceFromQuery(c);

  try {
    await memoryService.initialize();

    // Indexed reverse lookup for the main event, then session-scoped neighbours.
    const event = await memoryService.getEventByCitationId(citationId);

    if (!event) {
      return c.json({ error: 'Citation not found' }, 404);
    }

    // Get surrounding events from same session
    const sessionEvents = (await memoryService.getSessionHistory(event.sessionId))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const eventIndex = sessionEvents.findIndex(e => e.id === event.id);
    const prev = eventIndex > 0 ? sessionEvents[eventIndex - 1] : null;
    const next = eventIndex < sessionEvents.length - 1 ? sessionEvents[eventIndex + 1] : null;

    return c.json({
      previous: prev ? {
        citationId: generateCitationId(prev.id),
        eventType: prev.eventType,
        timestamp: prev.timestamp,
        preview: prev.content.slice(0, 100) + (prev.content.length > 100 ? '...' : '')
      } : null,
      next: next ? {
        citationId: generateCitationId(next.id),
        eventType: next.eventType,
        timestamp: next.timestamp,
        preview: next.content.slice(0, 100) + (next.content.length > 100 ? '...' : '')
      } : null
    });
  } catch (error) {
    return jsonError(c, error);
  } finally {
    await memoryService.shutdown();
  }
});
