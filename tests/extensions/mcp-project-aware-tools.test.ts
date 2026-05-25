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
      topK: 7,
      sessionId: 'session-a',
      recordTrace: false
    });
    expect(result.content[0]?.text).toContain('project scoped memory result');
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
      topK: 3,
      sessionId: undefined,
      recordTrace: false
    });
    expect(mocks.projectService.keywordSearch).toHaveBeenCalledWith('stale vector schema', { topK: 3 });
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
      embedding: { pending: 2, processing: 1, failed: 0, total: 5, stuckProcessing: 1, oldestProcessingAgeMs: 600000 },
      vector: { pending: 1, processing: 2, failed: 1, total: 4, stuckProcessing: 2, oldestProcessingAgeMs: 1200000 }
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
    expect(text).toContain('Embedding Outbox: pending=2, processing=1, failed=0, stuck=1, oldestProcessingAge=10m, total=5');
    expect(text).toContain('Vector Outbox Pending: 1');
    expect(text).toContain('Vector Outbox: pending=1, processing=2, failed=1, stuck=2, oldestProcessingAge=20m, total=4');
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
