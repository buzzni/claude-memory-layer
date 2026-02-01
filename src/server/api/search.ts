/**
 * Search API
 * Endpoints for memory search
 */

import { Hono } from 'hono';
import { getDefaultMemoryService } from '../../services/memory-service.js';

export const searchRouter = new Hono();

interface SearchRequest {
  query: string;
  options?: {
    topK?: number;
    minScore?: number;
    sessionId?: string;
    eventType?: string;
  };
}

// POST /api/search - Search memories
searchRouter.post('/', async (c) => {
  try {
    const body = await c.req.json<SearchRequest>();

    if (!body.query) {
      return c.json({ error: 'Query is required' }, 400);
    }

    const memoryService = getDefaultMemoryService();
    await memoryService.initialize();

    const startTime = Date.now();

    const result = await memoryService.retrieveMemories(body.query, {
      topK: body.options?.topK ?? 10,
      minScore: body.options?.minScore ?? 0.7,
      sessionId: body.options?.sessionId
    });

    const searchTime = Date.now() - startTime;

    return c.json({
      results: result.memories.map(m => ({
        id: m.event.id,
        eventType: m.event.eventType,
        timestamp: m.event.timestamp,
        sessionId: m.event.sessionId,
        score: m.score,
        content: m.event.content,
        preview: m.event.content.slice(0, 200) + (m.event.content.length > 200 ? '...' : ''),
        context: m.sessionContext
      })),
      meta: {
        totalMatches: result.memories.length,
        searchTime,
        confidence: result.matchResult.confidence,
        totalTokens: result.totalTokens
      }
    });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  }
});

// GET /api/search - Simple search via query param
searchRouter.get('/', async (c) => {
  const query = c.req.query('q');

  if (!query) {
    return c.json({ error: 'Query parameter "q" is required' }, 400);
  }

  const topK = parseInt(c.req.query('topK') || '5', 10);

  try {
    const memoryService = getDefaultMemoryService();
    await memoryService.initialize();

    const result = await memoryService.retrieveMemories(query, { topK });

    return c.json({
      results: result.memories.map(m => ({
        id: m.event.id,
        eventType: m.event.eventType,
        timestamp: m.event.timestamp,
        score: m.score,
        preview: m.event.content.slice(0, 200) + (m.event.content.length > 200 ? '...' : '')
      })),
      meta: {
        totalMatches: result.memories.length,
        confidence: result.matchResult.confidence
      }
    });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  }
});
