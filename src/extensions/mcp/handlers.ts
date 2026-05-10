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
import { createSessionHistoryImporter, type ImportResult } from '../../services/session-history-importer.js';
import { createCodexSessionHistoryImporter } from '../../services/codex-session-history-importer.js';
import { createHermesSessionHistoryImporter } from '../../services/hermes-session-history-importer.js';
import {
  fetchExternalMarketContext,
  renderExternalMarketContextReport,
  type ExternalMarketProvider
} from '../../core/external-market-context.js';
import { generateCitationId } from '../../core/citation-generator.js';
import { hashProjectPath } from '../../core/registry/project-path.js';
import { applyPrivacyFilter, maskSensitiveInput } from '../../core/privacy/filter.js';
import { DEFAULT_EMBEDDING_MODEL } from '../../extensions/vector/embedder.js';
import {
  isGenericContinuationQuery,
  isLowSignalContextContent
} from '../../core/retrieval-quality.js';
import type { Config, EventType, MemoryEvent } from '../../core/types.js';
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

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  try {
    if (name === 'external-market-context') {
      return await handleExternalMarketContext(args);
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
