/**
 * MCP Tool Handlers
 * Implementation of tool calls
 */

import {
  getDefaultMemoryService,
  getMemoryServiceForProject,
  type MemoryService
} from '../../services/memory-service.js';
import { generateCitationId } from '../../core/citation-generator.js';
import { applyPrivacyFilter, maskSensitiveInput } from '../../core/privacy/filter.js';
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
        return await handleMemStats(memoryService);

      case 'mem-context-pack':
        return await handleMemContextPack(memoryService, args);

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
      content: [{ type: 'text', text: `Error: ${(error as Error).message}` }],
      isError: true
    };
  }
}

async function handleMemSearch(memoryService: MemoryService, args: Record<string, unknown>): Promise<ToolResult> {
  const query = args.query as string;
  const topK = Math.min((args.topK as number) || 5, 20);

  const result = await memoryService.retrieveMemories(query, {
    topK,
    sessionId: args.sessionId as string,
    recordTrace: false
  });

  const lines: string[] = [
    '## Memory Search Results',
    '',
    `Found ${result.memories.length} relevant memories:`,
    ''
  ];

  for (let i = 0; i < result.memories.length; i++) {
    const m = result.memories[i];
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
  const genericContinuationQuery = isGenericContinuationQuery(query);
  const retrievalTopK = genericContinuationQuery ? Math.min(topK * 3, 12) : topK;

  const [searchResult, recentEvents] = await Promise.all([
    memoryService.retrieveMemories(query, { topK: retrievalTopK, sessionId, recordTrace: false }),
    memoryService.getRecentEvents(recentLimit)
  ]);

  const timelineEvents = genericContinuationQuery
    ? recentEvents.filter(shouldShowGenericTimelineEvent)
    : recentEvents;
  const sessions = summarizeSessions(timelineEvents, sessionLimit);
  const recentSessionIds = new Set(sessions.map((session) => session.sessionId));
  const relevantMemories = selectContextPackMemories(searchResult.memories, {
    genericContinuationQuery,
    topK,
    recentSessionIds
  });

  const lines: string[] = [
    '## Project Context Pack',
    '',
    `- Query: ${safeInline(query, 160)}`,
    `- Relevant memories: ${relevantMemories.length}`,
    `- Recent events inspected: ${recentEvents.length}`,
    `- Recent sessions shown: ${Math.min(sessionLimit, sessions.length)}`
  ];

  if (genericContinuationQuery) {
    lines.push('- Generic continuation query: recent project timeline prioritized.');
  }
  lines.push('');

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
}

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
    .slice(0, options.topK);
}

function shouldShowGenericTimelineEvent(event: MemoryEvent): boolean {
  const content = event.content || '';
  if (isLowSignalContextContent(content)) return false;
  if (event.eventType === 'tool_observation') return false;
  if (isGenericContinuationQuery(content)) return false;
  return true;
}

function shouldShowContextPackMemory(memory: ContextPackMemory, options: ContextPackSelectionOptions): boolean {
  if (!options.genericContinuationQuery) return true;

  const content = memory.event.content || '';
  if (isLowSignalContextContent(content)) return false;
  if (memory.event.eventType === 'tool_observation') return false;
  if (isGenericContinuationQuery(content)) return false;
  if (options.recentSessionIds.has(memory.event.sessionId)) return true;
  if (memory.event.eventType === 'session_summary') return memory.score >= 0.55;
  return memory.score >= 0.75;
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

async function handleMemStats(memoryService: MemoryService): Promise<ToolResult> {
  const stats = await memoryService.getStats();
  const recentEvents = await memoryService.getRecentEvents(10000);

  const uniqueSessions = new Set(recentEvents.map(e => e.sessionId));

  const lines: string[] = [
    '## Memory Statistics',
    '',
    `- **Total Events**: ${stats.totalEvents}`,
    `- **Total Vectors**: ${stats.vectorCount}`,
    `- **Sessions**: ${uniqueSessions.size}`,
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
