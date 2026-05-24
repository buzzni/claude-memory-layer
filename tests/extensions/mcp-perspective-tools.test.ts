import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryEvent } from '../../src/core/types.js';

const mocks = vi.hoisted(() => {
  const fakeDb = { kind: 'fake-db' };
  const sqliteInstances: Array<{
    dbPath: string;
    options: Record<string, unknown>;
    initialize: ReturnType<typeof vi.fn>;
    getDatabase: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];

  const SQLiteEventStore = vi.fn((dbPath: string, options: Record<string, unknown>) => {
    const instance = {
      dbPath,
      options,
      initialize: vi.fn(async () => undefined),
      getDatabase: vi.fn(() => fakeDb),
      close: vi.fn(async () => undefined)
    };
    sqliteInstances.push(instance);
    return instance;
  });

  function createService() {
    return {
      initialize: vi.fn(async () => undefined),
      retrieveMemories: vi.fn(),
      keywordSearch: vi.fn(),
      getRecentEvents: vi.fn(),
      getSessionHistory: vi.fn(),
      getStats: vi.fn(),
      processPendingEmbeddings: vi.fn()
    };
  }

  const defaultService = createService();
  const projectService = createService();

  const actorRepository = { list: vi.fn(), upsert: vi.fn(), get: vi.fn() };
  const actorCardRepository = { get: vi.fn(), upsert: vi.fn() };
  const perspectiveObservationRepository = { query: vi.fn(), create: vi.fn(), deleteSoft: vi.fn() };

  const noopRepository = { query: vi.fn(), assign: vi.fn(), list: vi.fn(), update: vi.fn(), create: vi.fn(), rank: vi.fn(), expand: vi.fn(), extract: vi.fn() };

  return {
    fakeDb,
    sqliteInstances,
    SQLiteEventStore,
    defaultService,
    projectService,
    getDefaultMemoryService: vi.fn(() => defaultService),
    getMemoryServiceForProject: vi.fn(() => projectService),
    hashProjectPath: vi.fn(() => 'deadbeef'),
    getProjectStoragePath: vi.fn(() => '/tmp/cml-project-store'),
    actorRepository,
    actorCardRepository,
    perspectiveObservationRepository,
    ActorRepository: vi.fn(() => actorRepository),
    ActorCardRepository: vi.fn(() => actorCardRepository),
    PerspectiveObservationRepository: vi.fn(() => perspectiveObservationRepository),
    FacetRepository: vi.fn(() => noopRepository),
    ActionRepository: vi.fn(() => noopRepository),
    FrontierService: vi.fn(() => noopRepository),
    CheckpointRepository: vi.fn(() => noopRepository),
    LessonRepository: vi.fn(() => noopRepository),
    GraphPathService: vi.fn(() => noopRepository),
    QueryEntityExtractor: vi.fn(() => noopRepository),
    runRetentionAudit: vi.fn()
  };
});

vi.mock('../../src/services/memory-service.js', () => ({
  getDefaultMemoryService: mocks.getDefaultMemoryService,
  getMemoryServiceForProject: mocks.getMemoryServiceForProject
}));

vi.mock('../../src/core/registry/project-path.js', () => ({
  hashProjectPath: mocks.hashProjectPath,
  getProjectStoragePath: mocks.getProjectStoragePath
}));

vi.mock('../../src/core/sqlite-event-store.js', () => ({
  SQLiteEventStore: mocks.SQLiteEventStore
}));

vi.mock('../../src/core/operations/index.js', () => ({
  ActorRepository: mocks.ActorRepository,
  ActorCardRepository: mocks.ActorCardRepository,
  PerspectiveObservationRepository: mocks.PerspectiveObservationRepository,
  FacetRepository: mocks.FacetRepository,
  ActionRepository: mocks.ActionRepository,
  FrontierService: mocks.FrontierService,
  CheckpointRepository: mocks.CheckpointRepository,
  LessonRepository: mocks.LessonRepository,
  GraphPathService: mocks.GraphPathService,
  QueryEntityExtractor: mocks.QueryEntityExtractor,
  RETENTION_POLICY_VERSION: 'retention-policy.v1',
  runRetentionAudit: mocks.runRetentionAudit
}));

const { tools } = await import('../../src/extensions/mcp/tools.js');
const { handleToolCall } = await import('../../src/extensions/mcp/handlers.js');

function event(overrides: Partial<MemoryEvent>): MemoryEvent {
  return {
    id: 'event-1',
    eventType: 'user_prompt',
    sessionId: 'session-1',
    timestamp: new Date('2026-05-10T00:00:00.000Z'),
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

function jsonOf(result: Awaited<ReturnType<typeof handleToolCall>>): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

function toolByName(name: string) {
  return tools.find((tool) => tool.name === name);
}

function propertiesFor(name: string): Record<string, unknown> {
  const tool = toolByName(name);
  expect(tool, `${name} should be registered`).toBeDefined();
  expect(tool?.inputSchema).toMatchObject({ type: 'object' });
  return tool?.inputSchema.properties as Record<string, unknown>;
}

function requiredFor(name: string): string[] {
  return (toolByName(name)?.inputSchema.required as string[] | undefined) ?? [];
}

function anyOfFor(name: string): Array<{ required?: string[] }> {
  return (toolByName(name)?.inputSchema.anyOf as Array<{ required?: string[] }> | undefined) ?? [];
}

function expectsEitherTargetAlias(name: string) {
  expect(anyOfFor(name)).toEqual(expect.arrayContaining([
    expect.objectContaining({ required: ['targetActorId'] }),
    expect.objectContaining({ required: ['observedActorId'] })
  ]));
}

function resetMocks() {
  mocks.sqliteInstances.length = 0;
  mocks.SQLiteEventStore.mockClear();
  mocks.getDefaultMemoryService.mockClear();
  mocks.getMemoryServiceForProject.mockClear();
  mocks.hashProjectPath.mockClear().mockReturnValue('deadbeef');
  mocks.getProjectStoragePath.mockClear().mockReturnValue('/tmp/cml-project-store');
  mocks.defaultService.initialize.mockReset().mockResolvedValue(undefined);
  mocks.projectService.initialize.mockReset().mockResolvedValue(undefined);
  mocks.projectService.retrieveMemories.mockReset().mockResolvedValue({ memories: [] });
  mocks.projectService.keywordSearch.mockReset().mockResolvedValue([]);
  mocks.projectService.getRecentEvents.mockReset().mockResolvedValue([]);
  mocks.projectService.getSessionHistory.mockReset().mockResolvedValue([]);
  mocks.projectService.getStats.mockReset().mockResolvedValue({ totalEvents: 0, vectorCount: 0, levelStats: [] });
  mocks.projectService.processPendingEmbeddings.mockReset().mockResolvedValue(0);

  mocks.ActorRepository.mockClear();
  mocks.ActorCardRepository.mockClear();
  mocks.PerspectiveObservationRepository.mockClear();

  mocks.actorRepository.list.mockReset().mockResolvedValue([
    {
      actorId: 'actor:user',
      projectHash: 'deadbeef',
      kind: 'user',
      displayName: '전하',
      source: 'discord',
      metadata: {},
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      updatedAt: new Date('2026-05-01T00:00:00.000Z')
    }
  ]);
  mocks.actorRepository.upsert.mockReset();
  mocks.actorRepository.get.mockReset();

  mocks.actorCardRepository.get.mockReset().mockResolvedValue({
    cardId: '33333333-3333-4333-8333-333333333333',
    projectHash: 'deadbeef',
    observerActorId: 'actor:assistant',
    observedActorId: 'actor:user',
    entries: ['IDENTITY: Founder', 'ATTRIBUTE: Prefers Korean updates'],
    sourceEventIds: ['event-1'],
    updatedBy: 'hermes-agent',
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-02T00:00:00.000Z')
  });
  mocks.actorCardRepository.upsert.mockReset().mockResolvedValue({
    cardId: '33333333-3333-4333-8333-333333333333',
    projectHash: 'deadbeef',
    observerActorId: 'actor:assistant',
    observedActorId: 'actor:user',
    entries: ['ATTRIBUTE: Prefers concise Korean updates'],
    sourceEventIds: ['event-1'],
    updatedBy: 'hermes-agent',
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-03T00:00:00.000Z')
  });

  mocks.perspectiveObservationRepository.query.mockReset().mockResolvedValue([
    {
      observationId: '44444444-4444-4444-8444-444444444444',
      projectHash: 'deadbeef',
      observerActorId: 'actor:assistant',
      observedActorId: 'actor:user',
      sessionId: 'session-1',
      level: 'explicit',
      content: 'User asked for concise Korean status updates.',
      confidence: 0.95,
      sourceEventIds: ['event-1'],
      sourceObservationIds: [],
      createdBy: 'manual',
      metadata: {},
      createdAt: new Date('2026-05-02T00:00:00.000Z'),
      updatedAt: new Date('2026-05-02T00:00:00.000Z')
    },
    {
      observationId: '55555555-5555-4555-8555-555555555555',
      projectHash: 'deadbeef',
      observerActorId: 'actor:assistant',
      observedActorId: 'actor:user',
      level: 'deductive',
      content: 'Keep implementation reports short and action-oriented.',
      confidence: 0.82,
      sourceEventIds: ['event-1'],
      sourceObservationIds: ['44444444-4444-4444-8444-444444444444'],
      createdBy: 'llm',
      metadata: {},
      createdAt: new Date('2026-05-03T00:00:00.000Z'),
      updatedAt: new Date('2026-05-03T00:00:00.000Z')
    }
  ]);
  mocks.perspectiveObservationRepository.create.mockReset().mockResolvedValue({
    observationId: '44444444-4444-4444-8444-444444444444',
    projectHash: 'deadbeef',
    observerActorId: 'actor:assistant',
    observedActorId: 'actor:user',
    sessionId: 'session-1',
    level: 'explicit',
    content: 'User prefers concise Korean updates.',
    confidence: 0.9,
    sourceEventIds: ['event-1'],
    sourceObservationIds: [],
    createdBy: 'manual',
    metadata: {},
    createdAt: new Date('2026-05-02T00:00:00.000Z'),
    updatedAt: new Date('2026-05-02T00:00:00.000Z')
  });
  mocks.perspectiveObservationRepository.deleteSoft.mockReset().mockResolvedValue({
    observationId: '44444444-4444-4444-8444-444444444444',
    projectHash: 'deadbeef',
    observerActorId: 'actor:assistant',
    observedActorId: 'actor:user',
    level: 'explicit',
    content: 'User prefers concise Korean updates.',
    confidence: 0.9,
    sourceEventIds: ['event-1'],
    sourceObservationIds: [],
    createdBy: 'manual',
    createdAt: new Date('2026-05-02T00:00:00.000Z'),
    updatedAt: new Date('2026-05-04T00:00:00.000Z'),
    deletedAt: new Date('2026-05-04T00:00:00.000Z')
  });
}

describe('MCP perspective memory tool definitions', () => {
  it('advertises perspective context-pack options and privacy-safe operation tools', () => {
    const contextPack = propertiesFor('mem-context-pack');
    expect(contextPack.observerActorId).toMatchObject({ type: 'string' });
    expect(contextPack.targetActorId).toMatchObject({ type: 'string' });
    expect(contextPack.observedActorId).toMatchObject({ type: 'string' });
    expect(contextPack.includeActorCard).toMatchObject({ type: 'boolean' });
    expect(contextPack.includePerspectiveObservations).toMatchObject({ type: 'boolean' });
    expect(contextPack.limitToSession).toMatchObject({ type: 'boolean' });
    expect(contextPack.reasoningLevel).toMatchObject({ type: 'string', enum: ['minimal', 'low', 'medium', 'high'] });

    for (const name of [
      'mem-actor-list',
      'mem-actor-card-get',
      'mem-perspective-query',
      'mem-perspective-context',
      'mem-actor-card-upsert',
      'mem-perspective-observation-create',
      'mem-perspective-observation-delete'
    ]) {
      expect(tools.filter((tool) => tool.name === name)).toHaveLength(1);
      expect(propertiesFor(name).projectPath).toMatchObject({ type: 'string' });
      expect(requiredFor(name)).toContain('projectPath');
    }

    expect(requiredFor('mem-actor-card-get')).toEqual(expect.arrayContaining(['projectPath', 'observerActorId']));
    expect(propertiesFor('mem-actor-card-get').targetActorId).toMatchObject({ type: 'string' });
    expectsEitherTargetAlias('mem-actor-card-get');
    expect(requiredFor('mem-perspective-context')).toEqual(expect.arrayContaining(['projectPath', 'observerActorId']));
    expect(propertiesFor('mem-perspective-context').observedActorId).toMatchObject({ type: 'string' });
    expectsEitherTargetAlias('mem-perspective-context');
    expect(requiredFor('mem-actor-card-upsert')).toEqual(expect.arrayContaining(['projectPath', 'observerActorId', 'entries', 'actor']));
    expect(propertiesFor('mem-actor-card-upsert').targetActorId).toMatchObject({ type: 'string' });
    expectsEitherTargetAlias('mem-actor-card-upsert');
    expect(requiredFor('mem-perspective-observation-create')).toEqual(expect.arrayContaining(['projectPath', 'observerActorId', 'content', 'actor']));
    expect(propertiesFor('mem-perspective-observation-create').targetActorId).toMatchObject({ type: 'string' });
    expectsEitherTargetAlias('mem-perspective-observation-create');
    expect(requiredFor('mem-perspective-observation-delete')).toEqual(expect.arrayContaining(['projectPath', 'observationId', 'actor']));
  });
});

describe('MCP perspective memory handlers', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('queries perspective observations through the project store with observer/target/session filters', async () => {
    const result = await handleToolCall('mem-perspective-query', {
      projectPath: '/repo/app',
      observerActorId: 'actor:assistant',
      targetActorId: 'actor:user',
      sessionId: 'session-1',
      levels: ['explicit', 'deductive'],
      query: 'concise Korean',
      limit: 3
    });

    const payload = jsonOf(result);
    expect(result.isError).not.toBe(true);
    expect(mocks.SQLiteEventStore).toHaveBeenCalledWith('/tmp/cml-project-store/events.sqlite', expect.objectContaining({ readonly: false }));
    expect(mocks.PerspectiveObservationRepository).toHaveBeenCalledWith(mocks.fakeDb);
    expect(mocks.perspectiveObservationRepository.query).toHaveBeenCalledWith({
      projectHash: 'deadbeef',
      observerActorId: 'actor:assistant',
      observedActorId: 'actor:user',
      sessionId: 'session-1',
      levels: ['explicit', 'deductive'],
      query: 'concise Korean',
      limit: 3
    });
    expect(mocks.sqliteInstances[0].close).toHaveBeenCalledTimes(1);
    expect(payload).toMatchObject({ operation: 'mem-perspective-query', projectHash: 'deadbeef', count: 2 });
    expect(JSON.stringify(payload)).toContain('mem-source-ref');
    expect(JSON.stringify(payload)).not.toContain('/repo/app');
  });

  it('routes mutating perspective tools with actor audit fields and sanitized persisted content', async () => {
    const createResult = await handleToolCall('mem-perspective-observation-create', {
      projectPath: '/repo/app',
      observerActorId: 'actor:assistant',
      observedActorId: 'actor:user',
      sessionId: 'session-1',
      level: 'explicit',
      content: 'User prefers concise Korean updates from /repo/app token=dk.',
      confidence: 0.9,
      sourceEventIds: Array.from({ length: 30 }, (_value, index) => `event-${index}`),
      actor: 'hermes-agent'
    });

    expect(createResult.isError).not.toBe(true);
    expect(mocks.perspectiveObservationRepository.create).toHaveBeenCalledWith(expect.objectContaining({
      projectHash: 'deadbeef',
      observerActorId: 'actor:assistant',
      observedActorId: 'actor:user',
      sessionId: 'session-1',
      level: 'explicit',
      confidence: 0.9,
      sourceEventIds: Array.from({ length: 20 }, (_value, index) => `event-${index}`),
      actor: 'hermes-agent',
      createdBy: 'manual'
    }));
    const persisted = mocks.perspectiveObservationRepository.create.mock.calls[0][0];
    expect(persisted.content).toContain('[path]');
    expect(persisted.content).not.toContain('/repo/app');
    expect(persisted.content).not.toContain('token=dk');
    expect(textOf(createResult)).not.toContain('/repo/app');
    expect(textOf(createResult)).not.toContain('token=dk');

    const upsertResult = await handleToolCall('mem-actor-card-upsert', {
      projectPath: '/repo/app',
      observerActorId: 'actor:assistant',
      observedActorId: 'actor:user',
      entries: ['ATTRIBUTE: Prefers concise Korean updates'],
      sourceEventIds: ['event-1'],
      actor: 'hermes-agent'
    });

    expect(upsertResult.isError).not.toBe(true);
    expect(mocks.actorCardRepository.upsert).toHaveBeenCalledWith({
      projectHash: 'deadbeef',
      observerActorId: 'actor:assistant',
      observedActorId: 'actor:user',
      entries: ['ATTRIBUTE: Prefers concise Korean updates'],
      sourceEventIds: ['event-1'],
      updatedBy: 'hermes-agent'
    });
  });

  it('rejects unscoped or invalid mutating perspective requests before persistence', async () => {
    const unscoped = await handleToolCall('mem-perspective-observation-create', {
      observerActorId: 'actor:assistant',
      observedActorId: 'actor:user',
      content: 'User prefers TDD.',
      sourceEventIds: ['event-1'],
      actor: 'hermes-agent'
    });
    const invalidCard = await handleToolCall('mem-actor-card-upsert', {
      projectPath: '/repo/app',
      observerActorId: 'actor:assistant',
      observedActorId: 'actor:user',
      entries: ['BADPREFIX: should fail'],
      sourceEventIds: ['event-1'],
      actor: 'hermes-agent'
    });

    expect(unscoped.isError).toBe(true);
    expect(textOf(unscoped)).toContain('projectPath');
    expect(invalidCard.isError).toBe(true);
    expect(mocks.perspectiveObservationRepository.create).not.toHaveBeenCalled();
    expect(mocks.actorCardRepository.upsert).not.toHaveBeenCalled();
  });

  it('adds a separate perspective lane to context-pack only when perspective options are supplied', async () => {
    mocks.projectService.retrieveMemories.mockResolvedValue({
      memories: [{
        event: event({ id: 'event-1', content: 'Continue the perspective memory work.', metadata: { sourceAgent: 'hermes' } }),
        score: 0.91
      }]
    });
    mocks.projectService.getRecentEvents.mockResolvedValue([
      event({ id: 'event-1', sessionId: 'session-1', content: 'Continue the perspective memory work.', metadata: { projectPath: '/repo/app', projectHash: 'deadbeef', sourceAgent: 'hermes' } })
    ]);

    const baseline = await handleToolCall('mem-context-pack', {
      projectPath: '/repo/app',
      query: 'perspective memory',
      topK: 2,
      sessionId: 'session-1'
    });
    expect(textOf(baseline)).not.toContain('### Perspective Context');
    expect(mocks.ActorCardRepository).not.toHaveBeenCalled();
    expect(mocks.PerspectiveObservationRepository).not.toHaveBeenCalled();

    resetMocks();
    mocks.projectService.retrieveMemories.mockResolvedValue({
      memories: [{
        event: event({ id: 'event-1', content: 'Continue the perspective memory work.', metadata: { sourceAgent: 'hermes' } }),
        score: 0.91
      }]
    });
    mocks.projectService.getRecentEvents.mockResolvedValue([
      event({ id: 'event-1', sessionId: 'session-1', content: 'Continue the perspective memory work.', metadata: { projectPath: '/repo/app', projectHash: 'deadbeef', sourceAgent: 'hermes' } })
    ]);

    const result = await handleToolCall('mem-context-pack', {
      projectPath: '/repo/app',
      query: 'perspective memory',
      topK: 2,
      sessionId: 'session-1',
      observerActorId: 'actor:assistant',
      targetActorId: 'actor:user',
      includeActorCard: true,
      includePerspectiveObservations: true,
      limitToSession: true,
      reasoningLevel: 'medium'
    });

    const text = textOf(result);
    expect(result.isError).not.toBe(true);
    expect(mocks.actorCardRepository.get).toHaveBeenCalledWith({
      projectHash: 'deadbeef',
      observerActorId: 'actor:assistant',
      observedActorId: 'actor:user'
    });
    expect(mocks.perspectiveObservationRepository.query).toHaveBeenCalledWith({
      projectHash: 'deadbeef',
      observerActorId: 'actor:assistant',
      observedActorId: 'actor:user',
      sessionId: 'session-1',
      query: 'perspective memory',
      limit: 12
    });
    expect(text).toContain('### Perspective Context');
    expect(text).toContain('Continue the perspective memory work.');
    expect(text).toContain('Perspective Retrieval Lanes');
    expect(text).toContain('actor_card=1');
    expect(text).toContain('explicit_observations=1');
    expect(text).toContain('derived_observations=1');
    expect(text).toContain('contradiction_observations=0');
    expect(text).toContain('Actor Card');
    expect(text).toContain('[actor_card] ATTRIBUTE: Prefers Korean updates');
    expect(text).toContain('Explicit observations:');
    expect(text).toContain('[perspective:explicit 0.95]');
    expect(text).toContain('Derived observations:');
    expect(text).toContain('[perspective:deductive 0.82]');
    expect(text).toContain('mem-source-ref');
    expect(text).not.toContain('/repo/app');
  });

  it('returns project memories even when actor perspective context loading fails', async () => {
    const survivorMemory = event({
      id: 'event-survivor',
      content: 'Project memory should survive perspective repository failure.',
      metadata: { sourceAgent: 'hermes' }
    });
    mocks.projectService.retrieveMemories.mockResolvedValue({
      memories: [{ event: survivorMemory, score: 0.93 }]
    });
    mocks.projectService.getRecentEvents.mockResolvedValue([
      event({
        id: 'event-recent',
        sessionId: 'session-1',
        content: 'Recent project checkpoint still appears.',
        metadata: { projectPath: '/repo/app', projectHash: 'deadbeef', sourceAgent: 'hermes' }
      })
    ]);
    const secretKey = ['api', 'token'].join('_');
    const secretValue = ['fixture', 'secret', 'value'].join('-');
    mocks.actorCardRepository.get.mockRejectedValue(new Error(`perspective sqlite failure at /repo/app/events.sqlite ${secretKey}=${secretValue}`));

    const result = await handleToolCall('mem-context-pack', {
      projectPath: '/repo/app',
      query: 'perspective memory',
      topK: 2,
      sessionId: 'session-1',
      observerActorId: 'actor:assistant',
      targetActorId: 'actor:user',
      includeActorCard: true,
      includePerspectiveObservations: true
    });

    const text = textOf(result);
    expect(result.isError).not.toBe(true);
    expect(text).toContain('Project memory should survive perspective repository failure.');
    expect(text).toContain('Warning: perspective context unavailable');
    expect(text).not.toContain('/repo/app');
    expect(text).not.toContain(secretValue);
    expect(text).not.toContain(`${secretKey}=${secretValue}`);
    expect(mocks.sqliteInstances[0].close).toHaveBeenCalledTimes(1);
  });

  it('keeps no-perspective context-pack output unchanged when perspective lanes are explicitly disabled', async () => {
    const projectMemory = event({
      id: 'event-project',
      content: 'No perspective disabled toggles should change this memory.',
      metadata: { sourceAgent: 'hermes' }
    });
    const recent = event({
      id: 'event-recent',
      sessionId: 'session-1',
      content: 'No perspective disabled toggles should change this timeline.',
      metadata: { projectPath: '/repo/app', projectHash: 'deadbeef', sourceAgent: 'hermes' }
    });
    mocks.projectService.retrieveMemories.mockResolvedValue({
      memories: [{ event: projectMemory, score: 0.91 }]
    });
    mocks.projectService.getRecentEvents.mockResolvedValue([recent]);

    const baseline = await handleToolCall('mem-context-pack', {
      projectPath: '/repo/app',
      query: 'plain project memory',
      topK: 2,
      sessionId: 'session-1'
    });

    resetMocks();
    mocks.projectService.retrieveMemories.mockResolvedValue({
      memories: [{ event: projectMemory, score: 0.91 }]
    });
    mocks.projectService.getRecentEvents.mockResolvedValue([recent]);

    const disabled = await handleToolCall('mem-context-pack', {
      projectPath: '/repo/app',
      query: 'plain project memory',
      topK: 2,
      sessionId: 'session-1',
      includeActorCard: false,
      includePerspectiveObservations: false
    });

    expect(disabled.isError).not.toBe(true);
    expect(textOf(disabled)).toEqual(textOf(baseline));
    expect(mocks.ActorCardRepository).not.toHaveBeenCalled();
    expect(mocks.PerspectiveObservationRepository).not.toHaveBeenCalled();
  });

  it('rejects perspective context-pack args before resolving any memory service or store when scope is invalid', async () => {
    const missingProjectPath = await handleToolCall('mem-context-pack', {
      query: 'perspective memory',
      observerActorId: 'actor:assistant',
      targetActorId: 'actor:user'
    });

    expect(missingProjectPath.isError).toBe(true);
    expect(textOf(missingProjectPath)).toContain('projectPath');
    expect(mocks.getDefaultMemoryService).not.toHaveBeenCalled();
    expect(mocks.getMemoryServiceForProject).not.toHaveBeenCalled();
    expect(mocks.SQLiteEventStore).not.toHaveBeenCalled();
    expect(mocks.projectService.retrieveMemories).not.toHaveBeenCalled();
    expect(mocks.projectService.getRecentEvents).not.toHaveBeenCalled();

    resetMocks();
    const missingTarget = await handleToolCall('mem-context-pack', {
      projectPath: '/repo/app',
      query: 'perspective memory',
      observerActorId: 'actor:assistant',
      includeActorCard: true
    });

    expect(missingTarget.isError).toBe(true);
    expect(textOf(missingTarget)).toContain('targetActorId');
    expect(mocks.getDefaultMemoryService).not.toHaveBeenCalled();
    expect(mocks.getMemoryServiceForProject).not.toHaveBeenCalled();
    expect(mocks.SQLiteEventStore).not.toHaveBeenCalled();
  });

  it('rejects malformed supplied perspective context-pack args before memory access', async () => {
    const malformedActor = await handleToolCall('mem-context-pack', {
      projectPath: '/repo/app',
      query: 'perspective memory',
      observerActorId: 123,
      targetActorId: 'actor:user'
    });
    const malformedToggle = await handleToolCall('mem-context-pack', {
      projectPath: '/repo/app',
      query: 'perspective memory',
      includeActorCard: 'yes'
    });

    expect(malformedActor.isError).toBe(true);
    expect(textOf(malformedActor)).toContain('observerActorId');
    expect(malformedToggle.isError).toBe(true);
    expect(textOf(malformedToggle)).toContain('observerActorId');
    expect(mocks.getDefaultMemoryService).not.toHaveBeenCalled();
    expect(mocks.getMemoryServiceForProject).not.toHaveBeenCalled();
    expect(mocks.SQLiteEventStore).not.toHaveBeenCalled();
  });

  it('degrades gracefully when perspective context has no card or observations', async () => {
    mocks.projectService.retrieveMemories.mockResolvedValue({ memories: [] });
    mocks.projectService.getRecentEvents.mockResolvedValue([]);
    mocks.actorCardRepository.get.mockResolvedValue(null);
    mocks.perspectiveObservationRepository.query.mockResolvedValue([]);

    const result = await handleToolCall('mem-context-pack', {
      projectPath: '/repo/app',
      query: 'new actor',
      observerActorId: 'actor:assistant',
      targetActorId: 'actor:new-user',
      includeActorCard: true,
      includePerspectiveObservations: true,
      limitToSession: true,
      sessionId: 'session-empty'
    });

    const text = textOf(result);
    expect(result.isError).not.toBe(true);
    expect(text).toContain('### Perspective Context');
    expect(text).toContain('No actor card or perspective observations found.');
    expect(mocks.perspectiveObservationRepository.query).toHaveBeenCalledWith({
      projectHash: 'deadbeef',
      observerActorId: 'actor:assistant',
      observedActorId: 'actor:new-user',
      sessionId: 'session-empty',
      query: 'new actor',
      limit: 12
    });
  });
});
