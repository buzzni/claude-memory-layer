import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryEvent } from '../../src/core/types.js';

const mocks = vi.hoisted(() => {
  const service = {
    capabilities: { canonicalWrites: false, telemetryWrites: false, freshnessImports: false },
    initialize: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    retrieveMemories: vi.fn(),
    keywordSearch: vi.fn(),
    getRecentEvents: vi.fn(),
    getSessionHistory: vi.fn(),
    getEvent: vi.fn(),
    recordQueryTrace: vi.fn(),
    recordReferenceNavigation: vi.fn()
  };
  return {
    service,
    retrieveSemanticMemories: vi.fn(),
    getReadOnlyMemoryServiceForProject: vi.fn(() => service),
    getMemoryServiceForProject: vi.fn(() => service)
  };
});

vi.mock('../../src/services/memory-service.js', () => ({
  getDefaultMemoryService: vi.fn(() => mocks.service),
  getReadOnlyMemoryService: vi.fn(() => mocks.service),
  getReadOnlyMemoryServiceForProject: mocks.getReadOnlyMemoryServiceForProject,
  getMemoryServiceForProject: mocks.getMemoryServiceForProject,
  shutdownMemoryServices: vi.fn(async () => undefined)
}));
vi.mock('../../src/adapters/claude/hooks/semantic-daemon-client.js', () => ({
  retrieveSemanticMemories: mocks.retrieveSemanticMemories
}));

const { handleToolCall } = await import('../../src/extensions/mcp/handlers.js');

function event(overrides: Partial<MemoryEvent>): MemoryEvent {
  return {
    id: 'event-1',
    eventType: 'agent_response',
    sessionId: 'session-a',
    timestamp: new Date('2026-05-05T00:00:00.000Z'),
    content: 'memory content',
    canonicalKey: 'canonical:event-1',
    dedupeKey: 'dedupe:event-1',
    metadata: {},
    ...overrides
  } as MemoryEvent;
}

const semanticEvent = event({ id: 'semantic-1', content: 'Vector lane found the embedding broker decision record' });
const lexicalEvent = event({ id: 'lexical-1', content: 'Keyword lane matched the literal query words only' });

function textOf(result: Awaited<ReturnType<typeof handleToolCall>>): string {
  return String(result.content[0]?.text ?? '');
}

describe('read-only MCP retrieval semantic lane', () => {
  beforeEach(() => {
    mocks.service.capabilities.canonicalWrites = false;
    mocks.service.retrieveMemories.mockReset().mockResolvedValue({ memories: [{ event: lexicalEvent, score: 0.4 }] });
    mocks.service.getRecentEvents.mockReset().mockResolvedValue([]);
    mocks.service.getSessionHistory.mockReset().mockResolvedValue([]);
    mocks.service.getEvent.mockReset().mockImplementation(async (id: string) => (id === 'semantic-1' ? semanticEvent : null));
    mocks.retrieveSemanticMemories.mockReset().mockResolvedValue([
      { type: 'agent_response', content: semanticEvent.content, id: 'semantic-1', score: 0.91, sessionId: 'session-a' },
      { type: 'agent_response', content: 'gone', id: 'missing-1', score: 0.8 }
    ]);
  });

  it('asks the semantic daemon without starting it and ranks its hits ahead of the lexical lane', async () => {
    const result = await handleToolCall('mem-context-pack', {
      projectPath: '/repo/app', query: 'embedding broker decision', refreshLatest: false, topK: 3
    });

    expect(mocks.retrieveSemanticMemories).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: '/repo/app', prompt: 'embedding broker decision' }),
      expect.any(Number),
      { allowDaemonStart: false }
    );
    const text = textOf(result);
    expect(text.indexOf('Vector lane found')).toBeGreaterThan(-1);
    expect(text.indexOf('Vector lane found')).toBeLessThan(text.indexOf('Keyword lane matched'));
    expect(text).toContain('semantic daemon');
    expect(text).not.toContain('used lexical search');
  });

  it('falls back to the lexical lane with the read-only warning when the daemon is unavailable', async () => {
    mocks.retrieveSemanticMemories.mockRejectedValue(Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' }));

    const result = await handleToolCall('mem-context-pack', {
      projectPath: '/repo/app', query: 'embedding broker decision', refreshLatest: false, topK: 3
    });

    const text = textOf(result);
    expect(text).toContain('Keyword lane matched');
    expect(text).toContain('used lexical search');
  });

  it('keeps a session-filtered read-only query on the lexical lane', async () => {
    await handleToolCall('mem-context-pack', {
      projectPath: '/repo/app', query: 'embedding broker decision', refreshLatest: false, sessionId: 'session-a', topK: 3
    });

    expect(mocks.retrieveSemanticMemories).not.toHaveBeenCalled();
  });

  it('does not use the daemon when the service can run the full retrieval itself', async () => {
    mocks.service.capabilities.canonicalWrites = true;

    await handleToolCall('mem-context-pack', { projectPath: '/repo/app', query: 'embedding broker decision', topK: 3 });

    expect(mocks.retrieveSemanticMemories).not.toHaveBeenCalled();
  });
});
