import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

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
    expect(mocks.store.deleteEventById).toHaveBeenCalledWith('evt-1');
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
});
