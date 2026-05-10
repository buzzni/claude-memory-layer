import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => {
  const fullService = {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    retrieveMemories: vi.fn(),
    keywordSearch: vi.fn(),
    getStats: vi.fn()
  };
  const lightweightService = {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    retrieveMemories: vi.fn(),
    keywordSearch: vi.fn(),
    getStats: vi.fn()
  };

  return {
    fullService,
    lightweightService,
    getServiceFromQuery: vi.fn(() => fullService),
    getLightweightServiceFromQuery: vi.fn(() => lightweightService),
    spawn: vi.fn()
  };
});

vi.mock('child_process', () => ({
  spawn: mocks.spawn
}));

vi.mock('../../src/apps/server/api/utils.js', () => ({
  getServiceFromQuery: mocks.getServiceFromQuery,
  getLightweightServiceFromQuery: mocks.getLightweightServiceFromQuery
}));

const { chatRouter } = await import('../../src/server/api/chat.js');

function createApp() {
  const app = new Hono();
  app.route('/api/chat', chatRouter);
  return app;
}

function memoryEvent(content: string) {
  return {
    id: 'event-1',
    eventType: 'user_prompt',
    sessionId: 'session-1',
    timestamp: new Date('2026-05-10T00:00:00.000Z'),
    content,
    metadata: {}
  };
}

function mockStats() {
  return { totalEvents: 51, vectorCount: 0, levelStats: [{ level: 'L1', count: 3 }] };
}

function mockClaudeAuthFailure() {
  mocks.spawn.mockImplementation(() => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const proc = new EventEmitter() as EventEmitter & {
      stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    proc.stdout = stdout;
    proc.stderr = stderr;
    proc.kill = vi.fn();
    proc.stdin = {
      write: vi.fn(),
      end: vi.fn(() => {
        queueMicrotask(() => {
          stderr.emit('data', Buffer.from('Claude CLI authentication failed: 401 Unauthorized'));
          proc.emit('close', 1);
        });
      })
    };
    return proc;
  });
}

describe('chat API memory-only usefulness mode', () => {
  beforeEach(() => {
    mocks.fullService.initialize.mockReset().mockResolvedValue(undefined);
    mocks.fullService.shutdown.mockReset().mockResolvedValue(undefined);
    mocks.fullService.retrieveMemories.mockReset().mockResolvedValue({ memories: [] });
    mocks.fullService.keywordSearch.mockReset().mockResolvedValue([]);
    mocks.fullService.getStats.mockReset().mockResolvedValue(mockStats());

    mocks.lightweightService.initialize.mockReset().mockResolvedValue(undefined);
    mocks.lightweightService.shutdown.mockReset().mockResolvedValue(undefined);
    mocks.lightweightService.retrieveMemories.mockReset().mockResolvedValue({ memories: [] });
    mocks.lightweightService.keywordSearch.mockReset().mockResolvedValue([
      { event: memoryEvent('dashboard stats fallback fixed query_rewrite_kind legacy schema'), score: 0.92 }
    ]);
    mocks.lightweightService.getStats.mockReset().mockResolvedValue(mockStats());

    mocks.getServiceFromQuery.mockClear();
    mocks.getLightweightServiceFromQuery.mockClear();
    mocks.spawn.mockReset();
  });

  it('streams retrieved memory context without invoking Claude CLI in memory-only mode', async () => {
    const res = await createApp().request('/api/chat?project=abc12345', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'dashboard stats', mode: 'memory-only' })
    });

    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain('event: diagnostic');
    expect(text).toContain('"status":"skipped"');
    expect(text).toContain('dashboard stats fallback fixed query_rewrite_kind legacy schema');
    expect(text).toContain('event: done');
    expect(mocks.getLightweightServiceFromQuery).toHaveBeenCalledTimes(1);
    expect(mocks.getServiceFromQuery).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('falls back to a memory-only answer with provider diagnostics when Claude CLI auth fails', async () => {
    mocks.fullService.retrieveMemories.mockResolvedValue({
      memories: [{ event: memoryEvent('Ask Memory should still show retrieved context when provider auth fails'), score: 0.88 }]
    });
    mockClaudeAuthFailure();

    const res = await createApp().request('/api/chat?project=abc12345', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Ask Memory auth failure' })
    });

    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain('event: provider_error');
    expect(text).toContain('claude-cli-auth');
    expect(text).toContain('Ask Memory should still show retrieved context when provider auth fails');
    expect(text).toContain('event: done');
    expect(mocks.getServiceFromQuery).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
});
