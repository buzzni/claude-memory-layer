import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn(), registry: vi.fn() }));
vi.mock('../../../src/services/memory-service.js', () => ({
  DISABLED_SHARED_STORE_CONFIG: {},
  MemoryService: class {
    constructor(options: unknown) { return mocks.create(options); }
  }
}));
vi.mock('../../../src/core/registry/session-registry.js', () => ({ getSessionProject: mocks.registry }));
vi.mock('../../../src/core/registry/project-path.js', () => ({
  resolveProjectAnchorPath: (project: string) => project.replace('/worktree', ''),
  hashProjectPath: (project: string) => `hash-${project.replace('/worktree', '').slice(-1)}`,
  getProjectStoragePath: (project: string) => `/fixture-store/${project.slice(-1)}`
}));

beforeEach(() => {
  vi.resetModules();
  mocks.create.mockReset().mockImplementation((options: { projectHash?: string }) => ({
    retrieveMemories: vi.fn().mockResolvedValue({ memories: [{ score: 0.9, event: { eventType: 'agent_response', id: options.projectHash ?? 'global', content: options.projectHash ?? 'global', sessionId: 'past-session' } }] })
  }));
  mocks.registry.mockReset();
});
afterEach(() => { vi.resetModules(); });

function request(extra = {}) {
  return JSON.stringify({ type: 'retrieve', sessionId: 'unknown-session', prompt: 'release approval', topK: 5, minScore: 0.2, ...extra });
}

describe('semantic daemon authoritative project scope', () => {
  it.each([undefined, { projectHash: 'hash-wrong', projectPath: '/wrong/project' }])('ignores missing or stale registry routing when projectPath is supplied', async (registration) => {
    mocks.registry.mockReturnValue(registration);
    const { handleSemanticDaemonRequest } = await import('../../../src/adapters/claude/hooks/semantic-daemon.js');
    const result = await handleSemanticDaemonRequest(request({ projectPath: '/repo/a/worktree' }));
    expect(mocks.registry).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ projectHash: 'hash-a', projectPath: '/repo/a', storagePath: '/fixture-store/a', readOnly: true }));
    expect(result).toMatchObject({ ok: true, projectHash: 'hash-a', memories: [{ id: 'hash-a', content: 'hash-a' }] });
    expect(JSON.stringify(result)).not.toContain('/repo/a');
  });

  it('keeps stores separate across reused session identifiers', async () => {
    const { handleSemanticDaemonRequest } = await import('../../../src/adapters/claude/hooks/semantic-daemon.js');
    const a = await handleSemanticDaemonRequest(request({ projectPath: '/repo/a' }));
    const b = await handleSemanticDaemonRequest(request({ projectPath: '/repo/b' }));
    expect(a.projectHash).toBe('hash-a');
    expect(b.projectHash).toBe('hash-b');
    expect(a.memories?.[0].id).toBe('hash-a');
    expect(b.memories?.[0].id).toBe('hash-b');
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it('retains existing session-only global fallback without claiming scoped proof', async () => {
    const { handleSemanticDaemonRequest } = await import('../../../src/adapters/claude/hooks/semantic-daemon.js');
    const result = await handleSemanticDaemonRequest(request());
    expect(mocks.registry).toHaveBeenCalledWith('unknown-session');
    expect(result).toMatchObject({ ok: true, memories: [{ id: 'global' }] });
    expect(result.projectHash).toBeUndefined();
  });

  it('keeps the authoritative project store when retrying a vector session-filter schema mismatch', async () => {
    const retrieve = vi.fn()
      .mockRejectedValueOnce(new Error('No field named sessionId in schema'))
      .mockResolvedValueOnce({ memories: [] });
    mocks.create.mockReturnValue({ retrieveMemories: retrieve });
    const { handleSemanticDaemonRequest } = await import('../../../src/adapters/claude/hooks/semantic-daemon.js');
    expect(await handleSemanticDaemonRequest(request({ projectPath: '/repo/a' }))).toEqual({ ok: true, memories: [], projectHash: 'hash-a' });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.registry).not.toHaveBeenCalled();
    expect(retrieve.mock.calls[0][1]).toMatchObject({ sessionId: 'unknown-session', projectScopeMode: 'strict' });
    expect(retrieve.mock.calls[1][1]).toMatchObject({ projectScopeMode: 'strict' });
    expect(retrieve.mock.calls[1][1].sessionId).toBeUndefined();
  });

  it('rejects a null JSON payload without initializing services', async () => {
    const { handleSemanticDaemonRequest } = await import('../../../src/adapters/claude/hooks/semantic-daemon.js');
    expect(await handleSemanticDaemonRequest('null')).toEqual({ ok: false, error: 'invalid request' });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each(['', 'relative/path', null, 12])('rejects invalid scope before any service or registry access (%s)', async projectPath => {
    const { handleSemanticDaemonRequest } = await import('../../../src/adapters/claude/hooks/semantic-daemon.js');
    expect(await handleSemanticDaemonRequest(request({ projectPath }))).toEqual({ ok: false, error: 'invalid request' });
    expect(mocks.registry).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
