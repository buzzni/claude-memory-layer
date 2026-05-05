import { beforeEach, describe, expect, it, vi } from 'vitest';

import { generateCitationId } from '../../src/core/citation-generator.js';
import type { MemoryEvent } from '../../src/core/types.js';

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
  service.getStats.mockReset().mockResolvedValue({ totalEvents: 0, vectorCount: 0, levelStats: [] });
}

function event(overrides: Partial<MemoryEvent>): MemoryEvent {
  return {
    id: 'event-1',
    eventType: 'user_prompt',
    sessionId: 'session-a',
    timestamp: new Date('2026-05-05T00:00:00.000Z'),
    content: 'memory content',
    canonicalKey: 'canonical:event-1',
    dedupeKey: 'dedupe:event-1',
    metadata: {},
    ...overrides
  };
}

function textOf(result: Awaited<ReturnType<typeof handleToolCall>>): string {
  return String(result.content[0]?.text ?? '');
}

describe('MCP project context tools', () => {
  beforeEach(() => {
    resetService(mocks.defaultService);
    resetService(mocks.projectService);
    mocks.getDefaultMemoryService.mockClear();
    mocks.getMemoryServiceForProject.mockClear();
  });

  it('advertises context-pack, project-timeline, and source-ref tools with projectPath support', () => {
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    for (const name of ['mem-context-pack', 'mem-project-timeline', 'mem-source-ref']) {
      const tool = byName.get(name);
      expect(tool).toBeDefined();
      expect(tool?.inputSchema).toMatchObject({ type: 'object' });
      const properties = tool?.inputSchema.properties as Record<string, unknown>;
      expect(properties.projectPath).toMatchObject({
        type: 'string',
        description: expect.stringContaining('project')
      });
    }
  });

  it('builds a compact project context pack from relevant search results and recent timeline', async () => {
    const relevant = event({
      id: '11111111-1111-4111-8111-111111111111',
      sessionId: 'session-codex',
      timestamp: new Date('2026-05-05T01:00:00.000Z'),
      content: 'Codex import CLI and project-aware MCP integration were implemented.'
    });
    const recent = [
      event({
        id: '22222222-2222-4222-8222-222222222222',
        sessionId: 'session-hermes',
        eventType: 'agent_response',
        timestamp: new Date('2026-05-05T02:00:00.000Z'),
        content: 'Hermes adapter verification passed with targeted tests.',
        metadata: { importedFrom: 'hermes' }
      }),
      relevant,
      event({
        id: '33333333-3333-4333-8333-333333333333',
        sessionId: 'session-old',
        timestamp: new Date('2026-05-04T02:00:00.000Z'),
        content: 'Older cleanup note.',
        metadata: { importedFrom: 'claude-code' }
      })
    ];

    mocks.projectService.retrieveMemories.mockResolvedValue({ memories: [{ event: relevant, score: 0.93 }] });
    mocks.projectService.getRecentEvents.mockResolvedValue(recent);

    const result = await handleToolCall('mem-context-pack', {
      projectPath: '/repo/app',
      query: 'Codex Hermes MCP integration',
      topK: 2,
      recentLimit: 3,
      sessionLimit: 2
    });

    const text = textOf(result);
    expect(result.isError).not.toBe(true);
    expect(mocks.getMemoryServiceForProject).toHaveBeenCalledWith('/repo/app');
    expect(mocks.projectService.retrieveMemories).toHaveBeenCalledWith('Codex Hermes MCP integration', {
      topK: 2,
      sessionId: undefined,
      recordTrace: false
    });
    expect(mocks.projectService.getRecentEvents).toHaveBeenCalledWith(3);
    expect(text).toContain('## Project Context Pack');
    expect(text).toContain('### Relevant Memories');
    expect(text).toContain('Codex import CLI');
    expect(text).toContain('### Recent Project Timeline');
    expect(text).toContain('Hermes adapter verification');
    expect(text).toContain(`[mem:${generateCitationId(relevant.id)}]`);
    expect(text.length).toBeLessThan(5000);
  });

  it('summarizes a project timeline by recent sessions and source agent metadata', async () => {
    mocks.projectService.getRecentEvents.mockResolvedValue([
      event({
        id: 'a1',
        sessionId: 'session-a',
        eventType: 'user_prompt',
        timestamp: new Date('2026-05-05T01:00:00.000Z'),
        content: 'Implement Hermes context tools.',
        metadata: { importedFrom: '/Users/example/.hermes/state.db', source: 'hermes' }
      }),
      event({
        id: 'a2',
        sessionId: 'session-a',
        eventType: 'agent_response',
        timestamp: new Date('2026-05-05T01:02:00.000Z'),
        content: 'Added tests for context tools.',
        metadata: { importedFrom: '/Users/example/.hermes/state.db', source: 'hermes' }
      }),
      event({
        id: 'b1',
        sessionId: 'session-b',
        eventType: 'user_prompt',
        timestamp: new Date('2026-05-05T00:30:00.000Z'),
        content: 'Review Codex memory import.',
        metadata: { importedFrom: '/Users/example/.codex/sessions/project.jsonl', source: 'codex' }
      })
    ]);

    const result = await handleToolCall('mem-project-timeline', {
      projectPath: '/repo/app',
      limit: 10,
      sessionLimit: 2
    });

    const text = textOf(result);
    expect(result.isError).not.toBe(true);
    expect(mocks.projectService.getRecentEvents).toHaveBeenCalledWith(10);
    expect(text).toContain('## Project Memory Timeline');
    expect(text).toContain('session-a');
    expect(text).toContain('Events: 2');
    expect(text).toContain('Source: hermes');
    expect(text).toContain('user_prompt: 1');
    expect(text).toContain('agent_response: 1');
    expect(text).toContain('session-b');
    expect(text).toContain('Source: codex');
    expect(text).not.toContain('/Users/example');
    expect(text).not.toContain('.codex/sessions');
  });

  it('redacts sensitive source-agent metadata in timeline summaries', async () => {
    mocks.projectService.getRecentEvents.mockResolvedValue([
      event({
        id: 'source-redaction-1',
        sessionId: 'session-source-redaction',
        timestamp: new Date('2026-05-05T04:00:00.000Z'),
        content: 'Timeline source label should be safe.',
        metadata: { sourceAgent: 'token=leaky-source-fixture' }
      })
    ]);

    const result = await handleToolCall('mem-project-timeline', {
      projectPath: '/repo/app',
      limit: 10,
      sessionLimit: 1
    });

    const text = textOf(result);
    expect(result.isError).not.toBe(true);
    expect(text).toContain('Source: [REDACTED]');
    expect(text).not.toContain('leaky-source-fixture');
  });

  it('resolves source references with redacted preview and safe metadata only', async () => {
    const sensitive = event({
      id: '44444444-4444-4444-8444-444444444444',
      sessionId: 'session-sensitive',
      timestamp: new Date('2026-05-05T03:00:00.000Z'),
      content: 'Debug note with api_key=sensitive-fixture-value token=abc123 password=pw but useful MCP context.',
      metadata: {
        importedFrom: '/Users/example/.hermes/state.db',
        source: ['discord', 'token=leaky-array-fixture'],
        transcriptPath: '/tmp/private-transcript.jsonl',
        secret: 'sensitive-fixture-value'
      }
    });
    mocks.projectService.getRecentEvents.mockResolvedValue([sensitive]);

    const result = await handleToolCall('mem-source-ref', {
      projectPath: '/repo/app',
      ids: [sensitive.id],
      maxContentChars: 240
    });

    const text = textOf(result);
    expect(result.isError).not.toBe(true);
    expect(text).toContain('## Source References');
    expect(text).toContain(`[mem:${generateCitationId(sensitive.id)}]`);
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('importedFrom');
    expect(text).not.toContain('/Users/example');
    expect(text).toContain('source: discord');
    expect(text).not.toContain('leaky-array-fixture');
    expect(text).not.toContain('sensitive-fixture-value');
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('password=pw');
    expect(text).not.toContain('transcriptPath');
    expect(text).not.toContain('secret:');
  });

  it('resolves source references by short citation id', async () => {
    const target = event({ id: '55555555-5555-4555-8555-555555555555', content: 'Citation lookup target.' });
    mocks.projectService.getRecentEvents.mockResolvedValue([target]);

    const result = await handleToolCall('mem-source-ref', {
      projectPath: '/repo/app',
      ids: [generateCitationId(target.id)]
    });

    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain('Citation lookup target');
  });
});
