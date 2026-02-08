/**
 * Turns API
 * Endpoints for viewing events grouped by conversation turn
 *
 * A "turn" groups a user_prompt with its associated tool_observations
 * and the final agent_response into a single logical unit.
 */

import { Hono } from 'hono';
import { getServiceFromQuery } from './utils.js';

export const turnsRouter = new Hono();

// GET /api/turns?sessionId=xxx - List turns for a session
turnsRouter.get('/', async (c) => {
  const sessionId = c.req.query('sessionId');
  const limit = parseInt(c.req.query('limit') || '20', 10);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  if (!sessionId) {
    return c.json({ error: 'sessionId is required' }, 400);
  }

  const memoryService = getServiceFromQuery(c);

  try {
    await memoryService.initialize();

    const turns = await memoryService.getSessionTurns(sessionId, { limit, offset });
    const totalTurns = await memoryService.countSessionTurns(sessionId);

    return c.json({
      turns: turns.map(t => ({
        turnId: t.turnId,
        startedAt: t.startedAt.toISOString(),
        promptPreview: t.promptPreview,
        eventCount: t.eventCount,
        toolCount: t.toolCount,
        hasResponse: t.hasResponse,
        events: t.events.map(e => ({
          id: e.id,
          eventType: e.eventType,
          timestamp: e.timestamp instanceof Date ? e.timestamp.toISOString() : e.timestamp,
          preview: e.content.slice(0, 300) + (e.content.length > 300 ? '...' : ''),
          contentLength: e.content.length
        }))
      })),
      total: totalTurns,
      limit,
      offset,
      hasMore: offset + limit < totalTurns
    });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  } finally {
    await memoryService.shutdown();
  }
});

// GET /api/turns/:turnId - Get full turn details
turnsRouter.get('/:turnId', async (c) => {
  const { turnId } = c.req.param();
  const memoryService = getServiceFromQuery(c);

  try {
    await memoryService.initialize();

    const events = await memoryService.getEventsByTurn(turnId);

    if (events.length === 0) {
      return c.json({ error: 'Turn not found' }, 404);
    }

    const promptEvent = events.find(e => e.eventType === 'user_prompt');
    const toolEvents = events.filter(e => e.eventType === 'tool_observation');
    const responseEvents = events.filter(e => e.eventType === 'agent_response');

    return c.json({
      turnId,
      sessionId: events[0].sessionId,
      startedAt: events[0].timestamp instanceof Date
        ? events[0].timestamp.toISOString()
        : events[0].timestamp,
      prompt: promptEvent ? {
        id: promptEvent.id,
        content: promptEvent.content,
        timestamp: promptEvent.timestamp instanceof Date
          ? promptEvent.timestamp.toISOString()
          : promptEvent.timestamp
      } : null,
      tools: toolEvents.map(e => {
        let toolName = '';
        let success = true;
        try {
          const parsed = JSON.parse(e.content);
          toolName = parsed.toolName || '';
          success = parsed.success !== false;
        } catch { /* ignore */ }

        return {
          id: e.id,
          toolName,
          success,
          timestamp: e.timestamp instanceof Date ? e.timestamp.toISOString() : e.timestamp,
          preview: e.content.slice(0, 500) + (e.content.length > 500 ? '...' : '')
        };
      }),
      responses: responseEvents.map(e => ({
        id: e.id,
        content: e.content,
        timestamp: e.timestamp instanceof Date ? e.timestamp.toISOString() : e.timestamp
      })),
      totalEvents: events.length
    });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  } finally {
    await memoryService.shutdown();
  }
});

// POST /api/turns/backfill - Backfill turn_ids from metadata
turnsRouter.post('/backfill', async (c) => {
  const memoryService = getServiceFromQuery(c);

  try {
    await memoryService.initialize();
    const updated = await memoryService.backfillTurnIds();

    return c.json({
      success: true,
      updated,
      message: `Backfilled turn_id for ${updated} events`
    });
  } catch (error) {
    return c.json({
      success: false,
      error: (error as Error).message
    }, 500);
  } finally {
    await memoryService.shutdown();
  }
});
