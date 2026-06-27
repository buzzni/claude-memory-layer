/**
 * Search API
 * Endpoints for memory search
 */

import { Hono } from 'hono';
import { getLightweightServiceFromQuery, getServiceFromQuery, jsonError } from './utils.js';

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

interface DisclosureSearchRequest {
  query: string;
  options?: {
    topK?: number;
    minScore?: number;
    sessionId?: string;
    includeShared?: boolean;
    adaptiveRerank?: boolean;
    intentRewrite?: boolean;
    projectScopeMode?: 'strict' | 'prefer' | 'global';
    allowedProjectHashes?: string[];
    strategy?: 'auto' | 'fast' | 'deep';
  };
}

function isEmbeddingBackendUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /model file path or buffer|onnxruntime|transformers|embedding backend/i.test(message);
}

// POST /api/search - Search memories
searchRouter.post('/', async (c) => {
  const memoryService = getServiceFromQuery(c);
  try {
    const body = await c.req.json<SearchRequest>();

    if (!body.query) {
      return c.json({ error: 'Query is required' }, 400);
    }

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
    return jsonError(c, error);
  } finally {
    await memoryService.shutdown();
  }
});

// POST /api/search/disclosure - Progressive disclosure search (Search layer)
searchRouter.post('/disclosure', async (c) => {
  let memoryService: ReturnType<typeof getServiceFromQuery> | undefined;
  let body: DisclosureSearchRequest;
  try {
    body = await c.req.json<DisclosureSearchRequest>();

    if (!body.query) {
      return c.json({ error: 'Query is required' }, 400);
    }

    const useFastStrategy = body.options?.strategy === 'fast';
    memoryService = useFastStrategy
      ? getLightweightServiceFromQuery(c)
      : getServiceFromQuery(c);

    try {
      await memoryService.initialize();
      const result = await memoryService.searchDisclosure(body.query, body.options);
      return c.json(result);
    } catch (error) {
      if (!useFastStrategy && isEmbeddingBackendUnavailable(error)) {
        await memoryService.shutdown();
        memoryService = getLightweightServiceFromQuery(c);
        await memoryService.initialize();
        const result = await memoryService.searchDisclosure(body.query, {
          ...body.options,
          strategy: 'fast'
        });
        return c.json({
          ...result,
          meta: {
            ...result.meta,
            fallbackApplied: true,
            fallbackTrace: [
              ...(result.meta.fallbackTrace || []),
              'fallback:embedding-backend-unavailable:fast'
            ]
          }
        });
      }
      throw error;
    }
  } catch (error) {
    return jsonError(c, error);
  } finally {
    await memoryService?.shutdown();
  }
});

// GET /api/search/disclosure/:resultId/expand - Expand a disclosure search result
searchRouter.get('/disclosure/:resultId/expand', async (c) => {
  const memoryService = getLightweightServiceFromQuery(c);
  try {
    const resultId = c.req.param('resultId');
    const rawWindowSize = c.req.query('windowSize');
    const windowSize = rawWindowSize ? parseInt(rawWindowSize, 10) : undefined;
    const result = await memoryService.expandDisclosure(
      resultId,
      Number.isFinite(windowSize) ? { windowSize } : undefined
    );

    if (!result) {
      return c.json({ error: 'Expansion target not found' }, 404);
    }

    return c.json(result);
  } catch (error) {
    return jsonError(c, error);
  } finally {
    await memoryService.shutdown();
  }
});

// GET /api/search/disclosure/:resultId/source - Resolve source for a disclosure search result
searchRouter.get('/disclosure/:resultId/source', async (c) => {
  const memoryService = getLightweightServiceFromQuery(c);
  try {
    const resultId = c.req.param('resultId');
    const result = await memoryService.sourceDisclosure(resultId);

    if (!result) {
      return c.json({ error: 'Source not found' }, 404);
    }

    return c.json(result);
  } catch (error) {
    return jsonError(c, error);
  } finally {
    await memoryService.shutdown();
  }
});

// GET /api/search - Simple search via query param
searchRouter.get('/', async (c) => {
  const query = c.req.query('q');

  if (!query) {
    return c.json({ error: 'Query parameter "q" is required' }, 400);
  }

  const topK = parseInt(c.req.query('topK') || '5', 10);
  const memoryService = getServiceFromQuery(c);

  try {
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
    return jsonError(c, error);
  } finally {
    await memoryService.shutdown();
  }
});
