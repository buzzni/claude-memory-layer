import { beforeEach, describe, expect, it, vi } from 'vitest';

import { generateCitationId } from '../../src/core/citation-generator.js';
import type { MemoryEvent } from '../../src/core/types.js';

const mocks = vi.hoisted(() => {
  function createService() {
    return {
      initialize: vi.fn(async () => undefined),
      retrieveMemories: vi.fn(),
      getRecentEvents: vi.fn(),
      getStats: vi.fn(),
      processPendingEmbeddings: vi.fn()
    };
  }

  const defaultService = createService();
  const projectService = createService();
  const claudeImporter = { importProject: vi.fn() };
  const codexImporter = { importProject: vi.fn() };
  const hermesImporter = { importProject: vi.fn() };

  return {
    defaultService,
    projectService,
    claudeImporter,
    codexImporter,
    hermesImporter,
    getDefaultMemoryService: vi.fn(() => defaultService),
    getMemoryServiceForProject: vi.fn(() => projectService),
    createSessionHistoryImporter: vi.fn(() => claudeImporter),
    createCodexSessionHistoryImporter: vi.fn(() => codexImporter),
    createHermesSessionHistoryImporter: vi.fn(() => hermesImporter)
  };
});

vi.mock('../../src/services/memory-service.js', () => ({
  getDefaultMemoryService: mocks.getDefaultMemoryService,
  getMemoryServiceForProject: mocks.getMemoryServiceForProject
}));

vi.mock('../../src/services/session-history-importer.js', () => ({
  createSessionHistoryImporter: mocks.createSessionHistoryImporter
}));

vi.mock('../../src/services/codex-session-history-importer.js', () => ({
  createCodexSessionHistoryImporter: mocks.createCodexSessionHistoryImporter
}));

vi.mock('../../src/services/hermes-session-history-importer.js', () => ({
  createHermesSessionHistoryImporter: mocks.createHermesSessionHistoryImporter
}));

const { handleToolCall } = await import('../../src/extensions/mcp/handlers.js');
const { tools } = await import('../../src/extensions/mcp/tools.js');

function resetService(service: typeof mocks.defaultService) {
  service.initialize.mockReset().mockResolvedValue(undefined);
  service.retrieveMemories.mockReset().mockResolvedValue({ memories: [] });
  service.getRecentEvents.mockReset().mockResolvedValue([]);
  service.getStats.mockReset().mockResolvedValue({ totalEvents: 0, vectorCount: 0, levelStats: [] });
  service.processPendingEmbeddings.mockReset().mockResolvedValue(0);
}

function resetImporter(importer: typeof mocks.claudeImporter) {
  importer.importProject.mockReset().mockResolvedValue({
    totalSessions: 0,
    totalMessages: 0,
    importedPrompts: 0,
    importedResponses: 0,
    skippedDuplicates: 0,
    errors: []
  });
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
    resetImporter(mocks.claudeImporter);
    resetImporter(mocks.codexImporter);
    resetImporter(mocks.hermesImporter);
    mocks.getDefaultMemoryService.mockClear();
    mocks.getMemoryServiceForProject.mockClear();
    mocks.createSessionHistoryImporter.mockClear();
    mocks.createCodexSessionHistoryImporter.mockClear();
    mocks.createHermesSessionHistoryImporter.mockClear();
  });

  it('advertises context-pack, import-latest, project-timeline, and source-ref tools with projectPath support', () => {
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    for (const name of ['mem-context-pack', 'mem-import-latest', 'mem-project-timeline', 'mem-source-ref']) {
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

  it('imports the latest selected project sessions through a privacy-safe MCP freshness tool', async () => {
    mocks.hermesImporter.importProject.mockResolvedValue({
      totalSessions: 1,
      totalMessages: 4,
      importedPrompts: 2,
      importedResponses: 2,
      skippedDuplicates: 0,
      errors: []
    });
    mocks.codexImporter.importProject.mockResolvedValue({
      totalSessions: 1,
      totalMessages: 3,
      importedPrompts: 1,
      importedResponses: 2,
      skippedDuplicates: 1,
      errors: []
    });
    mocks.projectService.processPendingEmbeddings.mockResolvedValue(5);

    const result = await handleToolCall('mem-import-latest', {
      projectPath: '/repo/app',
      sources: ['hermes', 'codex'],
      sessionLimit: 2,
      messageLimit: 50,
      force: true,
      processEmbeddings: true,
      stateDb: '/tmp/local-hermes-state.db',
      sessionsDir: '/tmp/local-codex-sessions'
    });

    const text = textOf(result);
    expect(result.isError).not.toBe(true);
    expect(mocks.getMemoryServiceForProject).toHaveBeenCalledWith('/repo/app');
    expect(mocks.createHermesSessionHistoryImporter).toHaveBeenCalledWith(mocks.projectService, { stateDbPath: '/tmp/local-hermes-state.db' });
    expect(mocks.createCodexSessionHistoryImporter).toHaveBeenCalledWith(mocks.projectService, { sessionsDir: '/tmp/local-codex-sessions' });
    expect(mocks.hermesImporter.importProject).toHaveBeenCalledWith('/repo/app', {
      projectPath: '/repo/app',
      sessionLimit: 2,
      limit: 50,
      force: true
    });
    expect(mocks.codexImporter.importProject).toHaveBeenCalledWith('/repo/app', {
      projectPath: '/repo/app',
      sessionLimit: 2,
      limit: 50,
      force: true
    });
    expect(mocks.projectService.processPendingEmbeddings).toHaveBeenCalledTimes(1);
    expect(text).toContain('## Latest Session Import');
    expect(text).toContain('- Project: supplied');
    expect(text).not.toContain('app');
    expect(text).toContain('- hermes: sessions=1 messages=4 prompts=2 responses=2 skipped=0 errors=0');
    expect(text).toContain('- codex: sessions=1 messages=3 prompts=1 responses=2 skipped=1 errors=0');
    expect(text).toContain('Embeddings: processed 5');
    expect(text).not.toContain('/tmp/local-hermes-state.db');
    expect(text).not.toContain('/tmp/local-codex-sessions');
  });

  it('rejects mem-import-latest without an absolute projectPath before opening project storage', async () => {
    const result = await handleToolCall('mem-import-latest', {
      projectPath: 'relative/app',
      sources: ['hermes']
    });

    const text = textOf(result);
    expect(result.isError).toBe(true);
    expect(text).toContain('requires an explicit absolute projectPath');
    expect(mocks.getMemoryServiceForProject).not.toHaveBeenCalled();
    expect(mocks.createHermesSessionHistoryImporter).not.toHaveBeenCalled();
  });

  it('fails closed for invalid mem-import-latest sources before importing', async () => {
    const result = await handleToolCall('mem-import-latest', {
      projectPath: '/repo/app',
      sources: ['hermes', 'unknown']
    });

    const text = textOf(result);
    expect(result.isError).toBe(true);
    expect(text).toContain('Invalid source');
    expect(text).not.toContain('unknown');
    expect(mocks.createHermesSessionHistoryImporter).not.toHaveBeenCalled();
    expect(mocks.createCodexSessionHistoryImporter).not.toHaveBeenCalled();
    expect(mocks.createSessionHistoryImporter).not.toHaveBeenCalled();
  });

  it('redacts local paths from mem-import-latest source failures', async () => {
    mocks.hermesImporter.importProject.mockRejectedValue(new Error('failed to open /repo/app/private/state.db and C:\\Users\\me\\secret\\state.db'));

    const result = await handleToolCall('mem-import-latest', {
      projectPath: '/repo/app',
      sources: ['hermes']
    });

    const text = textOf(result);
    expect(result.isError).not.toBe(true);
    expect(text).toContain('- Project: supplied');
    expect(text).toContain('- hermes: failed');
    expect(text).toContain('[path]');
    expect(text).not.toContain('/repo/app');
    expect(text).not.toContain('C:\\Users\\me');
    expect(text).not.toContain('state.db');
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
      topK: 6,
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

  it('prioritizes recent project timeline and suppresses low-signal search noise for generic continuation queries', async () => {
    const mergedPr = event({
      id: '44444444-4444-4444-8444-444444444444',
      sessionId: 'session-latest',
      eventType: 'agent_response',
      timestamp: new Date('2026-05-06T03:00:00.000Z'),
      content: 'Merged CML PR #15 and synced local main; next recommended task is generic context quality hardening.',
      metadata: { source: 'hermes' }
    });
    const genericPrompt = event({
      id: '55555555-5555-4555-8555-555555555555',
      sessionId: 'session-latest',
      timestamp: new Date('2026-05-06T03:01:00.000Z'),
      content: '다음 추천작업은 뭐야?',
      metadata: { source: 'hermes' }
    });
    const unrelatedMemory = event({
      id: '66666666-6666-4666-8666-666666666666',
      sessionId: 'session-old',
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
      content: 'FinRL stock trading experiments should tune Alpha AI Trader replay settings.'
    });
    const crossProjectRecentMemory = event({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      sessionId: 'session-latest',
      eventType: 'agent_response',
      timestamp: new Date('2026-05-06T03:04:00.000Z'),
      content: 'Created Alpha AI Trader specs at /Users/example/workspace/alpha-ai-trader/specs/ai-korea-stock-trader/plan.md.'
    });
    const commandArtifact = event({
      id: '77777777-7777-4777-8777-777777777777',
      sessionId: 'session-latest',
      timestamp: new Date('2026-05-06T02:59:00.000Z'),
      content: '<command-name>/model</command-name>\n<local-command-stdout>Using model opus</local-command-stdout>'
    });
    const environmentContext = event({
      id: '88888888-8888-4888-8888-888888888888',
      sessionId: 'session-latest',
      timestamp: new Date('2026-05-06T02:58:00.000Z'),
      content: '<environment_context><cwd>/repo/app</cwd><shell>zsh</shell></environment_context>'
    });
    const latestCommandArtifact = event({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      sessionId: 'session-latest',
      eventType: 'tool_observation',
      timestamp: new Date('2026-05-06T03:03:00.000Z'),
      content: '<command-name>/model</command-name>\n<local-command-stdout>Using model opus</local-command-stdout>'
    });
    const latestEnvironmentContext = event({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      sessionId: 'session-latest',
      timestamp: new Date('2026-05-06T03:02:00.000Z'),
      content: '<environment_context><cwd>/repo/app</cwd><shell>zsh</shell></environment_context>'
    });

    mocks.projectService.retrieveMemories.mockResolvedValue({
      memories: [
        { event: commandArtifact, score: 0.95 },
        { event: environmentContext, score: 0.9 },
        { event: crossProjectRecentMemory, score: 0.93 },
        { event: unrelatedMemory, score: 0.62 },
        { event: mergedPr, score: 0.61 }
      ]
    });
    mocks.projectService.getRecentEvents.mockResolvedValue([
      latestCommandArtifact,
      latestEnvironmentContext,
      genericPrompt,
      mergedPr
    ]);

    const result = await handleToolCall('mem-context-pack', {
      projectPath: '/repo/app',
      query: '다음 추천작업은 뭐야?',
      topK: 3,
      recentLimit: 10,
      sessionLimit: 2
    });

    const text = textOf(result);
    expect(result.isError).not.toBe(true);
    expect(mocks.projectService.retrieveMemories).toHaveBeenCalledWith('다음 추천작업은 뭐야?', {
      topK: 9,
      sessionId: undefined,
      recordTrace: false
    });
    expect(text).toContain('Generic continuation query: recent project timeline prioritized.');
    expect(text.indexOf('### Recent Project Timeline')).toBeLessThan(text.indexOf('### Relevant Memories'));
    expect(text).toContain('Merged CML PR #15');
    expect(text).not.toContain('FinRL stock trading');
    expect(text).not.toContain('Alpha AI Trader specs');
    expect(text).not.toContain('alpha-ai-trader');
    expect(text).not.toContain('<command-name>');
    expect(text).not.toContain('Using model opus');
    expect(text).not.toContain('<environment_context>');
  });

  it('keeps generic continuation timeline scoped to the latest work block', async () => {
    const newestWork = event({
      id: '81818181-8181-4818-8818-818181818181',
      sessionId: 'session-current',
      eventType: 'agent_response',
      timestamp: new Date('2026-05-06T15:04:00.000Z'),
      content: 'Continue freshness hardening after PR #18; implement latest-work-block timeline pruning.'
    });
    const priorSameDayPublish = event({
      id: '82828282-8282-4828-8828-828282828282',
      sessionId: 'session-publish',
      eventType: 'agent_response',
      timestamp: new Date('2026-05-06T12:26:00.000Z'),
      content: 'Bumped package version and prepared npm publish for claude-memory-layer.'
    });
    const priorSameDayDuckdb = event({
      id: '83838383-8383-4838-8838-838383838383',
      sessionId: 'session-duckdb',
      eventType: 'agent_response',
      timestamp: new Date('2026-05-06T12:27:00.000Z'),
      content: 'Diagnosed an x86_64 versus arm64 DuckDB native module mismatch.'
    });

    mocks.projectService.getRecentEvents.mockResolvedValue([
      newestWork,
      priorSameDayPublish,
      priorSameDayDuckdb
    ]);

    const result = await handleToolCall('mem-context-pack', {
      projectPath: '/repo/app',
      query: '다음 추천작업은 뭐야?',
      topK: 5,
      recentLimit: 10,
      sessionLimit: 5
    });

    const text = textOf(result);
    expect(result.isError).not.toBe(true);
    expect(text).toContain('- Recent sessions shown: 1');
    expect(text).toContain('latest-work-block timeline pruning');
    expect(text).not.toContain('npm publish');
    expect(text).not.toContain('DuckDB native module mismatch');
  });

  it('keeps generic continuation relevant memories sparse and high-confidence', async () => {
    const timelineNow = event({
      id: '12121212-1212-4212-8212-121212121212',
      sessionId: 'session-current',
      eventType: 'agent_response',
      timestamp: new Date('2026-05-06T04:00:00.000Z'),
      content: 'Merged CML PR #17 and reloaded the MCP server; next implementation focus is freshness-aware context filtering.'
    });
    const weakRecentPublish = event({
      id: '23232323-2323-4232-8232-232323232323',
      sessionId: 'session-publish',
      eventType: 'agent_response',
      timestamp: new Date('2026-05-05T12:26:00.000Z'),
      content: 'Bumped package version and prepared npm publish for claude-memory-layer.'
    });
    const weakRecentDuckdb = event({
      id: '34343434-3434-4343-8343-343434343434',
      sessionId: 'session-duckdb',
      eventType: 'agent_response',
      timestamp: new Date('2026-05-05T12:27:00.000Z'),
      content: 'Diagnosed an x86_64 versus arm64 DuckDB native module mismatch.'
    });
    const strongFreshnessPlan = event({
      id: '45454545-4545-4545-8545-454545454545',
      sessionId: 'session-current',
      eventType: 'agent_response',
      timestamp: new Date('2026-05-06T04:01:00.000Z'),
      content: 'Freshness filter design: for generic continuation prompts, suppress weak semantic memories and rely on recent project timeline first.'
    });
    const strongPrState = event({
      id: '56565656-5656-4565-8565-565656565656',
      sessionId: 'session-current',
      eventType: 'session_summary',
      timestamp: new Date('2026-05-06T04:02:00.000Z'),
      content: 'Current CML state: PR #17 merged, main synced, MCP runtime reloaded; continue with freshness-aware relevance filtering.'
    });
    const staleContinuationHandoff = event({
      id: '78787878-7878-4787-8787-787878787878',
      sessionId: 'session-old-handoff',
      eventType: 'agent_response',
      timestamp: new Date('2026-05-04T15:10:00.000Z'),
      content: 'Understood, stopping here. Let me know when you would like to continue with the design doc review and edits.'
    });
    const extraStrongButLowerPriority = event({
      id: '67676767-6767-4676-8676-676767676767',
      sessionId: 'session-current',
      eventType: 'agent_response',
      timestamp: new Date('2026-05-06T04:03:00.000Z'),
      content: 'Additional implementation note that should be omitted because generic continuation relevant memories are capped.'
    });

    mocks.projectService.retrieveMemories.mockResolvedValue({
      memories: [
        { event: staleContinuationHandoff, score: 0.99 },
        { event: weakRecentPublish, score: 0.62 },
        { event: strongFreshnessPlan, score: 0.82 },
        { event: strongPrState, score: 0.8 },
        { event: extraStrongButLowerPriority, score: 0.77 },
        { event: weakRecentDuckdb, score: 0.6 }
      ]
    });
    mocks.projectService.getRecentEvents.mockResolvedValue([
      timelineNow,
      weakRecentPublish,
      weakRecentDuckdb
    ]);

    const result = await handleToolCall('mem-context-pack', {
      projectPath: '/repo/app',
      query: 'continue',
      topK: 5,
      recentLimit: 10,
      sessionLimit: 3
    });

    const text = textOf(result);
    expect(result.isError).not.toBe(true);
    expect(mocks.projectService.retrieveMemories).toHaveBeenCalledWith('continue', {
      topK: 12,
      sessionId: undefined,
      recordTrace: false
    });
    expect(text).toContain('- Relevant memories: 2');
    expect(text).toContain('Freshness filter design');
    expect(text).toContain('Current CML state: PR #17 merged');
    expect(text).not.toContain('Bumped package version');
    expect(text).not.toContain('DuckDB native module mismatch');
    expect(text).not.toContain('Additional implementation note');
    expect(text).not.toContain('stopping here');
    expect(text).not.toContain('design doc review');
  });

  it('keeps non-generic context-pack ordering while suppressing low-signal artifacts', async () => {
    const commandArtifact = event({
      id: '99999999-9999-4999-8999-999999999999',
      sessionId: 'session-debug',
      timestamp: new Date('2026-05-06T02:59:00.000Z'),
      content: '<command-name>/model</command-name>\n<local-command-stdout>Using model opus</local-command-stdout>'
    });
    const agentsDump = event({
      id: '99999999-9999-4999-8999-999999999998',
      sessionId: 'session-debug',
      timestamp: new Date('2026-05-06T02:58:00.000Z'),
      content: '# AGENTS.md instructions for /repo/app <INSTRUCTIONS> ## Skills A skill is a set of local instructions.'
    });
    const relevantDebug = event({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sessionId: 'session-debug',
      timestamp: new Date('2026-05-06T03:00:00.000Z'),
      content: 'Investigated MCP context-pack retrieval ranking for a topic-specific debug query.'
    });
    const crossProjectTimeline = event({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      sessionId: 'session-debug',
      eventType: 'agent_response',
      timestamp: new Date('2026-05-06T03:01:00.000Z'),
      content: 'Created Alpha AI Trader specs at /Users/example/workspace/alpha-ai-trader/specs/ai-korea-stock-trader/plan.md.'
    });

    mocks.projectService.retrieveMemories.mockResolvedValue({
      memories: [
        { event: commandArtifact, score: 0.95 },
        { event: agentsDump, score: 0.9 },
        { event: relevantDebug, score: 0.8 }
      ]
    });
    mocks.projectService.getRecentEvents.mockResolvedValue([
      commandArtifact,
      agentsDump,
      crossProjectTimeline,
      relevantDebug
    ]);

    const result = await handleToolCall('mem-context-pack', {
      projectPath: '/repo/app',
      query: 'debug command artifact retrieval quality',
      topK: 2,
      recentLimit: 10,
      sessionLimit: 2
    });

    const text = textOf(result);
    expect(result.isError).not.toBe(true);
    expect(mocks.projectService.retrieveMemories).toHaveBeenCalledWith('debug command artifact retrieval quality', {
      topK: 6,
      sessionId: undefined,
      recordTrace: false
    });
    expect(text).not.toContain('Generic continuation query');
    expect(text.indexOf('### Relevant Memories')).toBeLessThan(text.indexOf('### Recent Project Timeline'));
    expect(text).toContain('Investigated MCP context-pack retrieval ranking');
    expect(text).not.toContain('<command-name>');
    expect(text).not.toContain('Using model opus');
    expect(text).not.toContain('AGENTS.md instructions');
    expect(text).not.toContain('<INSTRUCTIONS>');
    expect(text).not.toContain('Alpha AI Trader specs');
    expect(text).not.toContain('alpha-ai-trader');
  });

  it('redacts credential-bearing connection strings from context-pack previews', async () => {
    const credentialUri = [
      'mongodb://',
      'fixture-user',
      ':',
      'fixture-credential',
      '@',
      'db.example.test:27017/admin?authSource=admin'
    ].join('');
    const sensitiveConnection = event({
      id: 'connection-redaction-1',
      timestamp: new Date('2026-05-05T01:30:00.000Z'),
      content: `Run mongo sync with --mongo-uri ${credentialUri} before checking status.`
    });

    mocks.projectService.retrieveMemories.mockResolvedValue({
      memories: [{ event: sensitiveConnection, score: 0.9 }]
    });
    mocks.projectService.getRecentEvents.mockResolvedValue([sensitiveConnection]);

    const result = await handleToolCall('mem-context-pack', {
      projectPath: '/repo/app',
      query: 'mongo sync status',
      topK: 1,
      recentLimit: 1,
      sessionLimit: 1
    });

    const text = textOf(result);
    expect(result.isError).not.toBe(true);
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('fixture-user');
    expect(text).not.toContain('fixture-credential');
    expect(text).not.toContain('mongodb://');
    expect(text).not.toContain('db.example.test');
    expect(text).not.toContain('authSource=admin');
  });

  it('redacts password-only credential URLs from context-pack previews', async () => {
    const passwordOnlyUri = [
      'redis://',
      ':',
      'fixture-credential',
      '@',
      'cache.example.test:6379/0'
    ].join('');
    const sensitiveConnection = event({
      id: 'connection-redaction-2',
      timestamp: new Date('2026-05-05T01:45:00.000Z'),
      content: `Check queue health with ${passwordOnlyUri} before retrying workers.`
    });

    mocks.projectService.retrieveMemories.mockResolvedValue({
      memories: [{ event: sensitiveConnection, score: 0.89 }]
    });
    mocks.projectService.getRecentEvents.mockResolvedValue([sensitiveConnection]);

    const result = await handleToolCall('mem-context-pack', {
      projectPath: '/repo/app',
      query: 'queue health workers',
      topK: 1,
      recentLimit: 1,
      sessionLimit: 1
    });

    const text = textOf(result);
    expect(result.isError).not.toBe(true);
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('fixture-credential');
    expect(text).not.toContain('redis://');
    expect(text).not.toContain('cache.example.test');
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
