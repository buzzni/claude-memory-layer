/**
 * Hermes SessionDB Importer
 *
 * Imports explicit, read-only snapshots from Hermes Agent's ~/.hermes/state.db
 * into claude-memory-layer. This intentionally does not tail/live-sync Hermes:
 * SessionDB remains the raw source of truth; imports are opt-in and project-scoped.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { createDatabase, type Database } from '../core/db-wrapper.js';
import { applyPrivacyFilter, truncateOutput } from '../core/privacy/index.js';
import { registerSession } from '../core/registry/session-registry.js';
import type { Config } from '../core/types.js';
import { MemoryService } from './memory-service.js';
import { isWorthStoringPrompt, type ImportOptions, type ImportResult } from './session-history-importer.js';

export const HERMES_VALIDATION_DEFAULT_MAX_CONTENT_CHARS = 10_000;
const HERMES_MEMORY_SESSION_PREFIX = 'hermes:';

const DEFAULT_PRIVACY_CONFIG: Config['privacy'] = {
  excludePatterns: ['password', 'secret', 'api_key', 'token', 'bearer'],
  anonymize: false,
  privateTags: {
    enabled: true,
    marker: '[PRIVATE]',
    preserveLineCount: false,
    supportedFormats: ['xml']
  }
};

export interface HermesSessionHistoryImporterOptions {
  stateDbPath?: string;
}

export interface HermesValidationOptions {
  stateDbPath?: string;
  projectPath?: string;
  limit?: number;
  maxContentChars?: number;
  now?: Date;
}

export interface HermesValidationSource {
  stateDbPath: string;
  projectPath?: string;
  projectFilterApplied: boolean;
  sourcePaths: string[];
}

export interface HermesValidationLimits {
  sessionLimit?: number;
  maxContentChars: number;
}

export interface HermesValidationTotals {
  sessionsScanned: number;
  sessionsMatched: number;
  messagesRead: number;
  messagesNormalized: number;
  turnsNormalized: number;
  userMessages: number;
  assistantMessages: number;
  skippedUnsupportedMessages: number;
  emptyAssistantMessages: number;
  truncatedMessages: number;
  missingProjectContext: number;
  warnings: number;
}

export interface HermesSourceSummary {
  source: string;
  sessions: number;
  messagesNormalized: number;
  turnsNormalized: number;
  userMessages: number;
  assistantMessages: number;
  skippedUnsupportedMessages: number;
  truncatedMessages: number;
  emptyAssistantMessages: number;
}

export interface HermesSessionReplaySummary {
  sessionId: string;
  source: string;
  matched: boolean;
  messagesRead: number;
  messagesNormalized: number;
  turnsNormalized: number;
  userMessages: number;
  assistantMessages: number;
  skippedUnsupportedMessages: number;
  emptyAssistantMessages: number;
  truncatedMessages: number;
  missingProjectContext: boolean;
  warnings: string[];
}

export interface HermesSessionValidationReport {
  generatedAt: string;
  dryRun: true;
  willMutate: false;
  source: HermesValidationSource;
  limits: HermesValidationLimits;
  totals: HermesValidationTotals;
  topSources: HermesSourceSummary[];
  sessions: HermesSessionReplaySummary[];
  warnings: string[];
}

type HermesSessionRow = {
  id: string;
  source: string;
  user_id: string | null;
  model: string | null;
  system_prompt: string | null;
  started_at: number;
  ended_at?: number | null;
  title?: string | null;
};

type HermesMessageRow = {
  id: number;
  session_id: string;
  role: string;
  content: string | null;
  tool_name: string | null;
  timestamp: number;
};

type NormalizedHermesMessage = {
  role: 'user' | 'assistant';
  content: string;
  truncated: boolean;
};

function normalizeMaybeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function hashLabel(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function makeMemorySessionId(sessionId: string): string {
  return sessionId.startsWith(HERMES_MEMORY_SESSION_PREFIX)
    ? sessionId
    : `${HERMES_MEMORY_SESSION_PREFIX}${sessionId}`;
}

function timestampToIso(timestamp: number | null | undefined): string | undefined {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp * 1000).toISOString();
}

function getProjectMatchVariants(projectPath: string): string[] {
  const variants = new Set<string>();
  variants.add(projectPath);
  variants.add(path.resolve(projectPath));
  variants.add(normalizeMaybeRealpath(projectPath));
  variants.add(projectPath.replace(/\\/g, '/'));
  variants.add(path.resolve(projectPath).replace(/\\/g, '/'));
  return [...variants].filter(Boolean).map((v) => v.toLowerCase());
}

function getSessionProjectHaystack(session: HermesSessionRow): string {
  return [session.system_prompt, session.title]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n')
    .replace(/\\/g, '/')
    .toLowerCase();
}

function hasProjectContext(session: HermesSessionRow): boolean {
  return Boolean(
    (typeof session.system_prompt === 'string' && session.system_prompt.trim().length > 0) ||
    (typeof session.title === 'string' && session.title.trim().length > 0)
  );
}

function matchesProject(session: HermesSessionRow, projectPath?: string): boolean {
  if (!projectPath) return true;
  const haystack = getSessionProjectHaystack(session);
  if (!haystack) return false;
  return getProjectMatchVariants(projectPath).some((variant) => haystack.includes(variant));
}

function parseHermesEncodedContent(content: string | null): string | null {
  if (typeof content !== 'string') return null;
  if (content.length === 0) return null;

  const trimmed = content.trim();
  if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const extracted = extractTextFromStructuredContent(parsed);
      if (extracted) return extracted;
    } catch {
      // Plain text that happens to look like JSON; keep it below.
    }
  }

  return content;
}

function extractTextFromStructuredContent(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (Array.isArray(value)) {
    const texts = value
      .map((item) => extractTextFromStructuredContent(item))
      .filter((item): item is string => Boolean(item));
    return texts.length > 0 ? texts.join('\n') : null;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string' && record.text.length > 0) return record.text;
    if (typeof record.content === 'string' && record.content.length > 0) return record.content;
    if (Array.isArray(record.content)) return extractTextFromStructuredContent(record.content);
  }
  return null;
}

function normalizeHermesMessage(
  row: HermesMessageRow,
  maxContentChars = HERMES_VALIDATION_DEFAULT_MAX_CONTENT_CHARS
): NormalizedHermesMessage | 'empty-assistant' | 'unsupported' | 'trivial-user' {
  if (row.role !== 'user' && row.role !== 'assistant') return 'unsupported';
  const extracted = parseHermesEncodedContent(row.content);
  if (!extracted || extracted.trim().length === 0) {
    return row.role === 'assistant' ? 'empty-assistant' : 'trivial-user';
  }
  if (row.role === 'user' && !isWorthStoringPrompt(extracted)) return 'trivial-user';

  const truncated = extracted.length > maxContentChars;
  return {
    role: row.role,
    content: truncated ? `${extracted.slice(0, maxContentChars)}...[truncated]` : extracted,
    truncated
  };
}

function sanitizeForMemory(content: string): string {
  const filtered = applyPrivacyFilter(content, DEFAULT_PRIVACY_CONFIG).content;
  return truncateOutput(filtered, { maxLength: HERMES_VALIDATION_DEFAULT_MAX_CONTENT_CHARS, maxLines: 200 });
}

export function getDefaultHermesStateDbPath(): string {
  return path.join(os.homedir(), '.hermes', 'state.db');
}

function openHermesDbReadOnly(stateDbPath: string): Database {
  if (!fs.existsSync(stateDbPath)) {
    throw new Error(`Hermes state database not found: ${stateDbPath}`);
  }
  return createDatabase(stateDbPath, { readOnly: true });
}

function listHermesSessions(db: Database): HermesSessionRow[] {
  return db.prepare(`
    SELECT id, source, user_id, model, system_prompt, started_at, ended_at, title
    FROM sessions
    ORDER BY started_at DESC, id DESC
  `).all() as HermesSessionRow[];
}

function getHermesSession(db: Database, sessionId: string): HermesSessionRow | null {
  const row = db.prepare(`
    SELECT id, source, user_id, model, system_prompt, started_at, ended_at, title
    FROM sessions
    WHERE id = ?
  `).get(sessionId) as HermesSessionRow | undefined;
  return row ?? null;
}

function listHermesMessages(db: Database, sessionId: string): HermesMessageRow[] {
  return db.prepare(`
    SELECT id, session_id, role, content, tool_name, timestamp
    FROM messages
    WHERE session_id = ?
    ORDER BY timestamp ASC, id ASC
  `).all(sessionId) as HermesMessageRow[];
}

function createEmptyImportResult(): ImportResult {
  return {
    totalSessions: 0,
    totalMessages: 0,
    importedPrompts: 0,
    importedResponses: 0,
    skippedDuplicates: 0,
    errors: []
  };
}

function createEmptySessionSummary(session: HermesSessionRow, matched: boolean): HermesSessionReplaySummary {
  return {
    sessionId: session.id,
    source: session.source,
    matched,
    messagesRead: 0,
    messagesNormalized: 0,
    turnsNormalized: 0,
    userMessages: 0,
    assistantMessages: 0,
    skippedUnsupportedMessages: 0,
    emptyAssistantMessages: 0,
    truncatedMessages: 0,
    missingProjectContext: !hasProjectContext(session),
    warnings: []
  };
}

function addToSourceSummary(
  summaries: Map<string, HermesSourceSummary>,
  sessionSummary: HermesSessionReplaySummary
): void {
  const current = summaries.get(sessionSummary.source) ?? {
    source: sessionSummary.source,
    sessions: 0,
    messagesNormalized: 0,
    turnsNormalized: 0,
    userMessages: 0,
    assistantMessages: 0,
    skippedUnsupportedMessages: 0,
    truncatedMessages: 0,
    emptyAssistantMessages: 0
  };

  current.sessions += 1;
  current.messagesNormalized += sessionSummary.messagesNormalized;
  current.turnsNormalized += sessionSummary.turnsNormalized;
  current.userMessages += sessionSummary.userMessages;
  current.assistantMessages += sessionSummary.assistantMessages;
  current.skippedUnsupportedMessages += sessionSummary.skippedUnsupportedMessages;
  current.truncatedMessages += sessionSummary.truncatedMessages;
  current.emptyAssistantMessages += sessionSummary.emptyAssistantMessages;
  summaries.set(sessionSummary.source, current);
}

export async function validateHermesSessions(options: HermesValidationOptions = {}): Promise<HermesSessionValidationReport> {
  const stateDbPath = options.stateDbPath ?? getDefaultHermesStateDbPath();
  const maxContentChars = options.maxContentChars ?? HERMES_VALIDATION_DEFAULT_MAX_CONTENT_CHARS;
  const warnings: string[] = [];
  const totals: HermesValidationTotals = {
    sessionsScanned: 0,
    sessionsMatched: 0,
    messagesRead: 0,
    messagesNormalized: 0,
    turnsNormalized: 0,
    userMessages: 0,
    assistantMessages: 0,
    skippedUnsupportedMessages: 0,
    emptyAssistantMessages: 0,
    truncatedMessages: 0,
    missingProjectContext: 0,
    warnings: 0
  };

  const db = openHermesDbReadOnly(stateDbPath);
  try {
    const sourceSummaries = new Map<string, HermesSourceSummary>();
    const sessionSummaries: HermesSessionReplaySummary[] = [];
    const sessions = listHermesSessions(db);
    const sessionLimit = options.limit ?? Infinity;
    let matchedCount = 0;

    for (const session of sessions) {
      totals.sessionsScanned++;
      const missingContext = !hasProjectContext(session);
      if (missingContext) totals.missingProjectContext++;

      const matched = matchesProject(session, options.projectPath);
      if (!matched) continue;
      if (matchedCount >= sessionLimit) continue;
      matchedCount++;
      totals.sessionsMatched++;

      const summary = createEmptySessionSummary(session, true);
      const messages = listHermesMessages(db, session.id);
      for (const message of messages) {
        summary.messagesRead++;
        totals.messagesRead++;

        const normalized = normalizeHermesMessage(message, maxContentChars);
        if (normalized === 'unsupported') {
          summary.skippedUnsupportedMessages++;
          totals.skippedUnsupportedMessages++;
          continue;
        }
        if (normalized === 'empty-assistant') {
          summary.emptyAssistantMessages++;
          totals.emptyAssistantMessages++;
          continue;
        }
        if (normalized === 'trivial-user') {
          continue;
        }

        summary.messagesNormalized++;
        totals.messagesNormalized++;
        if (normalized.truncated) {
          summary.truncatedMessages++;
          totals.truncatedMessages++;
        }
        if (normalized.role === 'user') {
          summary.userMessages++;
          summary.turnsNormalized++;
          totals.userMessages++;
          totals.turnsNormalized++;
        } else {
          summary.assistantMessages++;
          totals.assistantMessages++;
        }
      }

      sessionSummaries.push(summary);
      addToSourceSummary(sourceSummaries, summary);
    }

    if (totals.missingProjectContext > 0) {
      warnings.push(`${totals.missingProjectContext} Hermes session(s) have no project context in system prompt/title`);
    }
    totals.warnings = warnings.length;

    return {
      generatedAt: (options.now ?? new Date()).toISOString(),
      dryRun: true,
      willMutate: false,
      source: {
        stateDbPath,
        projectPath: options.projectPath,
        projectFilterApplied: Boolean(options.projectPath),
        sourcePaths: [stateDbPath]
      },
      limits: {
        sessionLimit: options.limit,
        maxContentChars
      },
      totals,
      topSources: [...sourceSummaries.values()].sort((a, b) => b.sessions - a.sessions || b.messagesNormalized - a.messagesNormalized),
      sessions: sessionSummaries,
      warnings
    };
  } finally {
    db.close();
  }
}

export class HermesSessionHistoryImporter {
  private readonly memoryService: MemoryService;
  private readonly stateDbPath: string;

  constructor(memoryService: MemoryService, options: HermesSessionHistoryImporterOptions = {}) {
    this.memoryService = memoryService;
    this.stateDbPath = options.stateDbPath ?? getDefaultHermesStateDbPath();
  }

  async importProject(projectPath: string, options: ImportOptions = {}): Promise<ImportResult> {
    const db = openHermesDbReadOnly(this.stateDbPath);
    try {
      const sessions = listHermesSessions(db).filter((session) => matchesProject(session, projectPath));
      return await this.importSessionRows(db, sessions, { ...options, projectPath });
    } finally {
      db.close();
    }
  }

  async importAll(options: ImportOptions = {}): Promise<ImportResult> {
    const db = openHermesDbReadOnly(this.stateDbPath);
    try {
      return await this.importSessionRows(db, listHermesSessions(db), options);
    } finally {
      db.close();
    }
  }

  async importSession(sessionId: string, options: ImportOptions = {}): Promise<ImportResult> {
    const db = openHermesDbReadOnly(this.stateDbPath);
    try {
      const sourceSessionId = sessionId.startsWith(HERMES_MEMORY_SESSION_PREFIX)
        ? sessionId.slice(HERMES_MEMORY_SESSION_PREFIX.length)
        : sessionId;
      const session = getHermesSession(db, sourceSessionId);
      if (!session) {
        return { ...createEmptyImportResult(), totalSessions: 1, errors: [`Hermes session not found: ${sessionId}`] };
      }
      return await this.importSessionRows(db, [session], options);
    } finally {
      db.close();
    }
  }

  async listAvailableSessions(projectPath?: string): Promise<Array<{
    sessionId: string;
    source: string;
    startedAt: Date;
    messageCount: number;
  }>> {
    const db = openHermesDbReadOnly(this.stateDbPath);
    try {
      return listHermesSessions(db)
        .filter((session) => matchesProject(session, projectPath))
        .map((session) => ({
          sessionId: session.id,
          source: session.source,
          startedAt: new Date(session.started_at * 1000),
          messageCount: listHermesMessages(db, session.id).length
        }));
    } finally {
      db.close();
    }
  }

  private async importSessionRows(
    db: Database,
    sessions: HermesSessionRow[],
    options: ImportOptions = {}
  ): Promise<ImportResult> {
    const result = createEmptyImportResult();
    const onProgress = options.onProgress;
    const limit = options.limit ?? Infinity;
    let storedCount = 0;

    onProgress?.({ phase: 'scan', message: `Found ${sessions.length} Hermes session(s)` });

    for (let i = 0; i < sessions.length; i++) {
      if (storedCount >= limit) break;
      const session = sessions[i];
      onProgress?.({ phase: 'session-start', sessionIndex: i, totalSessions: sessions.length, filePath: this.stateDbPath });

      const memorySessionId = makeMemorySessionId(session.id);
      const sessionResult = await this.importOneSession(db, session, memorySessionId, options, i, () => storedCount, (next) => { storedCount = next; });

      result.totalSessions++;
      result.totalMessages += sessionResult.totalMessages;
      result.importedPrompts += sessionResult.importedPrompts;
      result.importedResponses += sessionResult.importedResponses;
      result.skippedDuplicates += sessionResult.skippedDuplicates;
      result.errors.push(...sessionResult.errors);

      onProgress?.({
        phase: 'session-done',
        sessionIndex: i,
        importedPrompts: sessionResult.importedPrompts,
        importedResponses: sessionResult.importedResponses,
        skipped: sessionResult.skippedDuplicates
      });
    }

    onProgress?.({ phase: 'done', result });
    return result;
  }

  private async importOneSession(
    db: Database,
    session: HermesSessionRow,
    memorySessionId: string,
    options: ImportOptions,
    sessionIndex: number,
    getStoredCount: () => number,
    setStoredCount: (next: number) => void
  ): Promise<ImportResult> {
    const result = { ...createEmptyImportResult(), totalSessions: 1 };
    const effectiveProjectPath = options.projectPath;

    if (options.force) {
      const deleted = await this.memoryService.deleteSessionEvents(memorySessionId);
      if (options.verbose && deleted > 0) {
        console.log(`  Deleted ${deleted} existing events for session ${memorySessionId}`);
      }
    }

    await this.memoryService.startSession(memorySessionId, effectiveProjectPath);

    const messages = listHermesMessages(db, session.id);
    let currentTurnId: string | null = null;
    let textBuffer: Array<{ content: string; row: HermesMessageRow }> = [];
    let lastProgressAt = 0;

    const flushTextBuffer = async () => {
      if (getStoredCount() >= (options.limit ?? Infinity)) {
        textBuffer = [];
        return;
      }
      if (textBuffer.length === 0 || !currentTurnId) return;

      const contentBlocks = textBuffer.map((item) => item.content);
      const substantive = contentBlocks.filter((content) => content.length >= 100);
      const merged = substantive.length > 0
        ? substantive.join('\n\n')
        : contentBlocks.reduce((a, b) => a.length >= b.length ? a : b, '');
      if (!merged) {
        textBuffer = [];
        return;
      }

      const lastRow = textBuffer[textBuffer.length - 1].row;
      const appendResult = await this.memoryService.storeAgentResponse(
        memorySessionId,
        sanitizeForMemory(merged),
        {
          importedFrom: this.stateDbPath,
          originalTimestamp: timestampToIso(lastRow.timestamp),
          sourceMessageId: lastRow.id,
          turnId: currentTurnId,
          source: 'hermes',
          hermesSource: session.source,
          sourceSessionId: session.id,
          sourceSessionHash: hashLabel(session.id)
        }
      );

      if (appendResult.success && appendResult.isDuplicate) {
        result.skippedDuplicates++;
      } else {
        result.importedResponses++;
      }
      setStoredCount(getStoredCount() + 1);
      textBuffer = [];
    };

    for (const message of messages) {
      if (getStoredCount() >= (options.limit ?? Infinity)) break;
      result.totalMessages++;
      const normalized = normalizeHermesMessage(message);

      if (normalized === 'unsupported' || normalized === 'empty-assistant') {
        continue;
      }
      if (normalized === 'trivial-user') {
        result.skippedDuplicates++;
        continue;
      }

      if (normalized.role === 'user') {
        await flushTextBuffer();
        currentTurnId = randomUUID();
        const appendResult = await this.memoryService.storeUserPrompt(
          memorySessionId,
          sanitizeForMemory(normalized.content),
          {
            importedFrom: this.stateDbPath,
            originalTimestamp: timestampToIso(message.timestamp),
            sourceMessageId: message.id,
            turnId: currentTurnId,
            source: 'hermes',
            hermesSource: session.source,
            sourceSessionId: session.id,
            sourceSessionHash: hashLabel(session.id)
          }
        );

        if (appendResult.success && appendResult.isDuplicate) {
          result.skippedDuplicates++;
        } else {
          result.importedPrompts++;
        }
        setStoredCount(getStoredCount() + 1);
      } else {
        textBuffer.push({ content: normalized.content, row: message });
      }

      const now = Date.now();
      if (now - lastProgressAt > 200) {
        lastProgressAt = now;
        options.onProgress?.({
          phase: 'session-progress',
          sessionIndex,
          messagesProcessed: result.totalMessages,
          imported: result.importedPrompts + result.importedResponses,
          skipped: result.skippedDuplicates
        });
      }
    }

    await flushTextBuffer();
    await this.memoryService.endSession(memorySessionId);

    if (effectiveProjectPath) {
      registerSession(memorySessionId, effectiveProjectPath);
    }

    if (options.verbose) {
      console.log(`Imported ${result.importedPrompts} prompts, ${result.importedResponses} responses from Hermes session ${session.id}`);
    }

    return result;
  }
}

export function createHermesSessionHistoryImporter(
  memoryService: MemoryService,
  options: HermesSessionHistoryImporterOptions = {}
): HermesSessionHistoryImporter {
  return new HermesSessionHistoryImporter(memoryService, options);
}
