/**
 * MCP Tool Handlers
 * Implementation of tool calls
 */

import * as path from 'node:path';

import {
  getDefaultMemoryService,
  getMemoryServiceForProject,
  type MemoryService
} from '../../services/memory-service.js';
import { SQLiteEventStore } from '../../core/sqlite-event-store.js';
import type { SQLiteDatabase } from '../../core/sqlite-wrapper.js';
import { createSessionHistoryImporter, type ImportResult } from '../../services/session-history-importer.js';
import { createCodexSessionHistoryImporter } from '../../services/codex-session-history-importer.js';
import { createHermesSessionHistoryImporter } from '../../services/hermes-session-history-importer.js';
import {
  fetchExternalMarketContext,
  renderExternalMarketContextReport,
  type ExternalMarketProvider
} from '../../core/external-market-context.js';
import { generateCitationId } from '../../core/citation-generator.js';
import { getProjectStoragePath, hashProjectPath } from '../../core/registry/project-path.js';
import { applyPrivacyFilter, maskSensitiveInput } from '../../core/privacy/filter.js';
import {
  ActionRepository,
  ActorCardRepository,
  ActorRepository,
  CheckpointRepository,
  FacetRepository,
  FrontierService,
  GraphPathService,
  LessonRepository,
  PerspectiveObservationRepository,
  QueryEntityExtractor,
  RETENTION_POLICY_VERSION,
  runRetentionAudit,
  type FrontierItem,
  type GraphPathExpandResult,
  type MemoryAction,
  type MemoryCheckpoint,
  type MemoryFacetAssignment,
  type QueryEntityCandidate
} from '../../core/operations/index.js';
import { DEFAULT_EMBEDDING_MODEL } from '../../extensions/vector/embedder.js';
import {
  isGenericContinuationQuery,
  isLowSignalContextContent
} from '../../core/retrieval-quality.js';
import type {
  ActorCard,
  Config,
  EventType,
  MemoryActor,
  MemoryEvent,
  PerspectiveObservation,
  PerspectiveObservationLevel
} from '../../core/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

type ToolResult = CallToolResult;

type MemoryToolArgs = Record<string, unknown>;

function resolveMemoryService(args: MemoryToolArgs): MemoryService {
  const projectPath = typeof args.projectPath === 'string' ? args.projectPath.trim() : '';
  if (projectPath.length > 0) {
    return getMemoryServiceForProject(projectPath);
  }
  return getDefaultMemoryService();
}

const CONTEXT_PACK_PERSPECTIVE_ARG_NAMES = [
  'observerActorId',
  'targetActorId',
  'observedActorId',
  'includeActorCard',
  'includePerspectiveObservations',
  'limitToSession',
  'reasoningLevel'
] as const;

function hasMemContextPackPerspectiveArgs(args: Record<string, unknown>): boolean {
  return CONTEXT_PACK_PERSPECTIVE_ARG_NAMES.some((name) =>
    Object.prototype.hasOwnProperty.call(args, name) && args[name] !== undefined
  );
}

function isAbsoluteProjectPath(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

function validateMemContextPackPerspectiveArgs(args: Record<string, unknown>): void {
  const projectPath = optionalString(args.projectPath);
  if (!projectPath || !isAbsoluteProjectPath(projectPath)) {
    throw new Error('mem-context-pack perspective context requires an explicit absolute projectPath before memory access');
  }
  requiredOperationString(args.observerActorId, 'observerActorId');
  requiredOperationString(args.targetActorId ?? args.observedActorId, 'targetActorId');
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  try {
    if (name === 'external-market-context') {
      return await handleExternalMarketContext(args);
    }

    if (name === 'mem-context-pack' && hasMemContextPackPerspectiveArgs(args)) {
      validateMemContextPackPerspectiveArgs(args);
    }

    if (MEMORY_OPERATION_TOOL_NAMES.has(name)) {
      return await handleMemoryOperationTool(name, args);
    }

    if (name === 'mem-import-latest' || (name === 'mem-context-pack' && args.refreshLatest === true)) {
      const projectPath = optionalString(args.projectPath);
      if (!projectPath || !path.isAbsolute(projectPath)) {
        const toolName = name === 'mem-context-pack' ? 'mem-context-pack refreshLatest' : 'mem-import-latest';
        return {
          content: [{ type: 'text', text: `Error: ${toolName} requires an explicit absolute projectPath.` }],
          isError: true
        };
      }
    }

    const memoryService = resolveMemoryService(args);
    await memoryService.initialize();

    switch (name) {
      case 'mem-search':
        return await handleMemSearch(memoryService, args);

      case 'mem-timeline':
        return await handleMemTimeline(memoryService, args);

      case 'mem-details':
        return await handleMemDetails(memoryService, args);

      case 'mem-stats':
        return await handleMemStats(memoryService, args);

      case 'mem-context-pack':
        return await handleMemContextPack(memoryService, args);

      case 'mem-import-latest':
        return await handleMemImportLatest(memoryService, args);

      case 'mem-project-timeline':
        return await handleMemProjectTimeline(memoryService, args);

      case 'mem-source-ref':
        return await handleMemSourceRef(memoryService, args);

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true
        };
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${safeErrorSummary(error)}` }],
      isError: true
    };
  }
}

const MEMORY_OPERATION_TOOL_NAMES = new Set([
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
  'mem-actor-list',
  'mem-actor-card-get',
  'mem-actor-card-upsert',
  'mem-perspective-query',
  'mem-perspective-context',
  'mem-perspective-observation-create',
  'mem-perspective-observation-delete'
]);

interface MemoryOperationContext {
  projectPath: string;
  projectHash: string;
  db: SQLiteDatabase;
}

async function handleMemoryOperationTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (name === 'mem-retention-audit' && args.dryRun === false) {
    throw new Error('mem-retention-audit is dry-run only; hard delete and mutating retention actions are not exposed');
  }

  return await withMemoryOperationContext(args, async (context) => {
    switch (name) {
      case 'mem-facet-query':
        return jsonResult(await handleFacetQuery(context, args));
      case 'mem-facet-tag':
        return jsonResult(await handleFacetTag(context, args));
      case 'mem-action-list':
        return jsonResult(await handleActionList(context, args));
      case 'mem-action-update':
        return jsonResult(await handleActionUpdate(context, args));
      case 'mem-frontier':
        return jsonResult(await handleFrontier(context, args));
      case 'mem-checkpoint-create':
        return jsonResult(await handleCheckpointCreate(context, args));
      case 'mem-checkpoint-list':
        return jsonResult(await handleCheckpointList(context, args));
      case 'mem-retention-audit':
        return jsonResult(handleRetentionAudit(context, args));
      case 'mem-graph-query':
        return jsonResult(handleGraphQuery(context, args));
      case 'mem-lesson-list':
        return jsonResult(await handleLessonList(context, args));
      case 'mem-actor-list':
        return jsonResult(await handleActorList(context, args));
      case 'mem-actor-card-get':
        return jsonResult(await handleActorCardGet(context, args));
      case 'mem-actor-card-upsert':
        return jsonResult(await handleActorCardUpsert(context, args));
      case 'mem-perspective-query':
        return jsonResult(await handlePerspectiveQuery(context, args));
      case 'mem-perspective-context':
        return jsonResult(await handlePerspectiveContext(context, args));
      case 'mem-perspective-observation-create':
        return jsonResult(await handlePerspectiveObservationCreate(context, args));
      case 'mem-perspective-observation-delete':
        return jsonResult(await handlePerspectiveObservationDelete(context, args));
      default:
        throw new Error(`Unknown memory operation tool: ${name}`);
    }
  });
}

async function withMemoryOperationContext<T>(
  args: Record<string, unknown>,
  callback: (context: MemoryOperationContext) => Promise<T> | T
): Promise<T> {
  const projectPath = requiredProjectPath(args);
  const projectHash = hashProjectPath(projectPath);
  const storagePath = getProjectStoragePath(projectPath);
  const store = new SQLiteEventStore(path.join(storagePath, 'events.sqlite'), { readonly: false });
  await store.initialize();
  try {
    return await callback({ projectPath, projectHash, db: store.getDatabase() });
  } finally {
    await store.close();
  }
}

async function handleFacetQuery(context: MemoryOperationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const repository = new FacetRepository(context.db);
  const facets = await repository.query(omitUndefined({
    projectHash: context.projectHash,
    targetType: optionalString(args.targetType),
    targetId: optionalString(args.targetId),
    dimension: optionalString(args.dimension),
    value: optionalString(args.value),
    source: optionalString(args.source),
    limit: numberArg(args.limit, 50, 1, 100)
  }));
  return {
    operation: 'mem-facet-query',
    projectHash: context.projectHash,
    count: facets.length,
    facets: facets.map(formatFacet)
  };
}

async function handleFacetTag(context: MemoryOperationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const repository = new FacetRepository(context.db);
  const sourceEventIds = stringArrayOperationArg(args.sourceEventIds, 20);
  const facet = await repository.assign({
    projectHash: context.projectHash,
    targetType: requiredOperationString(args.targetType, 'targetType'),
    targetId: requiredOperationString(args.targetId, 'targetId'),
    dimension: requiredOperationString(args.dimension, 'dimension'),
    value: sanitizeOperationString(requiredOperationString(args.value, 'value'), 240),
    confidence: numberArg(args.confidence, 1, 0, 1),
    source: optionalString(args.source) ?? 'manual',
    evidenceEventIds: sourceEventIds,
    actor: sanitizeOperationString(requiredOperationString(args.actor, 'actor'), 120)
  });
  return {
    operation: 'mem-facet-tag',
    projectHash: context.projectHash,
    facet: formatFacet(facet)
  };
}

async function handleActionList(context: MemoryOperationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const repository = new ActionRepository(context.db);
  const actions = await repository.list(omitUndefined({
    projectHash: context.projectHash,
    status: optionalString(args.status),
    includeTerminal: booleanArg(args.includeTerminal, false),
    limit: numberArg(args.limit, 50, 1, 100)
  }));
  return {
    operation: 'mem-action-list',
    projectHash: context.projectHash,
    count: actions.length,
    actions: actions.map(formatAction)
  };
}

async function handleActionUpdate(context: MemoryOperationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const repository = new ActionRepository(context.db);
  const updateInput: Record<string, unknown> = {
    actionId: requiredOperationString(args.actionId, 'actionId'),
    projectHash: context.projectHash,
    status: requiredOperationString(args.status, 'status'),
    actor: sanitizeOperationString(requiredOperationString(args.actor, 'actor'), 120)
  };
  const sourceEventIds = stringArrayOperationArg(args.sourceEventIds, 20);
  if (sourceEventIds.length > 0) updateInput.sourceEventIds = sourceEventIds;
  const note = optionalString(args.note);
  if (note) updateInput.note = sanitizeOperationString(note, 500);

  const action = await repository.update(updateInput);
  return {
    operation: 'mem-action-update',
    projectHash: context.projectHash,
    action: formatAction(action)
  };
}

async function handleFrontier(context: MemoryOperationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const service = new FrontierService(context.db);
  const frontier = await service.rank({
    projectHash: context.projectHash,
    includeBlocked: booleanArg(args.includeBlocked, false),
    limit: numberArg(args.limit, 50, 1, 100)
  });
  return {
    operation: 'mem-frontier',
    projectHash: context.projectHash,
    count: frontier.length,
    frontier: frontier.map(formatFrontierItem)
  };
}

async function handleCheckpointCreate(context: MemoryOperationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const repository = new CheckpointRepository(context.db);
  const targetType = requiredOperationString(args.targetType, 'targetType');
  const targetId = requiredOperationString(args.targetId, 'targetId');
  if (targetType !== 'action' && targetType !== 'session') {
    throw new Error('mem-checkpoint-create targetType must be action or session');
  }
  const label = sanitizeOperationString(requiredOperationString(args.label, 'label'), 240);
  const createInput: Record<string, unknown> = {
    projectHash: context.projectHash,
    title: label,
    summary: label,
    stateJson: sanitizeOperationRecord(isPlainRecord(args.state) ? args.state : {}),
    sourceEventIds: stringArrayOperationArg(args.sourceEventIds, 20),
    actor: sanitizeOperationString(requiredOperationString(args.actor, 'actor'), 120)
  };
  if (targetType === 'action') createInput.actionId = targetId;
  if (targetType === 'session') createInput.sessionId = targetId;

  const checkpoint = await repository.create(createInput);
  return {
    operation: 'mem-checkpoint-create',
    projectHash: context.projectHash,
    checkpoint: formatCheckpoint(checkpoint)
  };
}

async function handleCheckpointList(context: MemoryOperationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const repository = new CheckpointRepository(context.db);
  const targetType = optionalString(args.targetType);
  const targetId = optionalString(args.targetId);
  const listInput: Record<string, unknown> = {
    projectHash: context.projectHash,
    limit: numberArg(args.limit, 50, 1, 100)
  };
  if (targetType || targetId) {
    if (targetType !== 'action' && targetType !== 'session') {
      throw new Error('mem-checkpoint-list targetType must be action or session when targetId is provided');
    }
    if (!targetId) throw new Error('mem-checkpoint-list targetId is required when targetType is provided');
    if (targetType === 'action') listInput.actionId = targetId;
    if (targetType === 'session') listInput.sessionId = targetId;
  }

  const checkpoints = await repository.list(listInput);
  return {
    operation: 'mem-checkpoint-list',
    projectHash: context.projectHash,
    count: checkpoints.length,
    checkpoints: checkpoints.map(formatCheckpoint)
  };
}

function handleRetentionAudit(context: MemoryOperationContext, args: Record<string, unknown>): Record<string, unknown> {
  const policyVersion = optionalString(args.policyVersion);
  if (policyVersion && policyVersion !== RETENTION_POLICY_VERSION) {
    throw new Error(`mem-retention-audit only supports retention policy ${RETENTION_POLICY_VERSION}`);
  }
  const report = runRetentionAudit(context.db, {
    projectHash: context.projectHash,
    dryRun: true,
    targetType: optionalString(args.targetType),
    targetId: optionalString(args.targetId),
    limit: numberArg(args.limit, 50, 1, 500),
    sampleLimit: numberArg(args.sampleLimit, 10, 0, 100),
    projectPath: context.projectPath
  });
  return {
    operation: 'mem-retention-audit',
    projectHash: context.projectHash,
    report
  };
}

function handleGraphQuery(context: MemoryOperationContext, args: Record<string, unknown>): Record<string, unknown> {
  const query = requiredOperationString(args.query, 'query');
  const extractor = new QueryEntityExtractor(context.db);
  const extraction = extractor.extract(
    [query, optionalString(args.startEntityTitle)].filter(Boolean).join(' '),
    { maxCandidates: numberArg(args.candidateLimit, 20, 1, 50) }
  );
  const startNodes = uniqueEntityStartNodes(extraction.candidates);
  const graph = new GraphPathService(context.db).expand({
    startNodes,
    direction: graphDirectionArg(args.direction),
    maxHops: numberArg(args.maxHops, 1, 1, 2),
    maxResults: numberArg(args.limit, 20, 1, 100)
  });
  return {
    operation: 'mem-graph-query',
    projectHash: context.projectHash,
    query: sanitizeOperationString(query, 500),
    candidates: extraction.candidates.map(formatQueryEntityCandidate),
    graph: formatGraphResult(graph)
  };
}

async function handleLessonList(context: MemoryOperationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const repository = new LessonRepository(context.db);
  const lessons = await repository.list(omitUndefined({
    projectHash: context.projectHash,
    skillCandidate: typeof args.skillCandidate === 'boolean' ? args.skillCandidate : undefined,
    limit: numberArg(args.limit, 50, 1, 100)
  }));
  const minConfidence = typeof args.minConfidence === 'number' ? Math.min(1, Math.max(0, args.minConfidence)) : undefined;
  const filtered = minConfidence === undefined
    ? lessons
    : lessons.filter((lesson) => Number(lesson.confidence ?? 0) >= minConfidence);
  return {
    operation: 'mem-lesson-list',
    projectHash: context.projectHash,
    count: filtered.length,
    lessons: filtered.map((lesson) => ({
      lessonId: sanitizeOperationString(String(lesson.lessonId ?? ''), 120),
      name: sanitizeOperationString(String(lesson.name ?? ''), 240),
      trigger: lesson.trigger ? sanitizeOperationString(String(lesson.trigger), 500) : undefined,
      confidence: Number(lesson.confidence ?? 0),
      skillCandidate: Boolean(lesson.skillCandidate),
      steps: Array.isArray(lesson.steps) ? lesson.steps.slice(0, 10).map((step) => sanitizeOperationString(String(step), 500)) : [],
      failureModes: Array.isArray(lesson.failureModes) ? lesson.failureModes.slice(0, 10).map((mode) => sanitizeOperationString(String(mode), 300)) : [],
      sourceEventIds: Array.isArray(lesson.sourceEventIds) ? lesson.sourceEventIds.slice(0, 10).map((id) => sanitizeOperationString(String(id), 120)) : [],
      sourceSessionIds: Array.isArray(lesson.sourceSessionIds) ? lesson.sourceSessionIds.slice(0, 10).map((id) => sanitizeOperationString(String(id), 120)) : [],
      createdAt: isoDate(lesson.createdAt),
      updatedAt: isoDate(lesson.updatedAt)
    }))
  };
}

async function handleActorList(context: MemoryOperationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const repository = new ActorRepository(context.db);
  const actors = await repository.list(omitUndefined({
    projectHash: context.projectHash,
    kind: actorKindArg(args.kind),
    source: optionalString(args.source),
    limit: numberArg(args.limit, 50, 1, 100)
  }));
  return {
    operation: 'mem-actor-list',
    projectHash: context.projectHash,
    count: actors.length,
    actors: actors.map(formatActor)
  };
}

async function handleActorCardGet(context: MemoryOperationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const repository = new ActorCardRepository(context.db);
  const card = await repository.get({
    projectHash: context.projectHash,
    observerActorId: requiredOperationString(args.observerActorId, 'observerActorId'),
    observedActorId: requiredOperationString(args.observedActorId ?? args.targetActorId, 'observedActorId')
  });
  return {
    operation: 'mem-actor-card-get',
    projectHash: context.projectHash,
    found: Boolean(card),
    card: card ? formatActorCard(card) : undefined
  };
}

async function handleActorCardUpsert(context: MemoryOperationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const repository = new ActorCardRepository(context.db);
  const card = await repository.upsert({
    projectHash: context.projectHash,
    observerActorId: requiredOperationString(args.observerActorId, 'observerActorId'),
    observedActorId: requiredOperationString(args.observedActorId ?? args.targetActorId, 'observedActorId'),
    entries: actorCardEntriesArg(args.entries),
    sourceEventIds: stringArrayOperationArg(args.sourceEventIds, 20),
    updatedBy: sanitizeOperationString(requiredOperationString(args.actor, 'actor'), 120)
  });
  return {
    operation: 'mem-actor-card-upsert',
    projectHash: context.projectHash,
    card: formatActorCard(card)
  };
}

async function handlePerspectiveQuery(context: MemoryOperationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const repository = new PerspectiveObservationRepository(context.db);
  const observations = await repository.query(buildPerspectiveObservationQuery(context, args));
  return {
    operation: 'mem-perspective-query',
    projectHash: context.projectHash,
    count: observations.length,
    observations: observations.map(formatPerspectiveObservation)
  };
}

async function handlePerspectiveContext(context: MemoryOperationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bundle = await loadPerspectiveContextBundle(context, args, {
    query: optionalString(args.query),
    defaultLimit: numberArg(args.limit, perspectiveObservationLimit(args.reasoningLevel), 1, 100)
  });
  return {
    operation: 'mem-perspective-context',
    projectHash: context.projectHash,
    observerActorId: bundle.observerActorId,
    targetActorId: bundle.targetActorId,
    actorCard: bundle.card ? formatActorCard(bundle.card) : undefined,
    observations: bundle.observations.map(formatPerspectiveObservation),
    count: bundle.observations.length
  };
}

async function handlePerspectiveObservationCreate(context: MemoryOperationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const repository = new PerspectiveObservationRepository(context.db);
  const observation = await repository.create({
    projectHash: context.projectHash,
    observerActorId: requiredOperationString(args.observerActorId, 'observerActorId'),
    observedActorId: requiredOperationString(args.observedActorId ?? args.targetActorId, 'observedActorId'),
    sessionId: optionalString(args.sessionId),
    level: perspectiveLevelArg(args.level, 'explicit'),
    content: sanitizeOperationString(requiredOperationString(args.content, 'content'), 1000),
    confidence: boundedNumberArg(args.confidence, 0.5, 0, 1),
    sourceEventIds: stringArrayOperationArg(args.sourceEventIds, 20),
    sourceObservationIds: stringArrayOperationArg(args.sourceObservationIds, 20),
    createdBy: perspectiveCreatedByArg(args.createdBy),
    metadata: isPlainRecord(args.metadata) ? sanitizeOperationRecord(args.metadata) : undefined,
    actor: sanitizeOperationString(requiredOperationString(args.actor, 'actor'), 120)
  });
  return {
    operation: 'mem-perspective-observation-create',
    projectHash: context.projectHash,
    observation: formatPerspectiveObservation(observation)
  };
}

async function handlePerspectiveObservationDelete(context: MemoryOperationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const repository = new PerspectiveObservationRepository(context.db);
  const observation = await repository.deleteSoft({
    projectHash: context.projectHash,
    observationId: requiredOperationString(args.observationId, 'observationId'),
    actor: sanitizeOperationString(requiredOperationString(args.actor, 'actor'), 120)
  });
  return {
    operation: 'mem-perspective-observation-delete',
    projectHash: context.projectHash,
    observation: formatPerspectiveObservation(observation)
  };
}

function requiredProjectPath(args: Record<string, unknown>): string {
  const projectPath = optionalString(args.projectPath);
  if (!projectPath || !isAbsoluteProjectPath(projectPath)) {
    throw new Error('memory operation tools require an explicit absolute projectPath');
  }
  return projectPath;
}

function requiredOperationString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function booleanArg(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function stringArrayOperationArg(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean)
    .slice(0, Math.max(0, maxItems));
}

function graphDirectionArg(value: unknown): 'outgoing' | 'incoming' | 'both' {
  return value === 'outgoing' || value === 'incoming' || value === 'both' ? value : 'both';
}

const MEMORY_ACTOR_KINDS = new Set(['user', 'assistant', 'subagent', 'tool', 'system', 'integration', 'unknown']);
const PERSPECTIVE_LEVELS = new Set<PerspectiveObservationLevel>(['explicit', 'deductive', 'inductive', 'contradiction']);
const PERSPECTIVE_CREATED_BY = new Set(['rule', 'llm', 'manual', 'import']);
const ACTOR_CARD_ENTRY_PATTERN = /^(IDENTITY|ATTRIBUTE|RELATIONSHIP|INSTRUCTION):\s*\S/;

type PerspectiveCreatedBy = 'rule' | 'llm' | 'manual' | 'import';

interface PerspectiveContextBundle {
  observerActorId: string;
  targetActorId: string;
  card: ActorCard | null;
  observations: PerspectiveObservation[];
}

function actorKindArg(value: unknown): MemoryActor['kind'] | undefined {
  return typeof value === 'string' && MEMORY_ACTOR_KINDS.has(value) ? value as MemoryActor['kind'] : undefined;
}

function actorCardEntriesArg(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('entries must be a non-empty array of actor card entries');
  }
  if (value.length === 0) {
    throw new Error('entries must contain at least one actor card entry');
  }
  if (value.length > 40) {
    throw new Error('actor card supports at most 40 entries');
  }

  return value.map((item) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error('actor card entries must be non-empty strings');
    }
    const normalized = item.replace(/\s+/g, ' ').trim();
    if (normalized.length > 200) {
      throw new Error('actor card entries must be 200 characters or fewer');
    }
    const sanitized = sanitizeOperationString(normalized, 200);
    if (!ACTOR_CARD_ENTRY_PATTERN.test(sanitized)) {
      throw new Error('actor card entry prefix must be one of IDENTITY:, ATTRIBUTE:, RELATIONSHIP:, or INSTRUCTION:');
    }
    if (/\[REDACTED(?:_KEY)?\]|\[path\]/i.test(sanitized)) {
      throw new Error('actor card entries must not contain secrets, redacted values, or private paths');
    }
    return sanitized;
  });
}

function perspectiveLevelArg(value: unknown, fallback: PerspectiveObservationLevel): PerspectiveObservationLevel {
  return typeof value === 'string' && PERSPECTIVE_LEVELS.has(value as PerspectiveObservationLevel)
    ? value as PerspectiveObservationLevel
    : fallback;
}

function perspectiveLevelsArg(value: unknown): PerspectiveObservationLevel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const selected = value
    .map((item) => typeof item === 'string' ? item : '')
    .filter((item): item is PerspectiveObservationLevel => PERSPECTIVE_LEVELS.has(item as PerspectiveObservationLevel));
  return selected.length > 0 ? Array.from(new Set(selected)) : undefined;
}

function perspectiveCreatedByArg(value: unknown): PerspectiveCreatedBy {
  return typeof value === 'string' && PERSPECTIVE_CREATED_BY.has(value) ? value as PerspectiveCreatedBy : 'manual';
}

function perspectiveObservationLimit(reasoningLevel: unknown): number {
  if (reasoningLevel === 'minimal') return 3;
  if (reasoningLevel === 'low') return 6;
  if (reasoningLevel === 'high') return 20;
  return 12;
}

function sourceRefHints(sourceEventIds: string[]): string[] {
  return sourceEventIds
    .slice(0, 5)
    .map((id) => `mem-source-ref ids=['${generateCitationId(id)}']`);
}

function buildPerspectiveObservationQuery(
  context: MemoryOperationContext,
  args: Record<string, unknown>,
  overrides: { query?: string; sessionId?: string; limit?: number } = {}
): Record<string, unknown> {
  const query = overrides.query ?? optionalString(args.query);
  const sessionId = overrides.sessionId ?? optionalString(args.sessionId);
  const observedActorId = optionalString(args.observedActorId) ?? optionalString(args.targetActorId);
  return omitUndefined({
    projectHash: context.projectHash,
    observerActorId: optionalString(args.observerActorId),
    observedActorId,
    sessionId,
    levels: perspectiveLevelsArg(args.levels),
    query: query ? sanitizeOperationString(query, 500) : undefined,
    includeDeleted: typeof args.includeDeleted === 'boolean' && args.includeDeleted ? true : undefined,
    limit: overrides.limit ?? numberArg(args.limit, 50, 1, 100)
  });
}

async function loadPerspectiveContextBundle(
  context: MemoryOperationContext,
  args: Record<string, unknown>,
  options: { query?: string; defaultLimit: number }
): Promise<PerspectiveContextBundle> {
  const observerActorId = requiredOperationString(args.observerActorId, 'observerActorId');
  const targetActorId = requiredOperationString(args.targetActorId ?? args.observedActorId, 'targetActorId');
  const includeActorCard = args.includeActorCard !== false;
  const includePerspectiveObservations = args.includePerspectiveObservations !== false;
  const cardRepository = includeActorCard ? new ActorCardRepository(context.db) : undefined;
  const observationRepository = includePerspectiveObservations ? new PerspectiveObservationRepository(context.db) : undefined;
  const limitToSession = booleanArg(args.limitToSession, false);
  const sessionId = limitToSession ? optionalString(args.sessionId) : undefined;

  const card = cardRepository
    ? await cardRepository.get({ projectHash: context.projectHash, observerActorId, observedActorId: targetActorId })
    : null;
  const observations = observationRepository
    ? await observationRepository.query(omitUndefined({
      projectHash: context.projectHash,
      observerActorId,
      observedActorId: targetActorId,
      sessionId,
      query: options.query ? sanitizeOperationString(options.query, 500) : undefined,
      limit: options.defaultLimit
    }))
    : [];

  return { observerActorId, targetActorId, card, observations };
}

function uniqueEntityStartNodes(candidates: QueryEntityCandidate[]): Array<{ type: 'entity'; id: string }> {
  const seen = new Set<string>();
  const startNodes: Array<{ type: 'entity'; id: string }> = [];
  for (const candidate of candidates) {
    if (!candidate.entityId) continue;
    if (seen.has(candidate.entityId)) continue;
    seen.add(candidate.entityId);
    startNodes.push({ type: 'entity', id: candidate.entityId });
  }
  return startNodes;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function formatActor(actor: MemoryActor): Record<string, unknown> {
  return omitUndefined({
    actorId: sanitizeOperationString(actor.actorId, 160),
    projectHash: actor.projectHash,
    kind: actor.kind,
    displayName: sanitizeOperationString(actor.displayName, 160),
    source: sanitizeOperationString(actor.source, 120),
    metadata: actor.metadata ? compactRecord(actor.metadata, 10) : undefined,
    createdAt: isoDate(actor.createdAt),
    updatedAt: isoDate(actor.updatedAt)
  });
}

function formatActorCard(card: ActorCard): Record<string, unknown> {
  return {
    cardId: card.cardId,
    projectHash: card.projectHash,
    observerActorId: sanitizeOperationString(card.observerActorId, 160),
    observedActorId: sanitizeOperationString(card.observedActorId, 160),
    entries: compactStringArray(card.entries, 40, 200),
    sourceEventIds: compactStringArray(card.sourceEventIds, 10, 120),
    sourceRefs: sourceRefHints(card.sourceEventIds),
    updatedBy: card.updatedBy ? sanitizeOperationString(card.updatedBy, 120) : undefined,
    createdAt: isoDate(card.createdAt),
    updatedAt: isoDate(card.updatedAt)
  };
}

function formatPerspectiveObservation(observation: PerspectiveObservation): Record<string, unknown> {
  return omitUndefined({
    observationId: observation.observationId,
    projectHash: observation.projectHash,
    observerActorId: sanitizeOperationString(observation.observerActorId, 160),
    observedActorId: sanitizeOperationString(observation.observedActorId, 160),
    sessionId: observation.sessionId ? sanitizeOperationString(observation.sessionId, 160) : undefined,
    level: observation.level,
    content: sanitizeOperationString(observation.content, 1000),
    confidence: observation.confidence,
    sourceEventIds: compactStringArray(observation.sourceEventIds, 10, 120),
    sourceObservationIds: compactStringArray(observation.sourceObservationIds, 10, 120),
    sourceRefs: sourceRefHints(observation.sourceEventIds),
    createdBy: observation.createdBy,
    metadata: observation.metadata ? compactRecord(observation.metadata, 10) : undefined,
    createdAt: isoDate(observation.createdAt),
    updatedAt: isoDate(observation.updatedAt),
    deletedAt: isoDate(observation.deletedAt)
  });
}

function formatFacet(facet: MemoryFacetAssignment): Record<string, unknown> {
  return {
    id: facet.id,
    targetType: facet.targetType,
    targetId: facet.targetId,
    dimension: facet.dimension,
    value: facet.value,
    confidence: facet.confidence,
    source: facet.source,
    evidenceEventIds: compactStringArray(facet.evidenceEventIds, 10, 120),
    projectHash: facet.projectHash,
    createdAt: isoDate(facet.createdAt),
    updatedAt: isoDate(facet.updatedAt)
  };
}

function formatAction(action: MemoryAction): Record<string, unknown> {
  return {
    actionId: action.actionId,
    projectHash: action.projectHash,
    title: action.title,
    status: action.status,
    priority: action.priority,
    sourceEventIds: compactStringArray(action.sourceEventIds, 10, 120),
    relatedEntityIds: compactStringArray(action.relatedEntityIds, 10, 120),
    currentCheckpointId: action.currentCheckpointId,
    leaseId: action.leaseId,
    createdAt: isoDate(action.createdAt),
    updatedAt: isoDate(action.updatedAt)
  };
}

function formatFrontierItem(item: FrontierItem): Record<string, unknown> {
  return {
    action: formatAction(item.action),
    score: item.score,
    reasons: compactStringArray(item.reasons, 10, 300),
    sourceRefs: compactArray(item.sourceRefs, 10)
  };
}

function formatCheckpoint(checkpoint: MemoryCheckpoint): Record<string, unknown> {
  return {
    checkpointId: checkpoint.checkpointId,
    projectHash: checkpoint.projectHash,
    actionId: checkpoint.actionId,
    sessionId: checkpoint.sessionId,
    title: checkpoint.title,
    summary: checkpoint.summary,
    stateJson: compactRecord(checkpoint.stateJson, 8),
    sourceEventIds: compactStringArray(checkpoint.sourceEventIds, 10, 120),
    createdAt: isoDate(checkpoint.createdAt),
    expiresAt: isoDate(checkpoint.expiresAt)
  };
}

function formatQueryEntityCandidate(candidate: QueryEntityCandidate): Record<string, unknown> {
  return omitUndefined({
    text: candidate.text,
    normalized: candidate.normalized,
    source: candidate.source,
    confidence: candidate.confidence,
    entityId: candidate.entityId,
    entityType: candidate.entityType,
    canonicalKey: candidate.canonicalKey,
    matchedAlias: candidate.matchedAlias
  });
}

function formatGraphResult(result: GraphPathExpandResult): Record<string, unknown> {
  return {
    startNodes: compactArray(result.startNodes, 10),
    effectiveMaxHops: result.effectiveMaxHops,
    paths: compactArray(result.paths, 20)
  };
}

function isoDate(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return undefined;
}

function jsonResult(payload: Record<string, unknown>): ToolResult {
  return textResult(JSON.stringify(sanitizeOperationOutput(payload), null, 2));
}

function sanitizeOperationRecord(input: Record<string, unknown>): Record<string, unknown> {
  return compactRecord(maskSensitiveInput(input), 30);
}

function compactStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, Math.max(0, maxItems))
    .map((item) => sanitizeOperationString(String(item), maxLength))
    .filter((item) => item.length > 0);
}

function compactArray(value: unknown, maxItems: number): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, Math.max(0, maxItems)).map((item) => sanitizeOperationOutput(item, 1));
}

function compactRecord(input: unknown, maxEntries: number): Record<string, unknown> {
  if (!isPlainRecord(input)) return {};
  const entries = Object.entries(input);
  const compacted = Object.fromEntries(
    entries
      .slice(0, Math.max(0, maxEntries))
      .map(([key, item]) => [sanitizeOperationKey(key), sanitizeOperationOutput(item, 1)])
  );
  if (entries.length > maxEntries) {
    compacted.__truncated = entries.length - maxEntries;
  }
  return compacted;
}

function sanitizeOperationOutput(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return sanitizeOperationString(value, 1000);
  if (value instanceof Date) return value.toISOString();
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 25).map((item) => sanitizeOperationOutput(item, depth + 1));
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 30)
        .map(([key, item]) => [sanitizeOperationKey(key), sanitizeOperationOutput(item, depth + 1)])
    );
  }
  return value;
}

function sanitizeOperationKey(key: string): string {
  if (/(api.*key|api.*token|access.*token|refresh.*token|client.*secret|private.*key|secret|password|passwd)/i.test(key)) {
    return '[REDACTED_KEY]';
  }
  return sanitizeOperationString(key, 120);
}

function sanitizeOperationString(value: string, maxLength: number): string {
  const masked = maskSensitiveInput({ value }).value;
  const asString = typeof masked === 'string' ? masked : String(value);
  const scrubbed = asString
    .replace(/[A-Za-z]:[\\/][^\s'"`<>)]*/g, '[path]')
    .replace(/~[\\/][^\s'"`<>)]*/g, '[path]')
    .replace(/(^|[\s([{=,:;])\/(?!\/)[^\s'"`<>)]*/g, '$1[path]');
  return safeInline(scrubbed, maxLength);
}

async function handleExternalMarketContext(args: Record<string, unknown>): Promise<ToolResult> {
  const report = await fetchExternalMarketContext({
    company: optionalString(args.company),
    dartCorpCode: optionalString(args.dartCorpCode),
    symbol: optionalString(args.symbol),
    providers: providerListArg(args.providers),
    fredSeries: stringListArg(args.fredSeries),
    includeSnapshot: args.includeSnapshot !== false
  });
  return textResult(renderExternalMarketContextReport(report));
}

async function handleMemSearch(memoryService: MemoryService, args: Record<string, unknown>): Promise<ToolResult> {
  const query = args.query as string;
  const topK = Math.min((args.topK as number) || 5, 20);
  const sessionId = args.sessionId as string | undefined;

  const search = await retrieveMcpMemories(memoryService, query, { topK, sessionId });

  const lines: string[] = [
    '## Memory Search Results',
    '',
    `Found ${search.memories.length} relevant memories:`,
    ''
  ];

  if (search.warning) {
    lines.push(search.warning, '');
  }

  for (let i = 0; i < search.memories.length; i++) {
    const m = search.memories[i];
    const citationId = generateCitationId(m.event.id);
    const date = m.event.timestamp.toISOString().split('T')[0];
    const preview = m.event.content.slice(0, 100) + (m.event.content.length > 100 ? '...' : '');

    lines.push(`### ${i + 1}. [mem:${citationId}] (score: ${m.score.toFixed(2)})`);
    lines.push(`**Type**: ${m.event.eventType} | **Date**: ${date}`);
    lines.push(`> ${preview}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('*Use `mem-details` with IDs for full content.*');

  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
}

interface McpMemoryRetrievalOptions {
  topK: number;
  sessionId?: string;
}

interface McpMemoryRetrievalResult {
  memories: ContextPackMemory[];
  warning?: string;
}

const SEMANTIC_VECTOR_FALLBACK_WARNING = 'Warning: semantic/vector retrieval unavailable; used keyword fallback.';
const SEMANTIC_VECTOR_FALLBACK_FAILED_WARNING = 'Warning: semantic/vector retrieval unavailable; keyword fallback failed.';

async function retrieveMcpMemories(
  memoryService: MemoryService,
  query: string,
  options: McpMemoryRetrievalOptions
): Promise<McpMemoryRetrievalResult> {
  try {
    const result = await memoryService.retrieveMemories(query, {
      topK: options.topK,
      sessionId: options.sessionId,
      recordTrace: false
    });
    return { memories: result.memories };
  } catch (error) {
    if (!isVectorSchemaMismatchError(error)) {
      throw error;
    }

    try {
      const memories = options.sessionId
        ? rankSessionKeywordMatches(
          query,
          await memoryService.getSessionHistory(options.sessionId),
          options.topK
        )
        : await memoryService.keywordSearch(query, { topK: options.topK });
      return { memories, warning: SEMANTIC_VECTOR_FALLBACK_WARNING };
    } catch {
      return { memories: [], warning: SEMANTIC_VECTOR_FALLBACK_FAILED_WARNING };
    }
  }
}

function isVectorSchemaMismatchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no vector column/i.test(message)
    || /query vector dimension/i.test(message)
    || /vector[^\n]{0,80}dimension/i.test(message)
    || /dimension[^\n]{0,80}vector/i.test(message)
    || /lancedb[^\n]{0,120}schema/i.test(message);
}

function rankSessionKeywordMatches(
  query: string,
  events: MemoryEvent[],
  topK: number
): ContextPackMemory[] {
  const queryTokens = tokenizeKeywordQuery(query);
  if (queryTokens.length === 0) return [];

  return events
    .map((event) => ({ event, score: scoreKeywordMatch(event.content, queryTokens) }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || b.event.timestamp.getTime() - a.event.timestamp.getTime())
    .slice(0, topK);
}

function tokenizeKeywordQuery(value: string): string[] {
  return Array.from(new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9가-힣_]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 1)
  ));
}

function scoreKeywordMatch(content: string, queryTokens: string[]): number {
  const haystack = content.toLowerCase();
  const hits = queryTokens.filter((token) => haystack.includes(token)).length;
  return hits / queryTokens.length;
}

async function handleMemTimeline(memoryService: MemoryService, args: Record<string, unknown>): Promise<ToolResult> {
  const ids = args.ids as string[];
  const windowSize = (args.windowSize as number) || 3;

  const recentEvents = await memoryService.getRecentEvents(10000);

  const lines: string[] = [
    '## Timeline Context',
    ''
  ];

  for (const targetId of ids) {
    // Find the target event
    const targetEvent = recentEvents.find(e =>
      e.id === targetId || generateCitationId(e.id) === targetId
    );

    if (!targetEvent) {
      lines.push(`Event ${targetId} not found.`);
      continue;
    }

    // Get session events
    const sessionEvents = recentEvents
      .filter(e => e.sessionId === targetEvent.sessionId)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const eventIndex = sessionEvents.findIndex(e => e.id === targetEvent.id);
    const start = Math.max(0, eventIndex - windowSize);
    const end = Math.min(sessionEvents.length, eventIndex + windowSize + 1);

    lines.push(`### Session: ${targetEvent.sessionId.slice(0, 8)}`);
    lines.push('');

    for (let i = start; i < end; i++) {
      const e = sessionEvents[i];
      const isTarget = e.id === targetEvent.id;
      const marker = isTarget ? '**→**' : '   ';
      const time = e.timestamp.toLocaleTimeString();
      const preview = e.content.slice(0, 60) + (e.content.length > 60 ? '...' : '');
      const citationId = generateCitationId(e.id);

      lines.push(`${marker} ${time} [${citationId}] ${e.eventType}: ${preview}`);
    }

    lines.push('');
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
}

async function handleMemDetails(memoryService: MemoryService, args: Record<string, unknown>): Promise<ToolResult> {
  const ids = args.ids as string[];

  const recentEvents = await memoryService.getRecentEvents(10000);

  const lines: string[] = [];

  for (const targetId of ids) {
    const event = recentEvents.find(e =>
      e.id === targetId || generateCitationId(e.id) === targetId
    );

    if (!event) {
      lines.push(`## Event ${targetId} not found.`);
      lines.push('');
      continue;
    }

    const citationId = generateCitationId(event.id);
    const date = event.timestamp.toISOString();

    lines.push(`## Memory: [mem:${citationId}]`);
    lines.push('');
    lines.push(`**Session**: ${event.sessionId}`);
    lines.push(`**Type**: ${event.eventType}`);
    lines.push(`**Date**: ${date}`);
    lines.push('');
    lines.push('**Content**:');
    lines.push('```');
    lines.push(event.content);
    lines.push('```');
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
}

async function handleMemContextPack(memoryService: MemoryService, args: Record<string, unknown>): Promise<ToolResult> {
  const query = stringArg(args.query, 'recent project context');
  const topK = numberArg(args.topK, 5, 1, 12);
  const recentLimit = numberArg(args.recentLimit, 30, 1, 200);
  const sessionLimit = numberArg(args.sessionLimit, 5, 1, 20);
  const sessionId = optionalString(args.sessionId);
  const projectPath = optionalString(args.projectPath);
  const genericContinuationQuery = isGenericContinuationQuery(query);
  const explicitFreshnessRefresh = args.refreshLatest === true;
  const autoFreshnessRefresh = args.refreshLatest !== false
    && !explicitFreshnessRefresh
    && genericContinuationQuery
    && sessionId === undefined
    && projectPath !== undefined
    && path.isAbsolute(projectPath);
  const retrievalTopK = Math.min(topK * 3, 12);
  const freshnessRun = explicitFreshnessRefresh || autoFreshnessRefresh
    ? await runLatestImport(memoryService, {
      projectPath: projectPath || '',
      sources: sourceListArg(args.refreshSources),
      sessionLimit: numberArg(args.refreshSessionLimit, 1, 1, 10),
      messageLimit: numberArg(args.refreshMessageLimit, 200, 1, 1000),
      force: args.refreshForce === true,
      processEmbeddings: args.refreshEmbeddings === true,
      sessionsDir: optionalString(args.sessionsDir),
      stateDb: optionalString(args.stateDb)
    })
    : undefined;

  const search = await retrieveMcpMemories(memoryService, query, { topK: retrievalTopK, sessionId });
  const recentEvents = await memoryService.getRecentEvents(recentLimit);

  const timelineEvents = selectContextPackTimelineEvents(
    recentEvents,
    projectPath,
    genericContinuationQuery
  );
  const sessions = summarizeSessions(timelineEvents, sessionLimit);
  const recentSessionIds = new Set(sessions.map((session) => session.sessionId));
  const relevantMemories = selectContextPackMemories(search.memories, {
    genericContinuationQuery,
    topK,
    recentSessionIds,
    projectPath
  });
  const hasPerspectiveContext = optionalString(args.observerActorId) !== undefined
    || optionalString(args.targetActorId) !== undefined
    || optionalString(args.observedActorId) !== undefined;
  const perspectiveBundle = hasPerspectiveContext
    ? await withMemoryOperationContext(args, (context) => loadPerspectiveContextBundle(context, args, {
      query,
      defaultLimit: perspectiveObservationLimit(args.reasoningLevel)
    }))
    : undefined;

  const lines: string[] = [
    '## Project Context Pack',
    '',
    `- Query: ${safeInline(query, 160)}`,
    `- Relevant memories: ${relevantMemories.length}`,
    `- Recent events inspected: ${recentEvents.length}`,
    `- Recent sessions shown: ${Math.min(sessionLimit, sessions.length)}`
  ];

  if (freshnessRun) {
    const refreshMode = autoFreshnessRefresh ? 'auto' : 'attempted';
    lines.push(
      `- Freshness refresh: ${refreshMode} before retrieval (${freshnessRun.sources.join(', ')})`,
      `- Refresh limits: sessions=${freshnessRun.sessionLimit} messages=${freshnessRun.messageLimit} force=${freshnessRun.force ? 'yes' : 'no'} embeddings=${freshnessRun.processEmbeddings ? `processed ${freshnessRun.embeddingsProcessed ?? 0}` : 'skipped'}`
    );
  }

  if (search.warning) {
    lines.push(`- ${search.warning}`);
  }

  if (genericContinuationQuery) {
    lines.push('- Generic continuation query: recent project timeline prioritized.');
  }
  lines.push('');

  if (freshnessRun) {
    lines.push('### Freshness Refresh', '');
    for (const summary of freshnessRun.summaries) {
      if (summary.result) {
        lines.push(formatImportSummary(summary.source, summary.result));
      } else {
        lines.push(`- ${summary.source}: failed (${summary.error ?? 'details suppressed'})`);
      }
    }
    const failedCount = freshnessRun.summaries.filter((summary) => summary.error).length;
    if (failedCount > 0) {
      lines.push('', `Warnings: ${failedCount} refresh source(s) failed; local path details were suppressed.`);
    }
    lines.push('');
  }

  if (genericContinuationQuery) {
    appendRecentTimeline(lines, sessions);
    appendRelevantMemories(lines, relevantMemories);
  } else {
    appendRelevantMemories(lines, relevantMemories);
    appendRecentTimeline(lines, sessions);
  }

  if (perspectiveBundle) {
    appendPerspectiveContext(lines, perspectiveBundle);
  }

  const sourceIds = relevantMemories
    .slice(0, 5)
    .map((match) => generateCitationId(match.event.id));
  if (sourceIds.length > 0) {
    lines.push('### Follow-up Lookups', '');
    lines.push(`- Source refs: mem-source-ref ids=[${sourceIds.map((id) => `'${id}'`).join(', ')}]`);
    lines.push('- Wider timeline: mem-project-timeline with the same projectPath');
    lines.push('');
  }

  return textResult(lines.join('\n'));
}

type LatestImportSource = 'claude' | 'codex' | 'hermes';

interface LatestImportSummary {
  source: LatestImportSource;
  result?: ImportResult;
  error?: string;
}

interface LatestImportRun {
  sources: LatestImportSource[];
  sessionLimit: number;
  messageLimit: number;
  force: boolean;
  processEmbeddings: boolean;
  embeddingsProcessed?: number;
  summaries: LatestImportSummary[];
}

interface LatestImportRunOptions {
  projectPath: string;
  sources: LatestImportSource[];
  sessionLimit: number;
  messageLimit: number;
  force: boolean;
  processEmbeddings: boolean;
  sessionsDir?: string;
  stateDb?: string;
}

async function runLatestImport(memoryService: MemoryService, options: LatestImportRunOptions): Promise<LatestImportRun> {
  const summaries: LatestImportSummary[] = [];

  for (const source of options.sources) {
    try {
      if (source === 'claude') {
        const importer = createSessionHistoryImporter(memoryService);
        summaries.push({
          source,
          result: await importer.importProject(options.projectPath, {
            projectPath: options.projectPath,
            sessionLimit: options.sessionLimit,
            limit: options.messageLimit,
            force: options.force
          })
        });
      } else if (source === 'codex') {
        const importer = createCodexSessionHistoryImporter(memoryService, { sessionsDir: options.sessionsDir });
        summaries.push({
          source,
          result: await importer.importProject(options.projectPath, {
            projectPath: options.projectPath,
            sessionLimit: options.sessionLimit,
            limit: options.messageLimit,
            force: options.force
          })
        });
      } else {
        const importer = createHermesSessionHistoryImporter(memoryService, { stateDbPath: options.stateDb });
        summaries.push({
          source,
          result: await importer.importProject(options.projectPath, {
            projectPath: options.projectPath,
            sessionLimit: options.sessionLimit,
            limit: options.messageLimit,
            force: options.force
          })
        });
      }
    } catch (error) {
      summaries.push({ source, error: safeErrorSummary(error) });
    }
  }

  const embeddingsProcessed = options.processEmbeddings
    ? await memoryService.processPendingEmbeddings()
    : undefined;

  return {
    sources: options.sources,
    sessionLimit: options.sessionLimit,
    messageLimit: options.messageLimit,
    force: options.force,
    processEmbeddings: options.processEmbeddings,
    embeddingsProcessed,
    summaries
  };
}

async function handleMemImportLatest(memoryService: MemoryService, args: Record<string, unknown>): Promise<ToolResult> {
  const projectPath = optionalString(args.projectPath);
  if (!projectPath) {
    return {
      content: [{ type: 'text', text: 'Error: mem-import-latest requires an explicit projectPath.' }],
      isError: true
    };
  }

  const importRun = await runLatestImport(memoryService, {
    projectPath,
    sources: sourceListArg(args.sources),
    sessionLimit: numberArg(args.sessionLimit, 1, 1, 10),
    messageLimit: numberArg(args.messageLimit, 200, 1, 1000),
    force: args.force === true,
    processEmbeddings: args.processEmbeddings === true,
    sessionsDir: optionalString(args.sessionsDir),
    stateDb: optionalString(args.stateDb)
  });

  const lines: string[] = [
    '## Latest Session Import',
    '',
    '- Project: supplied',
    `- Sources: ${importRun.sources.join(', ')}`,
    `- Recent session limit per source: ${importRun.sessionLimit}`,
    `- Message limit per source: ${importRun.messageLimit}`,
    `- Force reimport: ${importRun.force ? 'yes' : 'no'}`,
    `- Embeddings: ${importRun.processEmbeddings ? `processed ${importRun.embeddingsProcessed ?? 0}` : 'skipped'}`,
    '',
    '### Source Results',
    ''
  ];

  for (const summary of importRun.summaries) {
    if (summary.result) {
      lines.push(formatImportSummary(summary.source, summary.result));
    } else {
      lines.push(`- ${summary.source}: failed (${summary.error ?? 'details suppressed'})`);
    }
  }

  const failedCount = importRun.summaries.filter((summary) => summary.error).length;
  if (failedCount > 0) {
    lines.push('', `Warnings: ${failedCount} source(s) failed; local path details were suppressed.`);
  }

  return textResult(lines.join('\n'));
}

async function handleMemProjectTimeline(memoryService: MemoryService, args: Record<string, unknown>): Promise<ToolResult> {
  const limit = numberArg(args.limit, 50, 1, 500);
  const sessionLimit = numberArg(args.sessionLimit, 10, 1, 50);
  const recentEvents = await memoryService.getRecentEvents(limit);
  const sessions = summarizeSessions(recentEvents, sessionLimit);

  const lines: string[] = [
    '## Project Memory Timeline',
    '',
    `Events inspected: ${recentEvents.length}`,
    `Sessions shown: ${sessions.length}`,
    ''
  ];

  if (sessions.length === 0) {
    lines.push('No recent project events found.', '');
  } else {
    for (const session of sessions) {
      lines.push(formatSessionSummary(session));
    }
  }

  return textResult(lines.join('\n'));
}

async function handleMemSourceRef(memoryService: MemoryService, args: Record<string, unknown>): Promise<ToolResult> {
  const ids = Array.isArray(args.ids)
    ? args.ids.map((id) => String(id)).filter((id) => id.trim().length > 0)
    : [];
  const maxContentChars = numberArg(args.maxContentChars, 500, 80, 2000);
  const lookupLimit = numberArg(args.lookupLimit, 10000, 1, 50000);
  const recentEvents = await memoryService.getRecentEvents(lookupLimit);

  const lines: string[] = ['## Source References', ''];

  if (ids.length === 0) {
    lines.push('No IDs supplied.', '');
    return textResult(lines.join('\n'));
  }

  for (const requestedId of ids) {
    const event = findEventByReference(recentEvents, requestedId);
    if (!event) {
      lines.push(`### ${safeInline(requestedId, 80)} not found`, '');
      continue;
    }

    const citationId = generateCitationId(event.id);
    const metadata = safeMetadata(event.metadata);
    lines.push(`### [mem:${citationId}]`);
    lines.push(`- Event ID: ${event.id}`);
    lines.push(`- Source Ref: event:${event.id}`);
    lines.push(`- Source Type: ${sourceTypeForEvent(event)}`);
    lines.push(`- Session: ${event.sessionId}`);
    lines.push(`- Type: ${event.eventType}`);
    lines.push(`- Timestamp: ${event.timestamp.toISOString()}`);

    const metadataLines = Object.entries(metadata).map(([key, value]) => `  - ${key}: ${formatMetadataValue(value)}`);
    if (metadataLines.length > 0) {
      lines.push('- Safe Metadata:');
      lines.push(...metadataLines);
    }

    lines.push('- Redacted Preview:');
    lines.push(`  > ${safeInline(event.content, maxContentChars)}`);
    lines.push('');
  }

  return textResult(lines.join('\n'));
}

interface ContextPackMemory {
  event: MemoryEvent;
  score: number;
}

interface ContextPackSelectionOptions {
  genericContinuationQuery: boolean;
  topK: number;
  recentSessionIds: Set<string>;
  projectPath?: string;
}

const GENERIC_RELEVANT_MEMORY_LIMIT = 2;
const GENERIC_RECENT_MEMORY_MIN_SCORE = 0.7;
const GENERIC_STALE_MEMORY_MIN_SCORE = 0.8;
const GENERIC_SESSION_SUMMARY_MIN_SCORE = 0.7;
const GENERIC_TIMELINE_FRESHNESS_WINDOW_MS = 2 * 60 * 60 * 1000;

interface SessionSummary {
  sessionId: string;
  firstAt: Date;
  lastAt: Date;
  events: MemoryEvent[];
  eventCounts: Record<EventType, number>;
  source: string;
  lastPreview: string;
}

function summarizeSessions(events: MemoryEvent[], sessionLimit: number): SessionSummary[] {
  const bySession = new Map<string, MemoryEvent[]>();
  for (const event of events) {
    const sessionEvents = bySession.get(event.sessionId) || [];
    sessionEvents.push(event);
    bySession.set(event.sessionId, sessionEvents);
  }

  return Array.from(bySession.entries())
    .map(([sessionId, sessionEvents]) => {
      const sorted = sessionEvents.slice().sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      const last = sorted[sorted.length - 1];
      return {
        sessionId,
        firstAt: sorted[0].timestamp,
        lastAt: last.timestamp,
        events: sorted,
        eventCounts: countEventTypes(sorted),
        source: dominantSource(sorted),
        lastPreview: safeInline(last.content, 180)
      };
    })
    .sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime())
    .slice(0, sessionLimit);
}

function selectContextPackMemories(
  memories: ContextPackMemory[],
  options: ContextPackSelectionOptions
): ContextPackMemory[] {
  const selected = memories.filter((memory) => shouldShowContextPackMemory(memory, options));
  if (!options.genericContinuationQuery) return selected.slice(0, options.topK);

  return selected
    .slice()
    .sort((a, b) => contextPackMemoryPriority(b, options) - contextPackMemoryPriority(a, options))
    .slice(0, Math.min(options.topK, GENERIC_RELEVANT_MEMORY_LIMIT));
}

function selectContextPackTimelineEvents(
  events: MemoryEvent[],
  projectPath: string | undefined,
  genericContinuationQuery: boolean
): MemoryEvent[] {
  const filtered = events.filter((event) => shouldShowContextPackTimelineEvent(
    event,
    projectPath,
    genericContinuationQuery
  ));
  if (!genericContinuationQuery || filtered.length === 0) return filtered;

  const newestTimestamp = Math.max(...filtered.map((event) => event.timestamp.getTime()));
  const freshEvents = filtered.filter((event) => newestTimestamp - event.timestamp.getTime() <= GENERIC_TIMELINE_FRESHNESS_WINDOW_MS);
  return freshEvents.length > 0 ? freshEvents : filtered;
}

function shouldShowContextPackTimelineEvent(
  event: MemoryEvent,
  projectPath: string | undefined,
  genericContinuationQuery: boolean
): boolean {
  const content = event.content || '';
  if (isLowSignalContextContent(content)) return false;
  if (event.eventType === 'tool_observation') return false;
  if (eventBelongsToDifferentProject(event, projectPath)) return false;
  if (genericContinuationQuery && isGenericContinuationQuery(content)) return false;
  return true;
}

function shouldShowContextPackMemory(memory: ContextPackMemory, options: ContextPackSelectionOptions): boolean {
  const content = memory.event.content || '';
  if (isLowSignalContextContent(content)) return false;
  if (memory.event.eventType === 'tool_observation') return false;
  if (eventBelongsToDifferentProject(memory.event, options.projectPath)) return false;
  if (!options.genericContinuationQuery) return true;

  if (isGenericContinuationQuery(content)) return false;
  if (memory.event.eventType === 'session_summary') return memory.score >= GENERIC_SESSION_SUMMARY_MIN_SCORE;
  if (options.recentSessionIds.has(memory.event.sessionId)) return memory.score >= GENERIC_RECENT_MEMORY_MIN_SCORE;
  return memory.score >= GENERIC_STALE_MEMORY_MIN_SCORE;
}

function eventBelongsToDifferentProject(event: MemoryEvent, projectPath?: string): boolean {
  if (!projectPath) return false;
  const metadata = event.metadata || {};
  const metadataProjectRefs = metadataProjectReferenceValues(metadata);

  if (metadataProjectRefs.length > 0) {
    return !metadataProjectRefs.some((value) => projectReferenceMatches(value, projectPath));
  }

  if (isUnscopedImportedHistory(metadata)) return true;

  return mentionsDifferentWorkspaceProject(event.content || '', projectPath);
}

function isUnscopedImportedHistory(metadata: Record<string, unknown>): boolean {
  return typeof metadata.importedFrom === 'string'
    || typeof metadata.sourceSessionId === 'string'
    || typeof metadata.sourceSessionHash === 'string'
    || typeof metadata.transcriptPath === 'string';
}

const PROJECT_METADATA_KEYS = new Set([
  'projectPath',
  'sourceProjectPath',
  'workspacePath',
  'sourceWorkspacePath',
  'cwd',
  'sourceCwd',
  'currentWorkingDirectory',
  'projectRoot',
  'repoPath',
  'repositoryPath'
]);

function metadataProjectReferenceValues(metadata: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (!PROJECT_METADATA_KEYS.has(key)) continue;
    if (typeof value === 'string' && value.trim().length > 0) {
      values.push(value.trim());
    }
  }
  return values;
}

function projectReferenceMatches(reference: string, projectPath: string): boolean {
  const normalizedReference = normalizeProjectReference(reference);
  const normalizedProjectPath = normalizeProjectReference(projectPath);
  if (normalizedReference === normalizedProjectPath) return true;
  return normalizedReference.startsWith(`${normalizedProjectPath}/`);
}

function normalizeProjectReference(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
}

function mentionsDifferentWorkspaceProject(content: string, projectPath?: string): boolean {
  const currentProject = basenameOfPath(projectPath);
  if (!currentProject) return false;

  const workspaceProjectNames = Array.from(content.matchAll(/[\\/](?:workspace|workspaces|projects)[\\/]([^\\/\s'"`<>]+)/gi))
    .map((match) => normalizeProjectName(match[1]))
    .filter((name) => name.length > 0);

  if (workspaceProjectNames.length === 0) return false;
  return !workspaceProjectNames.includes(currentProject);
}

function basenameOfPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parts = value
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  const last = parts[parts.length - 1];
  return last ? normalizeProjectName(last) : undefined;
}

function normalizeProjectName(value: string): string {
  return value.trim().replace(/[.,;:!?]+$/g, '').toLowerCase();
}

function contextPackMemoryPriority(memory: ContextPackMemory, options: ContextPackSelectionOptions): number {
  const recentBoost = options.recentSessionIds.has(memory.event.sessionId) ? 2 : 0;
  const typeBoost = memory.event.eventType === 'session_summary'
    ? 0.5
    : memory.event.eventType === 'agent_response'
      ? 0.3
      : 0;
  return recentBoost + typeBoost + Math.min(memory.score, 1) + memory.event.timestamp.getTime() / 1e15;
}

function appendRelevantMemories(lines: string[], memories: ContextPackMemory[]): void {
  lines.push('### Relevant Memories', '');
  if (memories.length === 0) {
    lines.push('No relevant memories found.', '');
    return;
  }

  for (let i = 0; i < memories.length; i++) {
    const match = memories[i];
    lines.push(formatRelevantMemoryLine(match.event, match.score, i + 1));
  }
}

function appendRecentTimeline(lines: string[], sessions: SessionSummary[]): void {
  lines.push('### Recent Project Timeline', '');
  if (sessions.length === 0) {
    lines.push('No recent project events found.', '');
    return;
  }

  for (const session of sessions) {
    lines.push(formatSessionSummary(session));
  }
}

function appendPerspectiveContext(lines: string[], bundle: PerspectiveContextBundle): void {
  lines.push('### Perspective Context', '');
  lines.push(`- Observer: ${sanitizeOperationString(bundle.observerActorId, 160)}`);
  lines.push(`- Target: ${sanitizeOperationString(bundle.targetActorId, 160)}`);
  if (!bundle.card && bundle.observations.length === 0) {
    lines.push('- No actor card or perspective observations found.', '');
    return;
  }

  if (bundle.card) {
    lines.push('', 'Actor Card:');
    for (const entry of bundle.card.entries.slice(0, 40)) {
      lines.push(`- ${sanitizeOperationString(entry, 200)}`);
    }
    const refs = sourceRefHints(bundle.card.sourceEventIds);
    if (refs.length > 0) lines.push(`- Source refs: ${refs.join('; ')}`);
  }

  if (bundle.observations.length > 0) {
    lines.push('', 'Observations:');
    for (const observation of bundle.observations.slice(0, 20)) {
      const sourceRefs = sourceRefHints(observation.sourceEventIds);
      const refSuffix = sourceRefs.length > 0 ? ` | ${sourceRefs.join('; ')}` : '';
      lines.push(`- [${observation.level} ${observation.confidence.toFixed(2)}] ${sanitizeOperationString(observation.content, 500)}${refSuffix}`);
    }
  }
  lines.push('');
}

function countEventTypes(events: MemoryEvent[]): Record<EventType, number> {
  return events.reduce((acc, event) => {
    acc[event.eventType] = (acc[event.eventType] || 0) + 1;
    return acc;
  }, {} as Record<EventType, number>);
}

function dominantSource(events: MemoryEvent[]): string {
  const counts = new Map<string, number>();
  for (const event of events) {
    const source = sourceForEvent(event);
    counts.set(source, (counts.get(source) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || 'unknown';
}

function sourceForEvent(event: MemoryEvent): string {
  const metadata = event.metadata || {};
  for (const key of ['sourceAgent', 'agent', 'source']) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      const safeSource = safeInline(value.trim(), 120);
      return safeSource.length > 0 ? safeSource : 'unknown';
    }
  }
  return 'native';
}

function sourceTypeForEvent(event: MemoryEvent): string {
  if (event.eventType === 'tool_observation') return 'tool_output';
  if (typeof event.metadata?.importedFrom === 'string') return 'imported_history';
  if (typeof event.metadata?.transcriptPath === 'string') return 'transcript';
  return 'raw_event';
}

function formatRelevantMemoryLine(event: MemoryEvent, score: number, index: number): string {
  const citationId = generateCitationId(event.id);
  return [
    `${index}. [mem:${citationId}] score=${score.toFixed(2)} type=${event.eventType} date=${event.timestamp.toISOString()} session=${event.sessionId}`,
    `   source=${sourceForEvent(event)}`,
    `   ${safeInline(event.content, 260)}`,
    ''
  ].join('\n');
}

function formatSessionSummary(session: SessionSummary): string {
  const countSummary = (Object.entries(session.eventCounts) as Array<[EventType, number]>)
    .map(([type, count]) => `${type}: ${count}`)
    .join(', ');
  return [
    `- Session: ${session.sessionId}`,
    `  Window: ${session.firstAt.toISOString()} → ${session.lastAt.toISOString()}`,
    `  Events: ${session.events.length}`,
    `  Source: ${session.source}`,
    `  Counts: ${countSummary || 'n/a'}`,
    `  Last: ${session.lastPreview}`,
    ''
  ].join('\n');
}

function findEventByReference(events: MemoryEvent[], requestedId: string): MemoryEvent | undefined {
  const raw = requestedId.trim();
  const normalized = normalizeReference(raw);
  return events.find((event) => {
    const citationId = generateCitationId(event.id);
    return event.id === normalized ||
      event.id === raw ||
      `event:${event.id}` === raw ||
      citationId === normalized ||
      `mem:${citationId}` === raw ||
      `[mem:${citationId}]` === raw;
  });
}

function normalizeReference(id: string): string {
  let normalized = id.trim();
  const memMatch = normalized.match(/^\[?mem:([A-Za-z0-9]{6})\]?$/);
  if (memMatch) return memMatch[1];
  if (normalized.startsWith('event:')) normalized = normalized.slice('event:'.length);
  return normalized;
}

const SAFE_METADATA_KEYS = new Set([
  'source',
  'sourceAgent',
  'agent',
  'model',
  'provider',
  'toolName',
  'turnId',
  'messageId',
  'role'
]);

function safeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata) return {};
  const allowed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SAFE_METADATA_KEYS.has(key)) allowed[key] = value;
  }
  return maskSensitiveInput(allowed);
}

const MCP_PRIVACY_CONFIG: Config['privacy'] = {
  excludePatterns: ['password', 'secret', 'api_key', 'api-key', 'token', 'bearer'],
  anonymize: false,
  privateTags: {
    enabled: true,
    marker: '[REDACTED]',
    preserveLineCount: false,
    supportedFormats: ['xml', 'bracket', 'comment']
  }
};

function safeInline(content: string, maxLength: number): string {
  const filtered = applyPrivacyFilter(content, MCP_PRIVACY_CONFIG).content;
  const normalized = filtered.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function stringArg(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function stringListArg(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const selected = value.map((item) => String(item).trim()).filter(Boolean);
  return selected.length > 0 ? Array.from(new Set(selected)) : undefined;
}

function providerListArg(value: unknown): ExternalMarketProvider[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Invalid providers: expected a non-empty array of dart, fred, or finnhub');
  }
  const allowed = new Set<ExternalMarketProvider>(['dart', 'fred', 'finnhub']);
  const selected: ExternalMarketProvider[] = [];
  for (const item of value) {
    const normalized = String(item).trim().toLowerCase() as ExternalMarketProvider;
    if (!allowed.has(normalized)) {
      throw new Error('Invalid providers: expected dart, fred, or finnhub');
    }
    if (!selected.includes(normalized)) selected.push(normalized);
  }
  return selected;
}

function sourceListArg(value: unknown): LatestImportSource[] {
  const fallback: LatestImportSource[] = ['hermes', 'codex'];
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Invalid sources: expected a non-empty array of claude, codex, or hermes');
  }

  const allowed = new Set<LatestImportSource>(['claude', 'codex', 'hermes']);
  const selected: LatestImportSource[] = [];
  for (const item of value) {
    const normalized = String(item).trim().toLowerCase() as LatestImportSource;
    if (!allowed.has(normalized)) {
      throw new Error('Invalid source: expected claude, codex, or hermes');
    }
    if (!selected.includes(normalized)) selected.push(normalized);
  }
  return selected;
}

function formatImportSummary(source: LatestImportSource, result: ImportResult): string {
  return `- ${source}: sessions=${result.totalSessions} messages=${result.totalMessages} prompts=${result.importedPrompts} responses=${result.importedResponses} skipped=${result.skippedDuplicates} errors=${result.errors.length}`;
}

function safeErrorSummary(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const scrubbedPaths = raw
    .replace(/[A-Za-z]:[\\/][^\s'"`<>)]*/g, '[path]')
    .replace(/~[\\/][^\s'"`<>)]*/g, '[path]')
    .replace(/(^|[\s([{=,:;])\/(?!\/)[^\s'"`<>)]*/g, '$1[path]')
    .replace(/(^|[\s([{=,:;])(?:\.{1,2}[\\/])?[^\s'"`<>)]*\.(?:db|sqlite|jsonl|log|txt)\b[^\s'"`<>)]*/g, '$1[path]');
  return safeInline(scrubbedPaths, 180) || 'details suppressed';
}

function numberArg(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function boundedNumberArg(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function formatMetadataValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => formatMetadataValue(item)).join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

interface McpOutboxStats {
  embedding: { pending: number; processing: number; failed: number; total: number };
  vector: { pending: number; processing: number; failed: number; total: number };
}

interface McpStatsStorageView {
  storageView: string;
  storagePathLabel: string;
  embedderModel: string;
  vectorTableDimension: string;
}

async function handleMemStats(memoryService: MemoryService, args: Record<string, unknown>): Promise<ToolResult> {
  const stats = await memoryService.getStats();
  const recentEvents = await memoryService.getRecentEvents(10000);
  const outboxStats = await readMcpOutboxStats(memoryService);
  const storageView = buildMcpStatsStorageView(optionalString(args.projectPath));

  const uniqueSessions = new Set(recentEvents.map(e => e.sessionId));

  const lines: string[] = [
    '## Memory Statistics',
    '',
    `- **Total Events**: ${stats.totalEvents}`,
    `- **Total Vectors**: ${stats.vectorCount}`,
    `- **Sessions**: ${uniqueSessions.size}`,
    '',
    '### Storage View / Freshness',
    '',
    `- Storage View: ${storageView.storageView}`,
    `- Storage Path Label: ${storageView.storagePathLabel}`,
    `- Embedder Model: ${storageView.embedderModel}`,
    `- Vector Table Dimension: ${storageView.vectorTableDimension}`,
    `- Pending Embeddings: ${outboxStats.embedding.pending}`,
    `- Embedding Outbox: pending=${outboxStats.embedding.pending}, processing=${outboxStats.embedding.processing}, failed=${outboxStats.embedding.failed}, total=${outboxStats.embedding.total}`,
    `- Vector Outbox Pending: ${outboxStats.vector.pending}`,
    `- Vector Outbox: pending=${outboxStats.vector.pending}, processing=${outboxStats.vector.processing}, failed=${outboxStats.vector.failed}, total=${outboxStats.vector.total}`,
    '- MCP/CLI parity: CLI `stats -p <project>` and MCP `mem-stats(projectPath=...)` should use this same storage view label.',
    '- Restart guidance: if CLI and MCP counts differ for this storage view after import/build, restart the long-lived MCP/Hermes gateway process.',
    '',
    '### Events by Type',
    ''
  ];

  const eventsByType = recentEvents.reduce((acc, e) => {
    acc[e.eventType] = (acc[e.eventType] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  for (const [type, count] of Object.entries(eventsByType)) {
    lines.push(`- ${type}: ${count}`);
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
}

async function readMcpOutboxStats(memoryService: MemoryService): Promise<McpOutboxStats> {
  try {
    return await memoryService.getOutboxStats();
  } catch {
    return {
      embedding: { pending: 0, processing: 0, failed: 0, total: 0 },
      vector: { pending: 0, processing: 0, failed: 0, total: 0 }
    };
  }
}

function buildMcpStatsStorageView(projectPath?: string): McpStatsStorageView {
  const embedderModel = process.env.CLAUDE_MEMORY_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
  const requestedProjectPath = projectPath?.trim();
  if (requestedProjectPath) {
    const projectHash = hashProjectPath(requestedProjectPath);
    return {
      storageView: `project:${projectHash}`,
      storagePathLabel: `~/.claude-code/memory/projects/${projectHash}`,
      embedderModel,
      vectorTableDimension: 'unknown (not recorded in current vector metadata)'
    };
  }

  return {
    storageView: 'global',
    storagePathLabel: '~/.claude-code/memory',
    embedderModel,
    vectorTableDimension: 'unknown (not recorded in current vector metadata)'
  };
}
