import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteAll } from '../../src/core/sqlite-wrapper.js';

const mocks = vi.hoisted(() => {
  const store = {
    initialize: vi.fn(async () => {}),
    getEvent: vi.fn(),
    deleteEventById: vi.fn(async () => true),
    close: vi.fn(async () => {})
  };
  const vectorStore = { deleteEventEverywhere: vi.fn(async () => {}) };
  return {
    store,
    vectorStore,
    getWritableEventStoreFromQuery: vi.fn(() => ({ store, storagePath: '/tmp/storage' })),
    getDiagnosticsServiceFromQuery: vi.fn()
  };
});

vi.mock('../../src/apps/server/api/utils.js', () => ({
  getWritableEventStoreFromQuery: mocks.getWritableEventStoreFromQuery,
  getDiagnosticsServiceFromQuery: mocks.getDiagnosticsServiceFromQuery,
  jsonError: (c: any, _e: unknown) => c.json({ status: 'error' }, 500)
}));

vi.mock('../../src/core/vector-store.js', () => ({
  VectorStore: class { deleteEventEverywhere = mocks.vectorStore.deleteEventEverywhere; }
}));

const { eventsRouter } = await import('../../src/apps/server/api/events.js');

function app(): Hono {
  const instance = new Hono();
  instance.route('/api/events', eventsRouter);
  return instance;
}

const existingEvent = {
  id: 'evt-1',
  eventType: 'user_prompt',
  timestamp: new Date('2026-01-01T00:00:00.000Z'),
  sessionId: 's1',
  content: 'to be removed',
  metadata: {}
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.store.getEvent.mockResolvedValue(existingEvent);
  mocks.store.deleteEventById.mockResolvedValue(true);
  mocks.getWritableEventStoreFromQuery.mockReturnValue({ store: mocks.store, storagePath: '/tmp/storage' });
});

describe('DELETE /api/events/:id', () => {
  it('deletes the event and reports what was removed', async () => {
    const response = await app().request('/api/events/evt-1', { method: 'DELETE' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deleted: true,
      vectorDeleted: true,
      event: { id: 'evt-1', sessionId: 's1', contentLength: 'to be removed'.length }
    });
    expect(mocks.store.deleteEventById).toHaveBeenCalledWith('evt-1', {
      operation: 'event_delete',
      actor: 'dashboard',
      targetType: 'event',
      targetId: 'evt-1',
      beforeJson: { eventType: 'user_prompt', sessionId: 's1', timestamp: existingEvent.timestamp, contentLength: 'to be removed'.length },
      sourceEventIds: ['evt-1']
    });
    // 감사 기록에는 지운 본문이 들어가면 안 된다.
    expect(JSON.stringify(mocks.store.deleteEventById.mock.calls[0])).not.toContain('to be removed');
    expect(mocks.vectorStore.deleteEventEverywhere).toHaveBeenCalledWith('evt-1');
    // 열어 둔 스토어는 반드시 닫는다 — 안 닫으면 SQLite 핸들이 샌다.
    expect(mocks.store.close).toHaveBeenCalled();
  });

  it('answers 404 for an unknown id without deleting', async () => {
    mocks.store.getEvent.mockResolvedValue(null);

    const response = await app().request('/api/events/nope', { method: 'DELETE' });

    expect(response.status).toBe(404);
    expect(mocks.store.deleteEventById).not.toHaveBeenCalled();
    expect(mocks.store.close).toHaveBeenCalled();
  });

  // 지우기의 부수 효과로 저장소를 만들면 안 된다.
  it('answers 404 when the project has no store yet', async () => {
    mocks.getWritableEventStoreFromQuery.mockReturnValue(null);

    const response = await app().request('/api/events/evt-1', { method: 'DELETE' });

    expect(response.status).toBe(404);
    expect(mocks.store.initialize).not.toHaveBeenCalled();
  });

  // 벡터는 LanceDB 에 따로 있다. 거기서 실패해도 SQLite 삭제는 이미 확정이므로
  // 요청 전체를 실패로 만들면 사용자는 "안 지워졌다"고 오해한다.
  it('still succeeds when vector cleanup fails', async () => {
    mocks.vectorStore.deleteEventEverywhere.mockRejectedValue(new Error('lance down'));

    const response = await app().request('/api/events/evt-1', { method: 'DELETE' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ deleted: true, vectorDeleted: false });
  });

  // 실제 SQLite 로 끝까지: 삭제와 같은 트랜잭션에 dashboard 감사 행이 남고, 본문은 남지 않는다.
  it('leaves one dashboard audit row in a real store, without the deleted content', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cml-events-delete-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'events.sqlite');
    const seed = new SQLiteEventStore(dbPath);
    await seed.initialize();
    const { eventId } = await seed.append({
      eventType: 'user_prompt', sessionId: 's1', timestamp: new Date('2026-01-01T00:00:00.000Z'), content: 'password=hunter2 secret body'
    });
    await seed.close();
    mocks.getWritableEventStoreFromQuery.mockReturnValue({ store: new SQLiteEventStore(dbPath), storagePath: undefined } as never);

    const response = await app().request(`/api/events/${eventId}`, { method: 'DELETE' });
    expect(response.status).toBe(200);

    const check = new SQLiteEventStore(dbPath);
    await check.initialize();
    const rows = sqliteAll<Record<string, string>>(check.getDatabase(), `SELECT * FROM memory_governance_audit WHERE operation = 'event_delete'`);
    expect(await check.getEvent(eventId!)).toBeNull();
    await check.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'dashboard', target_type: 'event', target_id: eventId });
    expect(JSON.parse(rows[0].before_json)).toEqual({
      eventType: 'user_prompt', sessionId: 's1', timestamp: '2026-01-01T00:00:00.000Z', contentLength: 'password=hunter2 secret body'.length
    });
    expect(JSON.parse(rows[0].after_json)).toEqual({ deletedEvents: 1 });
    expect(JSON.stringify(rows[0])).not.toMatch(/hunter2|secret body/);
  });
});
