import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  function createService() {
    return {
      initialize: vi.fn(async () => undefined),
      retrieveMemories: vi.fn(),
      getRecentEvents: vi.fn(),
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
  service.getRecentEvents.mockReset().mockResolvedValue([]);
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
      sessionId: 'session-a'
    });
    expect(result.content[0]?.text).toContain('project scoped memory result');
  });

  it('falls back to the global memory service when projectPath is absent', async () => {
    await handleToolCall('mem-stats', {});

    expect(mocks.getDefaultMemoryService).toHaveBeenCalledTimes(1);
    expect(mocks.getMemoryServiceForProject).not.toHaveBeenCalled();
    expect(mocks.defaultService.initialize).toHaveBeenCalledTimes(1);
    expect(mocks.defaultService.getStats).toHaveBeenCalledTimes(1);
  });
});
