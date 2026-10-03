import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ connect: vi.fn(), spawn: vi.fn(), exists: vi.fn(), mkdir: vi.fn() }));
vi.mock('net', () => ({ createConnection: mocks.connect }));
vi.mock('child_process', () => ({ spawn: mocks.spawn }));
vi.mock('fs', () => ({ existsSync: mocks.exists, mkdirSync: mocks.mkdir }));
vi.mock('../../../src/core/registry/project-path.js', () => ({ hashProjectPath: () => 'hash-project' }));

class Socket extends EventEmitter {
  setEncoding = vi.fn();
  destroy = vi.fn();
  end = vi.fn();
}

beforeEach(() => {
  vi.resetModules();
  mocks.connect.mockReset();
  mocks.spawn.mockReset().mockReturnValue({ unref: vi.fn() });
  mocks.exists.mockReset().mockReturnValue(true);
  mocks.mkdir.mockReset();
  vi.stubEnv('CLAUDE_MEMORY_DEBUG', '1');
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules(); });

function response(body: unknown) {
  const socket = new Socket();
  socket.end.mockImplementation(() => queueMicrotask(() => {
    socket.emit('data', JSON.stringify(body));
    socket.emit('end');
  }));
  mocks.connect.mockImplementationOnce(() => { queueMicrotask(() => socket.emit('connect')); return socket; });
  return socket;
}

function refused() {
  mocks.connect.mockImplementationOnce(() => {
    const socket = new Socket();
    queueMicrotask(() => socket.emit('error', Object.assign(new Error('private socket path'), { code: 'ECONNREFUSED' })));
    return socket;
  });
}

const request = { sessionId: 'unregistered', projectPath: '/repo/project', prompt: 'release approvals', topK: 5, minScore: 0.2 };
const memory = { id: 'fixture-memory', type: 'agent_response', content: 'fixture evidence' };

describe('semantic client project proof and daemon lifecycle', () => {
  it('sends authoritative projectPath and accepts a matching scoped response', async () => {
    const socket = response({ ok: true, projectHash: 'hash-project', memories: [memory] });
    const { retrieveSemanticMemories } = await import('../../../src/adapters/claude/hooks/semantic-daemon-client.js');
    expect(await retrieveSemanticMemories(request, 1000)).toEqual([memory]);
    expect(JSON.parse(socket.end.mock.calls[0][0])).toMatchObject({ projectPath: '/repo/project', sessionId: 'unregistered' });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each([undefined, 'hash-other'])('discards missing or mismatched project proof without retry/start (%s)', async projectHash => {
    response({ ok: true, projectHash, memories: [memory] });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { retrieveSemanticMemories } = await import('../../../src/adapters/claude/hooks/semantic-daemon-client.js');
    await expect(retrieveSemanticMemories(request, 1000)).rejects.toThrow('scope not confirmed');
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it('preserves legacy session-only retrieval without requiring project proof', async () => {
    response({ ok: true, memories: [memory] });
    const { retrieveSemanticMemories } = await import('../../../src/adapters/claude/hooks/semantic-daemon-client.js');
    const { projectPath: _, ...legacy } = request;
    expect(await retrieveSemanticMemories(legacy, 1000)).toEqual([memory]);
  });

  it('does not launch or retry a missing daemon when host-worker startup is disabled', async () => {
    refused();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { retrieveSemanticMemories } = await import('../../../src/adapters/claude/hooks/semantic-daemon-client.js');
    await expect(retrieveSemanticMemories(request, 1000, { allowDaemonStart: false })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it('preserves native default daemon startup and scoped retry on connection failure', async () => {
    refused(); // retrieval fails
    refused(); // ensureDaemonRunning initial probe
    const listening = new Socket();
    mocks.connect.mockImplementationOnce(() => { queueMicrotask(() => listening.emit('connect')); return listening; });
    response({ ok: true, projectHash: 'hash-project', memories: [memory] });
    const { retrieveSemanticMemories } = await import('../../../src/adapters/claude/hooks/semantic-daemon-client.js');
    expect(await retrieveSemanticMemories(request, 1000)).toEqual([memory]);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).toHaveBeenCalledWith(process.execPath, [expect.stringContaining('semantic-daemon.js')], expect.objectContaining({ detached: true }));
  });
});
