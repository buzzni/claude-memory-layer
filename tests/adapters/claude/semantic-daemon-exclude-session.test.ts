import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The daemon passed its caller's session id to the retriever, where a session
 * id means "search this session first". A caller that wants memory from other
 * sessions now names the session to leave out instead.
 */

const mocks = vi.hoisted(() => ({ retrieve: vi.fn() }));
vi.mock('../../../src/services/memory-service.js', () => ({
  DISABLED_SHARED_STORE_CONFIG: {},
  MemoryService: class {
    constructor() { return { retrieveMemories: mocks.retrieve }; }
  }
}));
vi.mock('../../../src/core/registry/project-path.js', () => ({
  resolveProjectAnchorPath: (project: string) => project,
  hashProjectPath: () => 'hash-a',
  getProjectStoragePath: () => '/fixture-store/a'
}));

beforeEach(() => {
  vi.resetModules();
  mocks.retrieve.mockReset().mockResolvedValue({ memories: [] });
});
afterEach(() => { vi.resetModules(); });

function request(extra = {}) {
  return JSON.stringify({
    type: 'retrieve', sessionId: 'current', projectPath: '/repo/a', prompt: 'release approval', topK: 5, minScore: 0.2, ...extra
  });
}

describe('semantic daemon excludeSessionId', () => {
  it('runs the vector search outside the excluded session instead of inside the caller session', async () => {
    const { handleSemanticDaemonRequest } = await import('../../../src/adapters/claude/hooks/semantic-daemon.js');

    await handleSemanticDaemonRequest(request({ excludeSessionId: 'current' }));

    const options = mocks.retrieve.mock.calls[0][1];
    expect(options).toMatchObject({ excludeSessionId: 'current', strategy: 'deep', projectScopeMode: 'strict', recordTrace: false });
    expect(options.sessionId).toBeUndefined();
  });

  it('keeps the session-scoped search for callers that exclude nothing', async () => {
    const { handleSemanticDaemonRequest } = await import('../../../src/adapters/claude/hooks/semantic-daemon.js');

    await handleSemanticDaemonRequest(request());

    const options = mocks.retrieve.mock.calls[0][1];
    expect(options).toMatchObject({ sessionId: 'current' });
    expect(options.excludeSessionId).toBeUndefined();
    expect(options.strategy).toBeUndefined();
  });

  it('still leaves the session out when the vector table cannot filter by session', async () => {
    mocks.retrieve
      .mockRejectedValueOnce(new Error('No field named sessionId in schema'))
      .mockResolvedValueOnce({
        memories: [
          { score: 0.9, event: { eventType: 'agent_response', id: 'own', content: 'own', sessionId: 'current' } },
          { score: 0.8, event: { eventType: 'agent_response', id: 'past', content: 'past', sessionId: 'earlier' } }
        ]
      });
    const { handleSemanticDaemonRequest } = await import('../../../src/adapters/claude/hooks/semantic-daemon.js');

    const result = await handleSemanticDaemonRequest(request({ excludeSessionId: 'current' }));

    expect(result.memories?.map((memory) => memory.id)).toEqual(['past']);
  });

  it('rejects an excluded session that is not a string', async () => {
    const { handleSemanticDaemonRequest } = await import('../../../src/adapters/claude/hooks/semantic-daemon.js');

    await expect(handleSemanticDaemonRequest(request({ excludeSessionId: 7 }))).resolves.toMatchObject({ ok: false });
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });
});
