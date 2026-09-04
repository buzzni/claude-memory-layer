/**
 * Events API
 * Endpoints for event management
 */

import { Hono } from 'hono';
import path from 'path';
import { getDiagnosticsServiceFromQuery, getWritableEventStoreFromQuery, jsonError } from './utils.js';
import { VectorStore } from '../../../core/vector-store.js';

export const eventsRouter = new Hono();

// GET /api/events - List events with filters
eventsRouter.get('/', async (c) => {
  const sessionId = c.req.query('sessionId');
  const eventType = c.req.query('type');
  const level = c.req.query('level');
  const sort = c.req.query('sort') || 'recent'; // recent | accessed | oldest
  const q = (c.req.query('q') || '').trim().toLowerCase();
  const limit = parseInt(c.req.query('limit') || '100', 10);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  const memoryService = getDiagnosticsServiceFromQuery(c);

  try {
    await memoryService.initialize();

    let events: any[];

    // Filter by level using the dedicated method
    if (level) {
      events = await memoryService.getEventsByLevel(level, { limit: limit + offset + 1000, offset: 0 });
    } else {
      events = await memoryService.getRecentEvents(limit + offset + 1000);
    }

    // Filter by session
    if (sessionId) {
      events = events.filter(e => e.sessionId === sessionId);
    }

    // Filter by type
    if (eventType) {
      events = events.filter(e => e.eventType === eventType);
    }

    // Content query filter
    if (q) {
      events = events.filter(e => (e.content || '').toLowerCase().includes(q));
    }

    // Sort
    if (sort === 'accessed') {
      events.sort((a: any, b: any) => {
        const aTime = a.last_accessed_at || '';
        const bTime = b.last_accessed_at || '';
        return bTime.localeCompare(aTime);
      });
    } else if (sort === 'most-accessed') {
      events.sort((a: any, b: any) => (b.access_count || 0) - (a.access_count || 0));
    } else if (sort === 'oldest') {
      events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    }
    // 'recent' is default (already sorted by timestamp DESC from the query)

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
        contentLength: e.content.length,
        metadata: e.metadata,
        accessCount: (e as any).access_count || 0,
        lastAccessedAt: (e as any).last_accessed_at || null
      })),
      total,
      limit,
      offset,
      hasMore: offset + limit < total
    });
  } catch (error) {
    return jsonError(c, error);
  } finally {
    await memoryService.shutdown();
  }
});

// GET /api/events/:id - Get event details
eventsRouter.get('/:id', async (c) => {
  const { id } = c.req.param();
  const memoryService = getDiagnosticsServiceFromQuery(c);

  try {
    await memoryService.initialize();

    // Indexed single-event lookup instead of scanning the 10k most-recent events
    // (which also silently 404'd any event older than that window).
    const event = await memoryService.getEvent(id);

    if (!event) {
      return c.json({ error: 'Event not found' }, 404);
    }

    // Get surrounding events for context, scoped to this event's session rather
    // than a global scan.
    const sessionEvents = (await memoryService.getSessionHistory(event.sessionId))
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
    return jsonError(c, error);
  } finally {
    await memoryService.shutdown();
  }
});

// DELETE /api/events/:id - Delete a single event
//
// 열람만 가능하던 대시보드에서 잘못 쌓인 기억을 실제로 지울 수 있게 한다. 기억은 이후
// 세션에 다시 주입되므로, 사후 정리 수단이 없으면 한 번 잘못 들어간 내용이 영구히 인용된다.
//
// 되돌릴 수 없다. 그래서 지우기 전에 무엇을 지웠는지 응답에 담아 호출자가 최소한 무엇을
// 잃었는지 알 수 있게 한다.
eventsRouter.delete('/:id', async (c) => {
  const { id } = c.req.param();
  const resolved = getWritableEventStoreFromQuery(c);
  // 저장소가 아직 없으면 지울 것도 없다 — delete 의 부수 효과로 DB 를 만들지 않는다.
  if (!resolved) return c.json({ error: 'Event not found' }, 404);

  const { store, storagePath } = resolved;
  try {
    await store.initialize();

    const event = await store.getEvent(id);
    if (!event) return c.json({ error: 'Event not found' }, 404);

    const deleted = await store.deleteEventById(id);
    if (!deleted) return c.json({ error: 'Event not found' }, 404);

    // 벡터는 LanceDB 에 따로 있다. CLI redact 경로와 같은 규약으로 best-effort 로 지운다 —
    // 벡터가 없거나 실패해도 SQLite 삭제는 이미 확정이므로 요청을 실패로 만들지 않는다.
    let vectorDeleted = false;
    if (storagePath) {
      try {
        const vectorStore = new VectorStore(path.join(storagePath, 'vectors'));
        await vectorStore.deleteEventEverywhere(id);
        vectorDeleted = true;
      } catch { /* a missing vector is not an error here */ }
    }

    return c.json({
      deleted: true,
      vectorDeleted,
      event: {
        id: event.id,
        eventType: event.eventType,
        timestamp: event.timestamp,
        sessionId: event.sessionId,
        contentLength: event.content.length
      }
    });
  } catch (error) {
    return jsonError(c, error);
  } finally {
    await store.close().catch(() => undefined);
  }
});
