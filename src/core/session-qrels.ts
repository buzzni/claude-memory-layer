import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';

export interface SessionQrelsMemory {
  id: string;
  content: string;
  sourceSessionId: string;
  sourceTurnIndex: number;
  timestamp?: string;
}

export type SessionQrelsExpectation = 'match' | 'no_match';

export interface SessionQrelsQuery {
  queryId: string;
  query: string;
  expectedIds: string[];
  expectedRelevance: Record<string, number>;
  sourceSessionId: string;
  sourceTurnIndex: number;
  expectation?: SessionQrelsExpectation;
  forbiddenIds?: string[];
  knownAnswer?: string;
}

export interface SessionQrelsFixtureMetadata {
  sourceFileCount?: number;
  rawContentIncluded: boolean;
  generatedAt?: string;
}

export interface SessionQrelsFixture {
  name: string;
  description: string;
  ks: number[];
  queries: SessionQrelsQuery[];
  memories: SessionQrelsMemory[];
  metadata?: SessionQrelsFixtureMetadata;
}

export interface SessionQrelsNoMatchQueryInput {
  queryId?: string;
  query: string;
  forbiddenIds?: string[];
  sourceSessionId?: string;
  sourceTurnIndex?: number;
}

export interface SessionQrelsOptions {
  name?: string;
  description?: string;
  ks?: number[];
  maxQueries?: number;
  redactContent?: boolean;
  sourceFileCount?: number;
  rawContentIncluded?: boolean;
  generatedAt?: string;
  noMatchQueries?: SessionQrelsNoMatchQueryInput[];
}

export interface SessionQrelsFileCollectionOptions {
  includeSubagents?: boolean;
  maxFiles?: number;
  minBytes?: number;
}

export interface SessionQrelsPerSessionSummary {
  sourceSessionId: string;
  queryCount: number;
  memoryCount: number;
  firstTurnIndex: number;
  lastTurnIndex: number;
}

export interface SessionQrelsSummary {
  name: string;
  description: string;
  ks: number[];
  queryCount: number;
  positiveQueryCount: number;
  noMatchQueryCount: number;
  knownAnswerCount: number;
  memoryCount: number;
  sourceSessionCount: number;
  sourceFileCount?: number;
  rawContentIncluded: boolean;
  perSession: SessionQrelsPerSessionSummary[];
}

interface ClaudeContentBlock {
  type: string;
  text?: string;
}

type ClaudeMessageContent = string | ClaudeContentBlock[];

interface ClaudeJsonlEntry {
  type?: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: ClaudeMessageContent;
  };
}

interface PendingPrompt {
  sessionId: string;
  text: string;
  turnIndex: number;
  timestamp?: string;
}

export function buildSessionQrelsFixtureFromJsonl(
  jsonl: string | string[],
  options: SessionQrelsOptions = {}
): SessionQrelsFixture {
  const lines = Array.isArray(jsonl) ? jsonl : jsonl.split(/\r?\n/);
  const queries: SessionQrelsQuery[] = [];
  const memories: SessionQrelsMemory[] = [];
  const sessionCounters = new Map<string, number>();
  const pendingBySession = new Map<string, PendingPrompt>();

  for (const line of lines) {
    if (options.maxQueries !== undefined && queries.length >= options.maxQueries) break;
    const entry = parseEntry(line);
    if (!entry) continue;

    const sessionId = entry.sessionId || 'unknown-session';
    const content = extractTextContent(entry.message?.content);
    if (!content) continue;

    if (entry.type === 'user') {
      if (isWorthBenchmarkingPrompt(content)) {
        const turnIndex = nextSessionCounter(sessionCounters, sessionId);
        pendingBySession.set(sessionId, { sessionId, text: content, turnIndex, timestamp: entry.timestamp });
      } else {
        pendingBySession.delete(sessionId);
      }
      continue;
    }

    if (entry.type === 'assistant') {
      const pending = pendingBySession.get(sessionId);
      if (!pending) continue;

      const answer = content.trim();
      if (answer.length === 0) continue;
      const idSuffix = `${pending.sessionId}-${pending.turnIndex}`;
      const memoryId = `m-${idSuffix}`;
      const queryId = `q-${idSuffix}`;
      const memoryContent = options.redactContent ? `[redacted memory ${memoryId}]` : answer;
      memories.push({
        id: memoryId,
        content: memoryContent,
        sourceSessionId: pending.sessionId,
        sourceTurnIndex: pending.turnIndex,
        timestamp: entry.timestamp ?? pending.timestamp
      });
      queries.push({
        queryId,
        query: options.redactContent ? `[redacted query ${queryId}]` : pending.text,
        expectedIds: [memoryId],
        expectedRelevance: { [memoryId]: 2 },
        sourceSessionId: pending.sessionId,
        sourceTurnIndex: pending.turnIndex,
        expectation: 'match',
        knownAnswer: memoryContent
      });
      pendingBySession.delete(sessionId);
    }
  }

  appendExplicitNoMatchQueries(queries, options);

  const redactContent = options.redactContent === true;
  const rawContentIncluded = options.rawContentIncluded ?? !redactContent;

  return {
    name: options.name ?? 'session-qrels-fixture',
    description: options.description ?? 'Session-derived qrels fixture generated from Claude JSONL user/assistant turns.',
    ks: options.ks ?? [1, 3, 5],
    queries,
    memories,
    metadata: {
      sourceFileCount: options.sourceFileCount,
      rawContentIncluded,
      generatedAt: options.generatedAt
    }
  };
}

export async function collectClaudeSessionJsonlFiles(
  rootDir: string,
  options: SessionQrelsFileCollectionOptions = {}
): Promise<string[]> {
  const maxFiles = options.maxFiles ?? Number.POSITIVE_INFINITY;
  const minBytes = options.minBytes ?? 0;
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (files.length >= maxFiles) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!options.includeSubagents && entry.name.toLowerCase() === 'subagents') continue;
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      if (minBytes > 0) {
        try {
          const info = await stat(fullPath);
          if (info.size < minBytes) continue;
        } catch {
          continue;
        }
      }
      files.push(fullPath);
    }
  }

  await walk(rootDir);
  return files;
}

export function summarizeSessionQrelsFixture(fixture: SessionQrelsFixture): SessionQrelsSummary {
  const bySession = new Map<string, SessionQrelsPerSessionSummary>();

  function ensureSession(sourceSessionId: string, turnIndex: number): SessionQrelsPerSessionSummary {
    const existing = bySession.get(sourceSessionId);
    if (existing) {
      existing.firstTurnIndex = Math.min(existing.firstTurnIndex, turnIndex);
      existing.lastTurnIndex = Math.max(existing.lastTurnIndex, turnIndex);
      return existing;
    }
    const created: SessionQrelsPerSessionSummary = {
      sourceSessionId,
      queryCount: 0,
      memoryCount: 0,
      firstTurnIndex: turnIndex,
      lastTurnIndex: turnIndex
    };
    bySession.set(sourceSessionId, created);
    return created;
  }

  for (const query of fixture.queries) {
    ensureSession(query.sourceSessionId, query.sourceTurnIndex).queryCount += 1;
  }
  for (const memory of fixture.memories) {
    ensureSession(memory.sourceSessionId, memory.sourceTurnIndex).memoryCount += 1;
  }

  const perSession = Array.from(bySession.values()).sort((a, b) => a.sourceSessionId.localeCompare(b.sourceSessionId));

  const positiveQueryCount = fixture.queries.filter((query) => getQueryExpectation(query) === 'match').length;
  const noMatchQueryCount = fixture.queries.filter((query) => getQueryExpectation(query) === 'no_match').length;
  const knownAnswerCount = fixture.queries.filter((query) => typeof query.knownAnswer === 'string' && query.knownAnswer.length > 0).length;

  return {
    name: fixture.name,
    description: fixture.description,
    ks: fixture.ks,
    queryCount: fixture.queries.length,
    positiveQueryCount,
    noMatchQueryCount,
    knownAnswerCount,
    memoryCount: fixture.memories.length,
    sourceSessionCount: perSession.length,
    sourceFileCount: fixture.metadata?.sourceFileCount,
    rawContentIncluded: fixture.metadata?.rawContentIncluded ?? true,
    perSession
  };
}

function appendExplicitNoMatchQueries(
  queries: SessionQrelsQuery[],
  options: SessionQrelsOptions
): void {
  const inputs = options.noMatchQueries ?? [];
  if (inputs.length === 0) return;

  const remaining = options.maxQueries === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, options.maxQueries - queries.length);

  const startIndex = queries.length;
  inputs.slice(0, remaining).forEach((input, index) => {
    const queryId = input.queryId ?? `q-no-match-${startIndex + index + 1}`;
    queries.push({
      queryId,
      query: options.redactContent ? `[redacted query ${queryId}]` : input.query,
      expectedIds: [],
      expectedRelevance: {},
      sourceSessionId: input.sourceSessionId ?? 'no-match',
      sourceTurnIndex: input.sourceTurnIndex ?? 0,
      expectation: 'no_match',
      forbiddenIds: [...(input.forbiddenIds ?? [])]
    });
  });
}

function getQueryExpectation(query: SessionQrelsQuery): SessionQrelsExpectation {
  return query.expectation ?? (query.expectedIds.length === 0 ? 'no_match' : 'match');
}

function parseEntry(line: string): ClaudeJsonlEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as ClaudeJsonlEntry;
  } catch {
    return null;
  }
}

function extractTextContent(content: ClaudeMessageContent | undefined): string | null {
  if (!content) return null;
  if (typeof content === 'string') return content.trim();
  const texts = content
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text?.trim() ?? '')
    .filter(Boolean);
  return texts.length > 0 ? texts.join('\n') : null;
}

function isWorthBenchmarkingPrompt(content: string): boolean {
  const trimmed = content.trim();
  if (isClaudeLocalCommandArtifact(trimmed)) return false;
  if (trimmed.startsWith('/')) return false;
  if (trimmed.length < 15) return false;
  return /[a-zA-Z가-힣]{2,}/.test(trimmed);
}

function isClaudeLocalCommandArtifact(content: string): boolean {
  return (
    /^<local-command-(stdout|stderr)>/.test(content) ||
    /^<command-(name|message)>/.test(content) ||
    (content.includes('<command-name>') && content.includes('<local-command-stdout>'))
  );
}

function nextSessionCounter(counters: Map<string, number>, sessionId: string): number {
  const next = (counters.get(sessionId) ?? 0) + 1;
  counters.set(sessionId, next);
  return next;
}
