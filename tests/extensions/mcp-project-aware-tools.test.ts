import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  function createService() {
    return {
      initialize: vi.fn(async () => undefined),
      retrieveMemories: vi.fn(),
      keywordSearch: vi.fn(),
      getRecentEvents: vi.fn(),
      getSessionHistory: vi.fn(),
      getOutboxStats: vi.fn(),
      getStats: vi.fn()
    };
  }

  const defaultService = createService();
  const projectService = createService();

  return {
    defaultService,
    projectService,
    getDefaultMemoryService: vi.fn(() => defaultService),
    getMemoryServiceForProject: vi.fn(() => projectService)
  };
});

vi.mock('../../src/services/memory-service.js', () => ({
  getDefaultMemoryService: mocks.getDefaultMemoryService,
  getMemoryServiceForProject: mocks.getMemoryServiceForProject
}));

const { handleToolCall } = await import('../../src/extensions/mcp/handlers.js');
const { tools } = await import('../../src/extensions/mcp/tools.js');

function resetService(service: typeof mocks.defaultService) {
  service.initialize.mockReset().mockResolvedValue(undefined);
  service.retrieveMemories.mockReset().mockResolvedValue({ memories: [] });
  service.keywordSearch.mockReset().mockResolvedValue([]);
  service.getRecentEvents.mockReset().mockResolvedValue([]);
  service.getSessionHistory.mockReset().mockResolvedValue([]);
  service.getOutboxStats.mockReset().mockResolvedValue({
    embedding: { pending: 0, processing: 0, failed: 0, total: 0, stuckProcessing: 0, oldestProcessingAgeMs: null },
    vector: { pending: 0, processing: 0, failed: 0, total: 0, stuckProcessing: 0, oldestProcessingAgeMs: null }
  });
  service.getStats.mockReset().mockResolvedValue({ totalEvents: 0, vectorCount: 0 });
}

describe('MCP project-aware memory tools', () => {
  beforeEach(() => {
    resetService(mocks.defaultService);
    resetService(mocks.projectService);
    mocks.getDefaultMemoryService.mockClear();
    mocks.getMemoryServiceForProject.mockClear();
  });

  it('advertises optional projectPath on all memory tools', () => {
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
      const properties = tool.inputSchema.properties as Record<string, unknown>;
      expect(properties.projectPath).toMatchObject({
        type: 'string',
        description: expect.stringContaining('project')
      });
    }
  });

  it('uses the project-scoped memory service when mem-search receives projectPath', async () => {
    mocks.projectService.retrieveMemories.mockResolvedValue({
      memories: [
        {
          score: 0.91,
          event: {
            id: 'event-project-1',
            sessionId: 'session-a',
            eventType: 'user_prompt',
            timestamp: new Date('2026-05-05T00:00:00.000Z'),
            content: 'project scoped memory result',
            metadata: {}
          }
        }
      ]
    });

    const result = await handleToolCall('mem-search', {
      query: 'project scoped memory',
      projectPath: '/repo/app',
      topK: 7,
      sessionId: 'session-a'
    });

    expect(result.isError).not.toBe(true);
    expect(mocks.getMemoryServiceForProject).toHaveBeenCalledWith('/repo/app');
    expect(mocks.getDefaultMemoryService).not.toHaveBeenCalled();
    expect(mocks.projectService.initialize).toHaveBeenCalledTimes(1);
    expect(mocks.projectService.retrieveMemories).toHaveBeenCalledWith('project scoped memory', {
      topK: 20,
      sessionId: 'session-a',
      recordTrace: false
    });
    expect(result.content[0]?.text).toContain('project scoped memory result');
  });

  it('redacts sensitive values and private paths from mem-search previews', async () => {
    mocks.projectService.retrieveMemories.mockResolvedValue({
      memories: [
        {
          score: 0.91,
          event: {
            id: 'event-sensitive-search-1',
            sessionId: 'session-sensitive-search',
            eventType: 'agent_response',
            timestamp: new Date('2026-05-05T00:00:00.000Z'),
            content: 'Debug note api_key=sensitive-fixture-value token=abc123 password=pw stored at /Users/example/.hermes/state.db for MCP context.',
            metadata: {}
          }
        }
      ]
    });

    const result = await handleToolCall('mem-search', {
      query: 'sensitive preview',
      projectPath: '/repo/app',
      topK: 1
    });

    const text = String(result.content[0]?.text ?? '');
    expect(result.isError).not.toBe(true);
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('[path]');
    expect(text).not.toContain('sensitive-fixture-value');
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('password=pw');
    expect(text).not.toContain('/Users/example');
    expect(text).not.toContain('.hermes/state.db');
  });

  it('applies eventType filtering before rendering mem-search results', async () => {
    mocks.projectService.retrieveMemories.mockResolvedValue({
      memories: [
        {
          score: 0.91,
          event: {
            id: 'event-filter-user',
            sessionId: 'session-filter',
            eventType: 'user_prompt',
            timestamp: new Date('2026-05-05T00:00:00.000Z'),
            content: 'user prompt result should be filtered out',
            metadata: {}
          }
        },
        {
          score: 0.88,
          event: {
            id: 'event-filter-agent',
            sessionId: 'session-filter',
            eventType: 'agent_response',
            timestamp: new Date('2026-05-05T00:01:00.000Z'),
            content: 'agent response result should remain visible',
            metadata: {}
          }
        }
      ]
    });

    const result = await handleToolCall('mem-search', {
      query: 'event type filter',
      projectPath: '/repo/app',
      topK: 2,
      eventType: 'agent_response'
    });

    const text = String(result.content[0]?.text ?? '');
    expect(result.isError).not.toBe(true);
    expect(text).toContain('Found 1 relevant memories');
    expect(text).toContain('agent response result should remain visible');
    expect(text).not.toContain('user prompt result should be filtered out');
  });

  it('normalizes invalid mem-search topK values before retrieval', async () => {
    mocks.projectService.retrieveMemories.mockResolvedValue({ memories: [] });

    await handleToolCall('mem-search', {
      query: 'negative topK',
      projectPath: '/repo/app',
      topK: -7
    });

    expect(mocks.projectService.retrieveMemories).toHaveBeenLastCalledWith('negative topK', {
      topK: 3,
      sessionId: undefined,
      recordTrace: false
    });

    await handleToolCall('mem-search', {
      query: 'malformed topK',
      projectPath: '/repo/app',
      topK: 'not-a-number'
    });

    expect(mocks.projectService.retrieveMemories).toHaveBeenLastCalledWith('malformed topK', {
      topK: 15,
      sessionId: undefined,
      recordTrace: false
    });
  });

  it('redacts sensitive values and private paths from mem-timeline previews', async () => {
    mocks.projectService.getRecentEvents.mockResolvedValue([
      {
        id: 'timeline-sensitive-target',
        sessionId: 'session-sensitive-timeline',
        eventType: 'agent_response',
        timestamp: new Date('2026-05-05T00:01:00.000Z'),
        content: 'Timeline note api_key=sensitive-fixture-value token=abc123 password=pw stored at /Users/example/.hermes/state.db.',
        metadata: {}
      }
    ]);

    const result = await handleToolCall('mem-timeline', {
      projectPath: '/repo/app',
      ids: ['timeline-sensitive-target'],
      windowSize: 1
    });

    const text = String(result.content[0]?.text ?? '');
    expect(result.isError).not.toBe(true);
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('[path]');
    expect(text).not.toContain('sensitive-fixture-value');
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('password=pw');
    expect(text).not.toContain('/Users/example');
    expect(text).not.toContain('.hermes/state.db');
  });

  it('overfetches then suppresses compaction handoff artifacts from mem-search results', async () => {
    mocks.projectService.retrieveMemories.mockResolvedValue({
      memories: [
        {
          score: 0.99,
          event: {
            id: 'event-handoff-1',
            sessionId: 'session-handoff',
            eventType: 'user_prompt',
            timestamp: new Date('2026-05-05T00:00:00.000Z'),
            content: '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. This is a handoff from a previous context window. ## Active Task',
            metadata: {}
          }
        },
        {
          score: 0.98,
          event: {
            id: 'event-handoff-2',
            sessionId: 'session-handoff',
            eventType: 'agent_response',
            timestamp: new Date('2026-05-05T00:01:00.000Z'),
            content: '[Your active task list was preserved across context compression]\n- [>] inspect. Inspect retrieval/context-pack/search implementation.',
            metadata: {}
          }
        },
        {
          score: 0.63,
          event: {
            id: 'event-direct-1',
            sessionId: 'session-direct',
            eventType: 'agent_response',
            timestamp: new Date('2026-05-05T00:02:00.000Z'),
            content: 'Direct project memory result about retrieval-quality.ts handoff artifact filtering.',
            metadata: {}
          }
        },
        {
          score: 0.62,
          event: {
            id: 'event-discussion-1',
            sessionId: 'session-direct',
            eventType: 'agent_response',
            timestamp: new Date('2026-05-05T00:03:00.000Z'),
            content: 'Headroom-inspired ContextCompressor implementation discussion preserves source refs during context compression.',
            metadata: {}
          }
        }
      ]
    });

    const result = await handleToolCall('mem-search', {
      query: 'context compression retrieval filters',
      projectPath: '/repo/app',
      topK: 2
    });

    const text = String(result.content[0]?.text ?? '');
    expect(result.isError).not.toBe(true);
    expect(mocks.projectService.retrieveMemories).toHaveBeenCalledWith('context compression retrieval filters', {
      topK: 6,
      sessionId: undefined,
      recordTrace: false
    });
    expect(text).toContain('Found 2 relevant memories');
    expect(text).toContain('Direct project memory result');
    expect(text).toContain('Headroom-inspired ContextCompressor implementation discussion');
    expect(text).not.toContain('CONTEXT COMPACTION');
    expect(text).not.toContain('active task list was preserved');
  });

  it('suppresses compaction handoff artifacts from mem-timeline windows', async () => {
    mocks.projectService.getRecentEvents.mockResolvedValue([
      {
        id: 'timeline-handoff-before',
        sessionId: 'session-timeline',
        eventType: 'user_prompt',
        timestamp: new Date('2026-05-05T00:00:00.000Z'),
        content: '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. This is a handoff from a previous context window. ## Active Task',
        metadata: {}
      },
      {
        id: 'timeline-target',
        sessionId: 'session-timeline',
        eventType: 'agent_response',
        timestamp: new Date('2026-05-05T00:01:00.000Z'),
        content: 'Direct project memory: timeline should retain actionable context-pack artifact filter progress.',
        metadata: {}
      },
      {
        id: 'timeline-handoff-after',
        sessionId: 'session-timeline',
        eventType: 'user_prompt',
        timestamp: new Date('2026-05-05T00:02:00.000Z'),
        content: '[Your active task list was preserved across context compression]\n- [>] inspect. Inspect retrieval/context-pack/search implementation.',
        metadata: {}
      },
      {
        id: 'timeline-discussion',
        sessionId: 'session-timeline',
        eventType: 'agent_response',
        timestamp: new Date('2026-05-05T00:03:00.000Z'),
        content: 'Legitimate context compression implementation discussion remains visible in timeline context.',
        metadata: {}
      }
    ]);

    const result = await handleToolCall('mem-timeline', {
      projectPath: '/repo/app',
      ids: ['timeline-target'],
      windowSize: 2
    });

    const text = String(result.content[0]?.text ?? '');
    expect(result.isError).not.toBe(true);
    expect(text).toContain('Direct project memory');
    expect(text).toContain('Legitimate context compression implementation discussion');
    expect(text).not.toContain('CONTEXT COMPACTION');
    expect(text).not.toContain('active task list was preserved');
    expect(text).not.toContain('Inspect retrieval/context-pack/search implementation');
  });

  it('uses keyword fallback when mem-search semantic/vector retrieval hits a stale vector schema', async () => {
    mocks.projectService.retrieveMemories.mockRejectedValue(new Error(
      'Failed to execute query stream: Invalid input, No vector column found to match with the query vector dimension: 384'
    ));
    mocks.projectService.keywordSearch.mockResolvedValue([
      {
        score: 0.44,
        event: {
          id: 'event-project-fallback-1',
          sessionId: 'session-fallback',
          eventType: 'agent_response',
          timestamp: new Date('2026-05-05T00:30:00.000Z'),
          content: 'fallback keyword memory result for stale vector schema',
          metadata: {}
        }
      }
    ]);

    const result = await handleToolCall('mem-search', {
      query: 'stale vector schema',
      projectPath: '/repo/app',
      topK: 3
    });

    const text = String(result.content[0]?.text ?? '');
    expect(result.isError).not.toBe(true);
    expect(mocks.projectService.retrieveMemories).toHaveBeenCalledWith('stale vector schema', {
      topK: 9,
      sessionId: undefined,
      recordTrace: false
    });
    expect(mocks.projectService.keywordSearch).toHaveBeenCalledWith('stale vector schema', { topK: 9 });
    expect(text).toContain('Warning: semantic/vector retrieval unavailable; used keyword fallback.');
    expect(text).toContain('fallback keyword memory result');
    expect(text).not.toContain('query vector dimension: 384');
  });

  it('preserves sessionId filtering during keyword fallback before returning topK results', async () => {
    mocks.projectService.retrieveMemories.mockRejectedValue(new Error(
      'Failed to execute query stream: Invalid input, No vector column found to match with the query vector dimension: 384'
    ));
    mocks.projectService.getSessionHistory.mockResolvedValue([
      {
        id: 'event-target-session-1',
        sessionId: 'session-target',
        eventType: 'agent_response',
        timestamp: new Date('2026-05-05T00:32:00.000Z'),
        content: 'target session fallback result survives session filtering',
        metadata: {}
      }
    ]);

    const result = await handleToolCall('mem-search', {
      query: 'session scoped stale vector schema',
      projectPath: '/repo/app',
      topK: 1,
      sessionId: 'session-target'
    });

    const text = String(result.content[0]?.text ?? '');
    expect(result.isError).not.toBe(true);
    expect(mocks.projectService.getSessionHistory).toHaveBeenCalledWith('session-target');
    expect(mocks.projectService.keywordSearch).not.toHaveBeenCalled();
    expect(text).toContain('Found 1 relevant memories');
    expect(text).toContain('target session fallback result');
    expect(text).not.toContain('higher ranked fallback from another session');
  });

  it('renders project-scoped mem-stats safe storage metadata and freshness guidance', async () => {
    mocks.projectService.getStats.mockResolvedValue({
      totalEvents: 7,
      vectorCount: 3,
      levelStats: [{ level: 'working', count: 7 }]
    });
    mocks.projectService.getRecentEvents.mockResolvedValue([
      {
        id: 'event-stats-1',
        sessionId: 'session-stats-a',
        eventType: 'user_prompt',
        timestamp: new Date('2026-05-05T01:00:00.000Z'),
        content: 'stats event',
        metadata: {}
      }
    ]);
    mocks.projectService.getOutboxStats.mockResolvedValue({
      embedding: { pending: 2, processing: 1, failed: 2, retryableFailed: 1, quarantinedFailed: 1, total: 5, stuckProcessing: 1, oldestProcessingAgeMs: 600000 },
      vector: { pending: 1, processing: 2, failed: 3, retryableFailed: 0, quarantinedFailed: 3, total: 4, stuckProcessing: 2, oldestProcessingAgeMs: 1200000 }
    });

    const result = await handleToolCall('mem-stats', { projectPath: '/repo/app' });

    const text = String(result.content[0]?.text ?? '');
    expect(result.isError).not.toBe(true);
    expect(mocks.getMemoryServiceForProject).toHaveBeenCalledWith('/repo/app');
    expect(mocks.projectService.getOutboxStats).toHaveBeenCalledTimes(1);
    expect(text).toContain('Storage View: project:');
    expect(text).toContain('Storage Path Label: ~/.claude-code/memory/projects/');
    expect(text).toContain('Embedder Model: Xenova/multilingual-e5-small');
    expect(text).toContain('Vector Table Dimension: unknown');
    expect(text).toContain('Pending Embeddings: 2');
    expect(text).toContain('Embedding Outbox: pending=2, processing=1, failed=2, retryableFailed=1, quarantinedFailed=1, stuck=1, oldestProcessingAge=10m, total=5');
    expect(text).toContain('Vector Outbox Pending: 1');
    expect(text).toContain('Vector Outbox: pending=1, processing=2, failed=3, retryableFailed=0, quarantinedFailed=3, stuck=2, oldestProcessingAge=20m, total=4');
    expect(text).toContain('MCP/CLI parity');
    expect(text).toContain('restart');
    expect(text).not.toContain('/repo/app');
  });

  it('falls back to the global memory service when projectPath is absent', async () => {
    await handleToolCall('mem-stats', {});

    expect(mocks.getDefaultMemoryService).toHaveBeenCalledTimes(1);
    expect(mocks.getMemoryServiceForProject).not.toHaveBeenCalled();
    expect(mocks.defaultService.initialize).toHaveBeenCalledTimes(1);
    expect(mocks.defaultService.getStats).toHaveBeenCalledTimes(1);
  });
});
