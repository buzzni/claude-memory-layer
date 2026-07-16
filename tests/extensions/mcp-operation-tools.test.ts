import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const fakeDb = { kind: 'fake-db' };
  const sqliteInstances: Array<{
    dbPath: string;
    options: Record<string, unknown>;
    initialize: ReturnType<typeof vi.fn>;
    getDatabase: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];

  const SQLiteEventStore = vi.fn(function SQLiteEventStoreMock(dbPath: string, options: Record<string, unknown>) {
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
    return { initialize: vi.fn(async () => undefined) };
  }

  const defaultService = createService();
  const projectService = createService();

  const facetRepository = {
    query: vi.fn(),
    assign: vi.fn()
  };
  const actionRepository = {
    list: vi.fn(),
    update: vi.fn()
  };
  const frontierService = {
    rank: vi.fn()
  };
  const checkpointRepository = {
    create: vi.fn(),
    list: vi.fn()
  };
  const lessonRepository = {
    list: vi.fn()
  };
  const lessonService = {
    saveCurated: vi.fn()
  };
  const graphPathService = {
    expand: vi.fn()
  };
  const queryEntityExtractor = {
    extract: vi.fn()
  };

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
    facetRepository,
    actionRepository,
    frontierService,
    checkpointRepository,
    lessonRepository,
    lessonService,
    graphPathService,
    queryEntityExtractor,
    FacetRepository: vi.fn(function FacetRepositoryMock() { return facetRepository; }),
    ActionRepository: vi.fn(function ActionRepositoryMock() { return actionRepository; }),
    FrontierService: vi.fn(function FrontierServiceMock() { return frontierService; }),
    CheckpointRepository: vi.fn(function CheckpointRepositoryMock() { return checkpointRepository; }),
    LessonRepository: vi.fn(function LessonRepositoryMock() { return lessonRepository; }),
    LessonService: vi.fn(function LessonServiceMock() { return lessonService; }),
    GraphPathService: vi.fn(function GraphPathServiceMock() { return graphPathService; }),
    QueryEntityExtractor: vi.fn(function QueryEntityExtractorMock() { return queryEntityExtractor; }),
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
  FacetRepository: mocks.FacetRepository,
  ActionRepository: mocks.ActionRepository,
  FrontierService: mocks.FrontierService,
  CheckpointRepository: mocks.CheckpointRepository,
  LessonRepository: mocks.LessonRepository,
  LessonService: mocks.LessonService,
  GraphPathService: mocks.GraphPathService,
  QueryEntityExtractor: mocks.QueryEntityExtractor,
  runRetentionAudit: mocks.runRetentionAudit
}));

const { tools } = await import('../../src/extensions/mcp/tools.js');
const { handleToolCall } = await import('../../src/extensions/mcp/handlers.js');

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

function textOf(result: Awaited<ReturnType<typeof handleToolCall>>): string {
  const first = result.content[0];
  return first?.type === 'text' ? String(first.text ?? '') : '';
}

function jsonOf(result: Awaited<ReturnType<typeof handleToolCall>>): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

function resetOperationMocks() {
  mocks.sqliteInstances.length = 0;
  mocks.SQLiteEventStore.mockClear();
  mocks.getDefaultMemoryService.mockClear();
  mocks.getMemoryServiceForProject.mockClear();
  mocks.hashProjectPath.mockClear().mockReturnValue('deadbeef');
  mocks.getProjectStoragePath.mockClear().mockReturnValue('/tmp/cml-project-store');
  mocks.defaultService.initialize.mockClear();
  mocks.projectService.initialize.mockClear();

  mocks.FacetRepository.mockClear();
  mocks.ActionRepository.mockClear();
  mocks.FrontierService.mockClear();
  mocks.CheckpointRepository.mockClear();
  mocks.LessonRepository.mockClear();
  mocks.LessonService.mockClear();
  mocks.GraphPathService.mockClear();
  mocks.QueryEntityExtractor.mockClear();
  mocks.runRetentionAudit.mockReset();

  mocks.facetRepository.query.mockReset().mockResolvedValue([]);
  mocks.facetRepository.assign.mockReset().mockResolvedValue({
    id: 'facet-1',
    targetType: 'event',
    targetId: 'event-1',
    dimension: 'workflow',
    value: 'release',
    confidence: 1,
    source: 'manual',
    evidenceEventIds: [],
    projectHash: 'deadbeef',
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z')
  });
  mocks.actionRepository.list.mockReset().mockResolvedValue([]);
  mocks.actionRepository.update.mockReset().mockResolvedValue({
    actionId: '11111111-1111-4111-8111-111111111111',
    projectHash: 'deadbeef',
    title: 'Ship handler tests',
    status: 'done',
    priority: 50,
    sourceEventIds: ['event-1'],
    relatedEntityIds: [],
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T01:00:00.000Z')
  });
  mocks.frontierService.rank.mockReset().mockResolvedValue([]);
  mocks.checkpointRepository.create.mockReset().mockResolvedValue({
    checkpointId: '22222222-2222-4222-8222-222222222222',
    projectHash: 'deadbeef',
    actionId: '11111111-1111-4111-8111-111111111111',
    title: 'safe checkpoint',
    summary: 'safe checkpoint',
    stateJson: {},
    sourceEventIds: [],
    createdAt: new Date('2026-05-01T00:00:00.000Z')
  });
  mocks.checkpointRepository.list.mockReset().mockResolvedValue([]);
  mocks.lessonRepository.list.mockReset().mockResolvedValue([]);
  mocks.lessonService.saveCurated.mockReset().mockResolvedValue({
    lessonId: '33333333-3333-4333-8333-333333333333',
    projectHash: 'deadbeef',
    name: 'Deploy GPU before API',
    trigger: 'When rolling out a runtime split',
    steps: ['Roll out GPU', 'Verify readiness', 'Roll out API'],
    confidence: 1,
    sourceSessionIds: ['curated:operator'],
    sourceEventIds: [],
    failureModes: [],
    skillCandidate: true,
    sourceClass: 'curated',
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z')
  });
  mocks.graphPathService.expand.mockReset().mockReturnValue({
    startNodes: [],
    effectiveMaxHops: 1,
    paths: []
  });
  mocks.queryEntityExtractor.extract.mockReset().mockReturnValue({
    query: 'empty',
    candidates: []
  });
  mocks.runRetentionAudit.mockReturnValue({
    dryRun: true,
    projectHash: 'deadbeef',
    policyVersion: 'retention-policy.v1',
    scanned: 0,
    limit: 50,
    decisions: { keep: 0, review: 0, downgrade: 0, quarantine: 0, tombstone_candidate: 0 },
    wouldChange: 0,
    samples: []
  });
}

describe('MCP memory operation tool definitions', () => {
  const operationToolNames = [
    'mem-facet-query',
    'mem-facet-tag',
    'mem-action-list',
    'mem-action-update',
    'mem-frontier',
    'mem-checkpoint-create',
    'mem-checkpoint-list',
    'mem-retention-audit',
    'mem-graph-query',
    'mem-lesson-list',
    'mem-lesson-save'
  ];

  it('registers the curated memory operations tool surface exactly once', () => {
    const registered = tools.map((tool) => tool.name);

    for (const name of operationToolNames) {
      expect(registered.filter((registeredName) => registeredName === name)).toHaveLength(1);
    }
  });

  it('requires projectPath on all operation tools to avoid cross-project leakage', () => {
    for (const name of operationToolNames) {
      const properties = propertiesFor(name);
      expect(properties.projectPath).toMatchObject({
        type: 'string',
        description: expect.stringContaining('project')
      });
      expect(requiredFor(name)).toContain('projectPath');
    }
  });

  it('marks mutating tools with actor and explicit write-boundary fields', () => {
    const facetTag = propertiesFor('mem-facet-tag');
    expect(requiredFor('mem-facet-tag')).toEqual(expect.arrayContaining([
      'projectPath', 'targetType', 'targetId', 'dimension', 'value', 'actor'
    ]));
    expect(facetTag.actor).toMatchObject({ type: 'string' });
    expect(facetTag.sourceEventIds).toMatchObject({ type: 'array' });

    const actionUpdate = propertiesFor('mem-action-update');
    expect(requiredFor('mem-action-update')).toEqual(expect.arrayContaining([
      'projectPath', 'actionId', 'status', 'actor'
    ]));
    expect(actionUpdate.status).toMatchObject({
      type: 'string',
      enum: expect.arrayContaining(['pending', 'in_progress', 'done', 'blocked', 'cancelled'])
    });
    expect(actionUpdate.sourceEventIds).toMatchObject({ type: 'array' });

    const checkpointCreate = propertiesFor('mem-checkpoint-create');
    expect(requiredFor('mem-checkpoint-create')).toEqual(expect.arrayContaining([
      'projectPath', 'targetType', 'targetId', 'label', 'actor'
    ]));
    expect(checkpointCreate.state).toMatchObject({ type: 'object' });
    expect(checkpointCreate.sourceEventIds).toMatchObject({ type: 'array' });
  });

  it('uses per-tool target type schemas that match operation models', () => {
    for (const name of ['mem-facet-query', 'mem-facet-tag', 'mem-retention-audit']) {
      const targetType = propertiesFor(name).targetType as { enum?: string[] };
      expect(targetType.enum).toEqual(['event', 'entity', 'edge', 'consolidated_memory', 'lesson', 'action']);
      expect(targetType.enum).not.toContain('session');
    }

    const checkpointTargetType = propertiesFor('mem-checkpoint-create').targetType as { enum?: string[] };
    expect(checkpointTargetType.enum).toEqual(['action', 'session']);
    expect(checkpointTargetType.enum).not.toContain('edge');
  });

  it('exposes bounded, dry-run/read-only schemas for governance, graph, and lessons', () => {
    const retentionAudit = propertiesFor('mem-retention-audit');
    expect(retentionAudit.dryRun).toMatchObject({
      type: 'boolean',
      const: true,
      description: expect.stringContaining('dry-run')
    });
    expect(retentionAudit.hardDelete).toBeUndefined();

    const actionList = propertiesFor('mem-action-list');
    expect(actionList.assignee).toBeUndefined();
    expect(actionList.includeTerminal).toMatchObject({ type: 'boolean' });

    const graphQuery = propertiesFor('mem-graph-query');
    expect(graphQuery.maxHops).toMatchObject({
      type: 'number',
      maximum: 2,
      description: expect.stringContaining('bounded')
    });
    expect(requiredFor('mem-graph-query')).toContain('query');

    const lessonList = propertiesFor('mem-lesson-list');
    expect(lessonList.minConfidence).toMatchObject({ type: 'number', minimum: 0, maximum: 1 });
    expect(lessonList.limit).toMatchObject({ type: 'number', maximum: 100 });

    const lessonSave = propertiesFor('mem-lesson-save');
    expect(requiredFor('mem-lesson-save')).toEqual(expect.arrayContaining([
      'projectPath', 'name', 'trigger', 'steps', 'actor'
    ]));
    expect(lessonSave.steps).toMatchObject({ type: 'array', maxItems: 100 });
    expect(lessonSave.confidence).toMatchObject({ type: 'number', minimum: 0, maximum: 1 });
  });
});

describe('MCP memory operation handlers', () => {
  beforeEach(() => {
    resetOperationMocks();
  });

  it('rejects operation calls without an absolute projectPath before opening any store', async () => {
    const result = await handleToolCall('mem-facet-query', { projectPath: 'relative/app', limit: 5 });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('absolute projectPath');
    expect(mocks.getDefaultMemoryService).not.toHaveBeenCalled();
    expect(mocks.getMemoryServiceForProject).not.toHaveBeenCalled();
    expect(mocks.SQLiteEventStore).not.toHaveBeenCalled();
  });

  it('queries facets through the project operation store and returns compact JSON without raw project paths', async () => {
    mocks.facetRepository.query.mockResolvedValue([
      {
        id: 'facet-1',
        targetType: 'event',
        targetId: 'event-1',
        dimension: 'workflow',
        value: 'release',
        confidence: 0.95,
        source: 'manual',
        evidenceEventIds: ['event-1'],
        projectHash: 'deadbeef',
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
        updatedAt: new Date('2026-05-01T00:30:00.000Z')
      }
    ]);

    const result = await handleToolCall('mem-facet-query', {
      projectPath: '/repo/app',
      dimension: 'workflow',
      value: 'release',
      limit: 5
    });

    const payload = jsonOf(result);
    expect(result.isError).not.toBe(true);
    expect(mocks.hashProjectPath).toHaveBeenCalledWith('/repo/app');
    expect(mocks.getProjectStoragePath).toHaveBeenCalledWith('/repo/app');
    expect(mocks.SQLiteEventStore).toHaveBeenCalledWith('/tmp/cml-project-store/events.sqlite', expect.objectContaining({ readonly: false }));
    expect(mocks.FacetRepository).toHaveBeenCalledWith(mocks.fakeDb);
    expect(mocks.facetRepository.query).toHaveBeenCalledWith({
      projectHash: 'deadbeef',
      dimension: 'workflow',
      value: 'release',
      limit: 5
    });
    expect(mocks.sqliteInstances[0].close).toHaveBeenCalledTimes(1);
    expect(payload).toMatchObject({ operation: 'mem-facet-query', projectHash: 'deadbeef', count: 1 });
    expect(JSON.stringify(payload)).toContain('release');
    expect(JSON.stringify(payload)).not.toContain('/repo/app');
  });

  it('saves an explicit curated lesson with an actor and returns compact safe provenance', async () => {
    const result = await handleToolCall('mem-lesson-save', {
      projectPath: '/repo/app',
      actor: 'operator',
      name: 'Deploy GPU before API',
      trigger: 'When rolling out a runtime split',
      steps: ['Roll out GPU', 'Verify readiness', 'Roll out API'],
      sourceSessionIds: ['session-safe']
    });

    const payload = jsonOf(result);
    expect(result.isError).not.toBe(true);
    expect(mocks.LessonService).toHaveBeenCalledWith(mocks.fakeDb);
    expect(mocks.lessonService.saveCurated).toHaveBeenCalledWith(expect.objectContaining({
      projectHash: 'deadbeef',
      actor: 'operator',
      name: 'Deploy GPU before API',
      sourceSessionIds: ['session-safe']
    }));
    expect(payload).toMatchObject({
      operation: 'mem-lesson-save',
      projectHash: 'deadbeef',
      lesson: { sourceClass: 'curated', name: 'Deploy GPU before API' }
    });
    expect(JSON.stringify(payload)).not.toContain('/repo/app');
  });

  it('routes state-changing tools with actor, projectHash, bounded evidence, and sanitized note metadata', async () => {
    const result = await handleToolCall('mem-action-update', {
      projectPath: '/repo/app',
      actionId: '11111111-1111-4111-8111-111111111111',
      status: 'done',
      actor: 'hermes-agent',
      note: 'Finished from /repo/app with token=dk',
      sourceEventIds: Array.from({ length: 30 }, (_value, index) => `event-${index}`)
    });

    const payload = jsonOf(result);
    expect(result.isError).not.toBe(true);
    expect(mocks.actionRepository.update).toHaveBeenCalledWith({
      actionId: '11111111-1111-4111-8111-111111111111',
      projectHash: 'deadbeef',
      status: 'done',
      actor: 'hermes-agent',
      note: expect.stringContaining('[path]'),
      sourceEventIds: Array.from({ length: 20 }, (_value, index) => `event-${index}`)
    });
    expect(JSON.stringify(payload)).not.toContain('/repo/app');
    expect(JSON.stringify(payload)).not.toContain('token=dk');
  });

  it('creates and lists checkpoints by mapping targetType/targetId to repository filters', async () => {
    const sensitiveStateKey = `api${'Token'}`;
    const createResult = await handleToolCall('mem-checkpoint-create', {
      projectPath: '/repo/app',
      targetType: 'action',
      targetId: '11111111-1111-4111-8111-111111111111',
      label: 'Resume after tests',
      state: { file: '/repo/app/private-plan.md', [sensitiveStateKey]: 'dk' },
      sourceEventIds: ['event-1'],
      actor: 'hermes-agent'
    });

    expect(createResult.isError).not.toBe(true);
    expect(mocks.checkpointRepository.create).toHaveBeenCalledWith({
      projectHash: 'deadbeef',
      actionId: '11111111-1111-4111-8111-111111111111',
      title: 'Resume after tests',
      summary: 'Resume after tests',
      stateJson: { file: '[path]', '[REDACTED_KEY]': '[REDACTED]' },
      sourceEventIds: ['event-1'],
      actor: 'hermes-agent'
    });

    await handleToolCall('mem-checkpoint-list', {
      projectPath: '/repo/app',
      targetType: 'action',
      targetId: '11111111-1111-4111-8111-111111111111',
      limit: 3
    });

    expect(mocks.checkpointRepository.list).toHaveBeenCalledWith({
      projectHash: 'deadbeef',
      actionId: '11111111-1111-4111-8111-111111111111',
      limit: 3
    });
  });

  it('keeps retention audits dry-run only and never exposes hard-delete actions', async () => {
    const denied = await handleToolCall('mem-retention-audit', {
      projectPath: '/repo/app',
      dryRun: false
    });

    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain('dry-run only');
    expect(mocks.runRetentionAudit).not.toHaveBeenCalled();

    const result = await handleToolCall('mem-retention-audit', {
      projectPath: '/repo/app',
      dryRun: true,
      targetType: 'event',
      targetId: 'event-1',
      limit: 7
    });

    const payload = jsonOf(result);
    expect(result.isError).not.toBe(true);
    expect(mocks.runRetentionAudit).toHaveBeenCalledWith(mocks.fakeDb, expect.objectContaining({
      projectHash: 'deadbeef',
      dryRun: true,
      limit: 7,
      targetType: 'event',
      targetId: 'event-1',
      projectPath: '/repo/app'
    }));
    expect(payload).toMatchObject({ operation: 'mem-retention-audit', projectHash: 'deadbeef' });
    expect(JSON.stringify(payload).toLowerCase()).not.toContain('harddelete');
  });

  it('runs graph query with extracted start entities and clamps traversal to two hops', async () => {
    mocks.queryEntityExtractor.extract.mockReturnValue({
      query: 'Trace CheckoutService impact',
      candidates: [
        {
          text: 'CheckoutService',
          normalized: 'checkoutservice',
          source: 'entity_alias',
          confidence: 0.95,
          start: 6,
          end: 21,
          entityId: 'entity-checkout',
          entityType: 'artifact',
          canonicalKey: 'artifact:checkoutservice'
        }
      ]
    });
    mocks.graphPathService.expand.mockReturnValue({
      startNodes: [{ type: 'entity', id: 'entity-checkout', name: 'CheckoutService' }],
      effectiveMaxHops: 2,
      paths: []
    });

    const result = await handleToolCall('mem-graph-query', {
      projectPath: '/repo/app',
      query: 'Trace CheckoutService impact',
      direction: 'both',
      maxHops: 9,
      limit: 4
    });

    const payload = jsonOf(result);
    expect(result.isError).not.toBe(true);
    expect(mocks.QueryEntityExtractor).toHaveBeenCalledWith(mocks.fakeDb);
    expect(mocks.graphPathService.expand).toHaveBeenCalledWith({
      startNodes: [{ type: 'entity', id: 'entity-checkout' }],
      direction: 'both',
      maxHops: 2,
      maxResults: 4
    });
    expect(payload).toMatchObject({ operation: 'mem-graph-query', projectHash: 'deadbeef' });
    expect(JSON.stringify(payload)).toContain('CheckoutService');
  });

  it('lists all read-only operation surfaces with compact bounded results', async () => {
    mocks.actionRepository.list.mockResolvedValue([
      {
        actionId: '11111111-1111-4111-8111-111111111111',
        projectHash: 'deadbeef',
        title: 'First action',
        status: 'pending',
        priority: 10,
        sourceEventIds: [],
        relatedEntityIds: [],
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
        updatedAt: new Date('2026-05-01T00:00:00.000Z')
      }
    ]);
    mocks.frontierService.rank.mockResolvedValue([{ action: { actionId: 'a1', title: 'next' }, score: 10, reasons: ['priority:2'], sourceRefs: [] }]);
    mocks.lessonRepository.list.mockResolvedValue([
      { lessonId: 'lesson-low', projectHash: 'deadbeef', name: 'low', confidence: 0.4, steps: [], sourceEventIds: [], sourceSessionIds: [], failureModes: [], skillCandidate: false, createdAt: new Date('2026-05-01T00:00:00.000Z'), updatedAt: new Date('2026-05-01T00:00:00.000Z') },
      { lessonId: 'lesson-high', projectHash: 'deadbeef', name: 'high', confidence: 0.9, steps: [], sourceEventIds: [], sourceSessionIds: [], failureModes: [], skillCandidate: true, createdAt: new Date('2026-05-01T00:00:00.000Z'), updatedAt: new Date('2026-05-01T00:00:00.000Z') }
    ]);

    const actionList = jsonOf(await handleToolCall('mem-action-list', { projectPath: '/repo/app', status: 'pending', limit: 2 }));
    const frontier = jsonOf(await handleToolCall('mem-frontier', { projectPath: '/repo/app', includeBlocked: true, limit: 2 }));
    const lessons = jsonOf(await handleToolCall('mem-lesson-list', { projectPath: '/repo/app', minConfidence: 0.8, limit: 5 }));

    expect(mocks.actionRepository.list).toHaveBeenCalledWith({ projectHash: 'deadbeef', status: 'pending', includeTerminal: false, limit: 2 });
    expect(mocks.frontierService.rank).toHaveBeenCalledWith({ projectHash: 'deadbeef', includeBlocked: true, limit: 2 });
    expect(mocks.lessonRepository.list).toHaveBeenCalledWith({ projectHash: 'deadbeef', limit: 5 });
    expect(actionList).toMatchObject({ operation: 'mem-action-list', count: 1 });
    expect(frontier).toMatchObject({ operation: 'mem-frontier', count: 1 });
    expect(lessons).toMatchObject({ operation: 'mem-lesson-list', count: 1 });
    expect(JSON.stringify(lessons)).toContain('lesson-high');
    expect(JSON.stringify(lessons)).not.toContain('lesson-low');
  });
});
