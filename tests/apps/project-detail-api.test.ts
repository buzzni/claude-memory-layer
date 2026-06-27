import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => {
  const service = {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    getStats: vi.fn(),
    getRecentEvents: vi.fn(),
    getRetrievalTraceStats: vi.fn(),
    getOutboxStats: vi.fn(),
  };
  return {
    service,
    MemoryService: vi.fn(function MockMemoryService() { return service; }),
    resolveProjectStoragePath: vi.fn(() => '/private/storage/path/SHOULD_NOT_LEAK'),
    loadSessionRegistry: vi.fn(() => ({
      sessions: {
        s1: { projectHash: 'abc12345', projectPath: '/private/repos/shop-app' },
        s2: { projectHash: 'other999', projectPath: '/private/repos/other' },
      },
    })),
  };
});

vi.mock('../../src/core/registry/project-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/registry/project-path.js')>();
  return {
    ...actual,
    resolveProjectStoragePath: mocks.resolveProjectStoragePath,
  };
});

vi.mock('../../src/services/memory-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/memory-service.js')>();
  return {
    ...actual,
    DISABLED_SHARED_STORE_CONFIG: {},
    MemoryService: mocks.MemoryService,
    loadSessionRegistry: mocks.loadSessionRegistry,
  };
});

const { projectsRouter } = await import('../../src/apps/server/api/projects.js');

function createApp() {
  const app = new Hono();
  app.route('/api/projects', projectsRouter);
  return app;
}

describe('project detail dashboard API', () => {
  beforeEach(() => {
    mocks.service.initialize.mockReset().mockResolvedValue(undefined);
    mocks.service.shutdown.mockReset().mockResolvedValue(undefined);
    mocks.service.getStats.mockReset().mockResolvedValue({
      totalEvents: 4,
      vectorCount: 3,
      levelStats: [{ level: 'L4', count: 2 }],
      rawPath: 'PRIVATE_STATS_PATH_SHOULD_NOT_LEAK',
    });
    mocks.service.getRecentEvents.mockReset().mockResolvedValue([
      { id: 'e1', eventType: 'user_prompt', sessionId: 's1', timestamp: new Date('2026-06-01T00:00:00Z'), content: 'PRIVATE_PROMPT_CONTENT_SHOULD_NOT_LEAK', metadata: { source: 'hermes' } },
      { id: 'e2', eventType: 'agent_response', sessionId: 's1', timestamp: new Date('2026-06-01T00:01:00Z'), content: 'PRIVATE_RESPONSE_CONTENT_SHOULD_NOT_LEAK', metadata: { source: 'hermes' } },
      { id: 'e3', eventType: 'tool_observation', sessionId: 's2', timestamp: new Date('2026-06-02T00:00:00Z'), content: 'PRIVATE_TOOL_CONTENT_SHOULD_NOT_LEAK', metadata: { source: 'codex' } },
      { id: 'e4', eventType: 'user_prompt', sessionId: 's2', timestamp: new Date('2026-06-03T00:00:00Z'), content: 'another prompt', metadata: { source: 'codex' } },
    ]);
    mocks.service.getRetrievalTraceStats.mockReset().mockResolvedValue({
      totalQueries: 7,
      avgCandidateCount: 4.2,
      avgSelectedCount: 1.5,
      selectionRate: 0.36,
      rawQueryText: 'PRIVATE_QUERY_SHOULD_NOT_LEAK',
    });
    mocks.service.getOutboxStats.mockReset().mockResolvedValue({
      embedding: { pending: 1, processing: 0, failed: 2, retryableFailed: 1, quarantinedFailed: 1, stuckProcessing: 0, total: 3, rawError: 'PRIVATE_EMBED_ERROR_SHOULD_NOT_LEAK' },
      vector: { pending: 2, processing: 1, failed: 3, retryableFailed: 0, quarantinedFailed: 3, stuckProcessing: 0, total: 4, itemIds: ['PRIVATE_VECTOR_ID_SHOULD_NOT_LEAK'] },
    });
    mocks.MemoryService.mockClear();
    mocks.resolveProjectStoragePath.mockClear();
    mocks.loadSessionRegistry.mockClear();
  });

  it('returns project-scoped aggregate details without raw content, paths, or trace payloads', async () => {
    const res = await createApp().request('/api/projects/abc12345/detail');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      project: { hash: 'abc12345', projectName: 'shop-app', registered: true },
      storage: { eventCount: 4, vectorCount: 3 },
      sessions: { total: 2 },
      eventTypes: { user_prompt: 2, agent_response: 1, tool_observation: 1 },
      sources: { hermes: 2, codex: 2 },
      retrieval: { totalQueries: 7, selectionRate: 0.36 },
      outbox: { pending: 3, processing: 1, failed: 5, retryableFailed: 1, quarantinedFailed: 4, stuckProcessing: 0 },
    });
    expect(body.project).not.toHaveProperty('projectPath');
    expect(mocks.resolveProjectStoragePath).toHaveBeenCalledWith('abc12345');
    expect(mocks.MemoryService).toHaveBeenCalledWith(expect.objectContaining({
      storagePath: '/private/storage/path/SHOULD_NOT_LEAK',
      readOnly: true,
      lightweightMode: true,
    }));
    expect(mocks.service.initialize).toHaveBeenCalledTimes(1);
    expect(mocks.service.shutdown).toHaveBeenCalledTimes(1);

    const serialized = JSON.stringify(body);
    for (const privateSentinel of [
      'PRIVATE_STATS_PATH_SHOULD_NOT_LEAK',
      'PRIVATE_PROMPT_CONTENT_SHOULD_NOT_LEAK',
      'PRIVATE_RESPONSE_CONTENT_SHOULD_NOT_LEAK',
      'PRIVATE_TOOL_CONTENT_SHOULD_NOT_LEAK',
      'PRIVATE_QUERY_SHOULD_NOT_LEAK',
      'PRIVATE_EMBED_ERROR_SHOULD_NOT_LEAK',
      'PRIVATE_VECTOR_ID_SHOULD_NOT_LEAK',
      '/private/repos/shop-app',
      '/private/storage/path/SHOULD_NOT_LEAK',
    ]) {
      expect(serialized).not.toContain(privateSentinel);
    }
  });
});
