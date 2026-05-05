import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';

export interface SessionQrelsMemory {
  id: string;
  content: string;
  sourceSessionId: string;
  sourceTurnIndex: number;
  timestamp?: string;
}

export interface SessionQrelsQuery {
  queryId: string;
  query: string;
  expectedIds: string[];
  expectedRelevance: Record<string, number>;
  sourceSessionId: string;
  sourceTurnIndex: number;
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

export interface SessionQrelsOptions {
  name?: string;
  description?: string;
  ks?: number[];
  maxQueries?: number;
  redactContent?: boolean;
  sourceFileCount?: number;
  rawContentIncluded?: boolean;
  generatedAt?: string;
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
      memories.push({
        id: memoryId,
        content: options.redactContent ? `[redacted memory ${memoryId}]` : answer,
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
        sourceTurnIndex: pending.turnIndex
      });
      pendingBySession.delete(sessionId);
    }
  }

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

  return {
    name: fixture.name,
    description: fixture.description,
    ks: fixture.ks,
    queryCount: fixture.queries.length,
    memoryCount: fixture.memories.length,
    sourceSessionCount: perSession.length,
    sourceFileCount: fixture.metadata?.sourceFileCount,
    rawContentIncluded: fixture.metadata?.rawContentIncluded ?? true,
    perSession
  };
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
