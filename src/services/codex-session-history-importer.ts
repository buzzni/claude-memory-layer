/**
 * Codex Session History Importer
 * Imports existing Codex CLI conversation history into memory
 *
 * Codex stores session history in:
 * ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<session-id>.jsonl
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { createHash, randomUUID } from 'crypto';
import { MemoryService } from './memory-service.js';
import { registerSession } from '../core/registry/session-registry.js';
import type { ImportOptions, ImportResult } from './session-history-importer.js';
import { mergeAgentResponseBlocks, truncateAgentResponse } from './turn-buffering.js';

type CodexLogLine = {
  timestamp?: string;
  type?: string;
  payload?: unknown;
};

type CodexSessionMetaPayload = {
  id?: unknown;
  cwd?: unknown;
  timestamp?: unknown;
};

type CodexResponseItemMessagePayload = {
  type?: unknown;
  role?: unknown;
  content?: unknown;
};

type CodexContentBlock = {
  type?: unknown;
  text?: unknown;
};

export const CODEX_VALIDATION_DEFAULT_MAX_CONTENT_CHARS = 10_000;

export interface CodexSessionMeta {
  sessionId: string | null;
  cwd: string | null;
}

export interface CodexValidationOptions {
  sessionsDir?: string;
  projectPath?: string;
  limit?: number;
  maxContentChars?: number;
  anonymizeProjects?: boolean;
  now?: Date;
}

export interface CodexValidationSource {
  sessionsDir: string;
  projectPath?: string;
  projectFilterApplied: boolean;
  sourcePaths: string[];
}

export interface CodexValidationLimits {
  sessionLimit?: number;
  maxContentChars: number;
}

export interface CodexValidationTotals {
  sessionsScanned: number;
  sessionsMatched: number;
  filesRead: number;
  recordsRead: number;
  messagesNormalized: number;
  turnsNormalized: number;
  userMessages: number;
  assistantMessages: number;
  malformedLines: number;
  skippedUnsupportedRecords: number;
  emptyAssistantMessages: number;
  truncatedMessages: number;
  missingProjectCwd: number;
  warnings: number;
}

export interface CodexProjectSummary {
  projectHash: string;
  pathLabel: string;
  sessions: number;
  messagesNormalized: number;
  turnsNormalized: number;
  userMessages: number;
  assistantMessages: number;
  malformedLines: number;
  skippedUnsupportedRecords: number;
  truncatedMessages: number;
  emptyAssistantMessages: number;
}

export interface CodexSessionReplaySummary {
  sessionId: string;
  filePath: string;
  projectHash: string;
  pathLabel: string;
  matched: boolean;
  recordsRead: number;
  messagesNormalized: number;
  turnsNormalized: number;
  userMessages: number;
  assistantMessages: number;
  malformedLines: number;
  skippedUnsupportedRecords: number;
  emptyAssistantMessages: number;
  truncatedMessages: number;
  missingProjectCwd: boolean;
  warnings: string[];
}

export interface CodexSessionValidationReport {
  generatedAt: string;
  dryRun: true;
  willMutate: false;
  source: CodexValidationSource;
  limits: CodexValidationLimits;
  totals: CodexValidationTotals;
  topProjects: CodexProjectSummary[];
  sessions: CodexSessionReplaySummary[];
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeMaybeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

interface CodexExtractedContent {
  text: string | null;
  originalLength: number;
  truncated: boolean;
}

function extractCodexContentText(
  content: unknown,
  maxContentChars = CODEX_VALIDATION_DEFAULT_MAX_CONTENT_CHARS
): CodexExtractedContent {
  const texts: string[] = [];

  if (typeof content === 'string') {
    if (content.length > 0) texts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue;
      const b = block as CodexContentBlock;
      const t = typeof b.type === 'string' ? b.type : '';
      if (t !== 'input_text' && t !== 'output_text' && t !== 'text') continue;
      if (typeof b.text === 'string' && b.text.length > 0) {
        texts.push(b.text);
      }
    }
  }

  if (texts.length === 0) {
    return { text: null, originalLength: 0, truncated: false };
  }

  const merged = texts.join('\n');
  const truncated = merged.length > maxContentChars;
  return {
    text: truncated ? `${merged.slice(0, maxContentChars)}...[truncated]` : merged,
    originalLength: merged.length,
    truncated
  };
}

function extractTextFromContent(content: unknown): string | null {
  return extractCodexContentText(content).text;
}

export function getDefaultCodexSessionsDir(): string {
  return path.join(os.homedir(), '.codex', 'sessions');
}

export function listCodexSessionFilesRecursive(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];
  const out: string[] = [];
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      const fullPath = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(fullPath);
      } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        out.push(fullPath);
      }
    }
  }

  return out.sort();
}

function getFileMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function selectRecentCodexSessionFiles(files: string[], sessionLimit?: number): string[] {
  if (sessionLimit === undefined) return files;
  const limit = Number.isFinite(sessionLimit) && sessionLimit > 0 ? Math.floor(sessionLimit) : undefined;
  if (limit === undefined) return files;
  return [...files]
    .sort((a, b) => getFileMtimeMs(b) - getFileMtimeMs(a) || b.localeCompare(a))
    .slice(0, limit);
}

function normalizePositiveImportLimit(limit?: number): number | undefined {
  if (limit === undefined) return undefined;
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined;
}

function countStoredEntries(result: ImportResult): number {
  return result.importedPrompts + result.importedResponses + result.skippedDuplicates;
}

export async function readCodexSessionMeta(filePath: string): Promise<CodexSessionMeta> {
  const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  try {
    let linesRead = 0;
    for await (const line of rl) {
      linesRead++;
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as CodexLogLine;
        if (obj.type !== 'session_meta') continue;
        if (!isRecord(obj.payload)) break;
        const payload = obj.payload as CodexSessionMetaPayload;
        const sessionId = typeof payload.id === 'string' ? payload.id : null;
        const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
        return { sessionId, cwd };
      } catch {
        // Ignore malformed preamble lines while looking for session_meta.
      }

      // session_meta is expected near the top; do not scan huge transcripts twice.
      if (linesRead >= 25) break;
    }
  } finally {
    rl.close();
    fileStream.close();
  }

  return { sessionId: null, cwd: null };
}

export function deriveCodexSessionIdFromFileName(filePath: string): string | null {
  const base = path.basename(filePath, '.jsonl');
  // Common: rollout-<date>-<uuid>
  const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (m?.[1]) return m[1];
  return base.length > 0 ? base : null;
}

function createEmptyCodexValidationTotals(): CodexValidationTotals {
  return {
    sessionsScanned: 0,
    sessionsMatched: 0,
    filesRead: 0,
    recordsRead: 0,
    messagesNormalized: 0,
    turnsNormalized: 0,
    userMessages: 0,
    assistantMessages: 0,
    malformedLines: 0,
    skippedUnsupportedRecords: 0,
    emptyAssistantMessages: 0,
    truncatedMessages: 0,
    missingProjectCwd: 0,
    warnings: 0
  };
}

function projectHashFor(cwd: string | null): string {
  return createHash('sha256').update(cwd ?? '(missing cwd)').digest('hex').slice(0, 12);
}

function projectPathLabel(cwd: string | null, anonymizeProjects: boolean): string {
  const hash = projectHashFor(cwd);
  if (anonymizeProjects) return cwd ? `project:${hash}` : `project:${hash}:missing-cwd`;
  return cwd ?? '(missing cwd)';
}

function isProjectMatch(cwd: string | null, projectPath?: string): boolean {
  if (!projectPath) return true;
  if (!cwd) return false;
  return normalizeMaybeRealpath(cwd) === normalizeMaybeRealpath(projectPath);
}

function addSessionToProject(projects: Map<string, CodexProjectSummary>, session: CodexSessionReplaySummary): void {
  const existing = projects.get(session.projectHash) ?? {
    projectHash: session.projectHash,
    pathLabel: session.pathLabel,
    sessions: 0,
    messagesNormalized: 0,
    turnsNormalized: 0,
    userMessages: 0,
    assistantMessages: 0,
    malformedLines: 0,
    skippedUnsupportedRecords: 0,
    truncatedMessages: 0,
    emptyAssistantMessages: 0
  };

  existing.sessions += 1;
  existing.messagesNormalized += session.messagesNormalized;
  existing.turnsNormalized += session.turnsNormalized;
  existing.userMessages += session.userMessages;
  existing.assistantMessages += session.assistantMessages;
  existing.malformedLines += session.malformedLines;
  existing.skippedUnsupportedRecords += session.skippedUnsupportedRecords;
  existing.truncatedMessages += session.truncatedMessages;
  existing.emptyAssistantMessages += session.emptyAssistantMessages;
  projects.set(session.projectHash, existing);
}

function addSessionToTotals(totals: CodexValidationTotals, session: CodexSessionReplaySummary): void {
  totals.filesRead += 1;
  totals.recordsRead += session.recordsRead;
  totals.messagesNormalized += session.messagesNormalized;
  totals.turnsNormalized += session.turnsNormalized;
  totals.userMessages += session.userMessages;
  totals.assistantMessages += session.assistantMessages;
  totals.malformedLines += session.malformedLines;
  totals.skippedUnsupportedRecords += session.skippedUnsupportedRecords;
  totals.emptyAssistantMessages += session.emptyAssistantMessages;
  totals.truncatedMessages += session.truncatedMessages;
}

export async function normalizeCodexSessionFile(
  filePath: string,
  options: {
    meta?: CodexSessionMeta;
    matched?: boolean;
    maxContentChars?: number;
    anonymizeProjects?: boolean;
  } = {}
): Promise<CodexSessionReplaySummary> {
  const meta = options.meta ?? await readCodexSessionMeta(filePath);
  const sessionId = meta.sessionId ?? deriveCodexSessionIdFromFileName(filePath) ?? path.basename(filePath, '.jsonl');
  const projectHash = projectHashFor(meta.cwd);
  const pathLabel = projectPathLabel(meta.cwd, options.anonymizeProjects === true);
  const summary: CodexSessionReplaySummary = {
    sessionId,
    filePath,
    projectHash,
    pathLabel,
    matched: options.matched ?? true,
    recordsRead: 0,
    messagesNormalized: 0,
    turnsNormalized: 0,
    userMessages: 0,
    assistantMessages: 0,
    malformedLines: 0,
    skippedUnsupportedRecords: 0,
    emptyAssistantMessages: 0,
    truncatedMessages: 0,
    missingProjectCwd: !meta.cwd,
    warnings: []
  };

  if (!meta.cwd) {
    summary.warnings.push('session_meta missing cwd; project matching is unavailable for this session');
  }

  const maxContentChars = options.maxContentChars ?? CODEX_VALIDATION_DEFAULT_MAX_CONTENT_CHARS;
  const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      summary.recordsRead += 1;

      let entry: CodexLogLine;
      try {
        entry = JSON.parse(line) as CodexLogLine;
      } catch {
        summary.malformedLines += 1;
        continue;
      }

      if (entry.type === 'session_meta') continue;
      if (entry.type !== 'response_item' || !isRecord(entry.payload)) {
        summary.skippedUnsupportedRecords += 1;
        continue;
      }

      const payload = entry.payload as CodexResponseItemMessagePayload;
      if (payload.type !== 'message') {
        summary.skippedUnsupportedRecords += 1;
        continue;
      }

      const role = typeof payload.role === 'string' ? payload.role : null;
      if (role !== 'user' && role !== 'assistant') {
        summary.skippedUnsupportedRecords += 1;
        continue;
      }

      const extracted = extractCodexContentText(payload.content, maxContentChars);
      if (!extracted.text) {
        if (role === 'assistant') {
          summary.emptyAssistantMessages += 1;
        } else {
          summary.skippedUnsupportedRecords += 1;
        }
        continue;
      }

      if (extracted.truncated) {
        summary.truncatedMessages += 1;
      }

      summary.messagesNormalized += 1;
      if (role === 'user') {
        summary.userMessages += 1;
        summary.turnsNormalized += 1;
      } else {
        summary.assistantMessages += 1;
      }
    }
  } finally {
    rl.close();
    fileStream.close();
  }

  return summary;
}

export async function validateCodexSessions(options: CodexValidationOptions = {}): Promise<CodexSessionValidationReport> {
  const sessionsDir = path.resolve(options.sessionsDir ?? getDefaultCodexSessionsDir());
  const maxContentChars = options.maxContentChars ?? CODEX_VALIDATION_DEFAULT_MAX_CONTENT_CHARS;
  const report: CodexSessionValidationReport = {
    generatedAt: (options.now ?? new Date()).toISOString(),
    dryRun: true,
    willMutate: false,
    source: {
      sessionsDir,
      projectPath: options.projectPath,
      projectFilterApplied: Boolean(options.projectPath),
      sourcePaths: [sessionsDir]
    },
    limits: {
      sessionLimit: options.limit,
      maxContentChars
    },
    totals: createEmptyCodexValidationTotals(),
    topProjects: [],
    sessions: [],
    warnings: []
  };

  if (!fs.existsSync(sessionsDir)) {
    report.warnings.push(`Codex sessions directory not found: ${sessionsDir}`);
    report.totals.warnings = report.warnings.length;
    return report;
  }

  const sessionFiles = listCodexSessionFilesRecursive(sessionsDir);
  const limitedFiles = typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
    ? sessionFiles.slice(0, Math.floor(options.limit))
    : sessionFiles;
  const projects = new Map<string, CodexProjectSummary>();

  for (const filePath of limitedFiles) {
    const meta = await readCodexSessionMeta(filePath);
    report.totals.sessionsScanned += 1;
    if (!meta.cwd) {
      report.totals.missingProjectCwd += 1;
    }

    const matched = isProjectMatch(meta.cwd, options.projectPath);
    if (!matched) continue;

    report.totals.sessionsMatched += 1;
    const sessionSummary = await normalizeCodexSessionFile(filePath, {
      meta,
      matched,
      maxContentChars,
      anonymizeProjects: options.anonymizeProjects
    });
    report.sessions.push(sessionSummary);
    addSessionToTotals(report.totals, sessionSummary);
    addSessionToProject(projects, sessionSummary);
  }

  report.topProjects = [...projects.values()].sort((a, b) => {
    const byMessages = b.messagesNormalized - a.messagesNormalized;
    if (byMessages !== 0) return byMessages;
    return b.sessions - a.sessions;
  }).slice(0, 10);

  if (report.totals.missingProjectCwd > 0) {
    report.warnings.push(`${report.totals.missingProjectCwd} session(s) missing cwd; project matching only uses sessions with cwd`);
  }
  if (report.totals.malformedLines > 0) {
    report.warnings.push(`${report.totals.malformedLines} malformed JSONL line(s) skipped`);
  }
  if (options.projectPath && report.totals.sessionsMatched === 0) {
    report.warnings.push(`No Codex sessions matched project cwd: ${options.projectPath}`);
  }
  report.totals.warnings = report.warnings.length;

  return report;
}

export interface CodexSessionHistoryImporterOptions {
  sessionsDir?: string;
}

export class CodexSessionHistoryImporter {
  private readonly memoryService: MemoryService;
  private readonly sessionsRoot: string;

  constructor(memoryService: MemoryService, options: CodexSessionHistoryImporterOptions = {}) {
    this.memoryService = memoryService;
    this.sessionsRoot = options.sessionsDir
      ? path.resolve(options.sessionsDir)
      : path.join(os.homedir(), '.codex', 'sessions');
  }

  private getSessionsRoot(): string {
    return this.sessionsRoot;
  }

  private async readSessionMeta(filePath: string): Promise<{ sessionId: string | null; cwd: string | null }> {
    const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    try {
      let linesRead = 0;
      for await (const line of rl) {
        linesRead++;
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as CodexLogLine;
          if (obj.type !== 'session_meta') continue;
          if (!isRecord(obj.payload)) break;
          const payload = obj.payload as CodexSessionMetaPayload;
          const sessionId = typeof payload.id === 'string' ? payload.id : null;
          const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
          return { sessionId, cwd };
        } catch {
          // ignore parse errors; keep scanning initial lines
        }

        // session_meta is expected at the top; don't scan entire file.
        if (linesRead >= 25) break;
      }
    } finally {
      rl.close();
      fileStream.close();
    }

    return { sessionId: null, cwd: null };
  }

  private deriveSessionIdFromFileName(filePath: string): string | null {
    const base = path.basename(filePath, '.jsonl');
    // Common: rollout-<date>-<uuid>
    const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    if (m?.[1]) return m[1];
    return base.length > 0 ? base : null;
  }

  async importProject(projectPath: string, options: ImportOptions = {}): Promise<ImportResult> {
    const result: ImportResult = {
      totalSessions: 0,
      totalMessages: 0,
      importedPrompts: 0,
      importedResponses: 0,
      skippedDuplicates: 0,
      errors: []
    };

    const onProgress = options.onProgress;
    const sessionsRoot = this.getSessionsRoot();
    if (!fs.existsSync(sessionsRoot)) {
      result.errors.push(`Codex sessions directory not found: ${sessionsRoot}`);
      return result;
    }

    const normalizedTarget = normalizeMaybeRealpath(projectPath);
    onProgress?.({ phase: 'scan', message: 'Scanning Codex session files...' });

    const sessionFiles = listCodexSessionFilesRecursive(sessionsRoot);
    const matchingFiles: string[] = [];

    // Filter by original CWD stored in session_meta.payload.cwd
    for (const filePath of sessionFiles) {
      try {
        const meta = await this.readSessionMeta(filePath);
        if (!meta.cwd) continue;
        if (normalizeMaybeRealpath(meta.cwd) === normalizedTarget) {
          matchingFiles.push(filePath);
        }
      } catch {
        // ignore
      }
    }

    const selectedFiles = selectRecentCodexSessionFiles(matchingFiles, options.sessionLimit);
    onProgress?.({ phase: 'scan', message: `Found ${matchingFiles.length} Codex session(s) for this project` });

    const effectiveProjectPath = options.projectPath ?? projectPath;
    const totalLimit = normalizePositiveImportLimit(options.limit);
    let storedAcrossSessions = 0;

    for (let i = 0; i < selectedFiles.length; i++) {
      if (totalLimit !== undefined && storedAcrossSessions >= totalLimit) break;
      const filePath = selectedFiles[i];
      const remainingLimit = totalLimit === undefined ? undefined : totalLimit - storedAcrossSessions;
      try {
        onProgress?.({ phase: 'session-start', sessionIndex: i, totalSessions: selectedFiles.length, filePath });
        const sessionResult = await this.importSessionFile(filePath, {
          ...options,
          limit: remainingLimit,
          projectPath: effectiveProjectPath,
          _sessionIndex: i,
        } as ImportOptions & { _sessionIndex: number });

        result.totalSessions++;
        result.totalMessages += sessionResult.totalMessages;
        result.importedPrompts += sessionResult.importedPrompts;
        result.importedResponses += sessionResult.importedResponses;
        result.skippedDuplicates += sessionResult.skippedDuplicates;
        result.errors.push(...sessionResult.errors);
        storedAcrossSessions += countStoredEntries(sessionResult);

        onProgress?.({
          phase: 'session-done',
          sessionIndex: i,
          importedPrompts: sessionResult.importedPrompts,
          importedResponses: sessionResult.importedResponses,
          skipped: sessionResult.skippedDuplicates
        });
      } catch (error) {
        result.errors.push(`Failed to import ${filePath}: ${error}`);
      }
    }

    return result;
  }

  async importAll(options: ImportOptions = {}): Promise<ImportResult> {
    const result: ImportResult = {
      totalSessions: 0,
      totalMessages: 0,
      importedPrompts: 0,
      importedResponses: 0,
      skippedDuplicates: 0,
      errors: []
    };

    const onProgress = options.onProgress;
    const sessionsRoot = this.getSessionsRoot();
    if (!fs.existsSync(sessionsRoot)) {
      result.errors.push(`Codex sessions directory not found: ${sessionsRoot}`);
      return result;
    }

    onProgress?.({ phase: 'scan', message: 'Scanning all Codex sessions...' });
    const sessionFiles = listCodexSessionFilesRecursive(sessionsRoot);
    const selectedFiles = selectRecentCodexSessionFiles(sessionFiles, options.sessionLimit);
    onProgress?.({ phase: 'scan', message: `Found ${sessionFiles.length} Codex session file(s)` });

    const totalLimit = normalizePositiveImportLimit(options.limit);
    let storedAcrossSessions = 0;

    for (let i = 0; i < selectedFiles.length; i++) {
      if (totalLimit !== undefined && storedAcrossSessions >= totalLimit) break;
      const filePath = selectedFiles[i];
      const remainingLimit = totalLimit === undefined ? undefined : totalLimit - storedAcrossSessions;
      try {
        onProgress?.({ phase: 'session-start', sessionIndex: i, totalSessions: selectedFiles.length, filePath });
        const sessionResult = await this.importSessionFile(filePath, {
          ...options,
          limit: remainingLimit,
          _sessionIndex: i,
        } as ImportOptions & { _sessionIndex: number });

        result.totalSessions++;
        result.totalMessages += sessionResult.totalMessages;
        result.importedPrompts += sessionResult.importedPrompts;
        result.importedResponses += sessionResult.importedResponses;
        result.skippedDuplicates += sessionResult.skippedDuplicates;
        result.errors.push(...sessionResult.errors);
        storedAcrossSessions += countStoredEntries(sessionResult);

        onProgress?.({
          phase: 'session-done',
          sessionIndex: i,
          importedPrompts: sessionResult.importedPrompts,
          importedResponses: sessionResult.importedResponses,
          skipped: sessionResult.skippedDuplicates
        });
      } catch (error) {
        result.errors.push(`Failed to process ${filePath}: ${error}`);
      }
    }

    return result;
  }

  async importSessionFile(filePath: string, options: ImportOptions = {}): Promise<ImportResult> {
    const result: ImportResult = {
      totalSessions: 1,
      totalMessages: 0,
      importedPrompts: 0,
      importedResponses: 0,
      skippedDuplicates: 0,
      errors: []
    };

    if (!fs.existsSync(filePath)) {
      result.errors.push(`File not found: ${filePath}`);
      return result;
    }

    const meta = await this.readSessionMeta(filePath);
    const sessionId = meta.sessionId ?? this.deriveSessionIdFromFileName(filePath);

    if (!sessionId) {
      result.errors.push(`Could not determine session id for: ${filePath}`);
      return result;
    }

    const effectiveProjectPath = options.projectPath ?? meta.cwd ?? undefined;

    if (options.force) {
      const deleted = await this.memoryService.deleteSessionEvents(sessionId);
      if (options.verbose && deleted > 0) {
        console.log(`  Deleted ${deleted} existing events for session ${sessionId}`);
      }
    }

    await this.memoryService.startSession(sessionId, effectiveProjectPath);

    const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    const onProgress = options.onProgress;
    const sessionIndex = (options as ImportOptions & { _sessionIndex?: number })._sessionIndex ?? 0;
    let lastProgressAt = 0;
    const limit = options.limit || Infinity;
    let storedCount = 0;

    let currentTurnId: string | null = null;
    let textBuffer: string[] = [];
    let lastTimestamp: string | undefined;

    const flushTextBuffer = async () => {
      if (storedCount >= limit) { textBuffer = []; return; }
      if (textBuffer.length === 0 || !currentTurnId) return;

      const merged = mergeAgentResponseBlocks(textBuffer);
      if (!merged) { textBuffer = []; return; }
      const truncated = truncateAgentResponse(merged);

      const appendResult = await this.memoryService.storeAgentResponse(
        sessionId,
        truncated,
        { importedFrom: filePath, originalTimestamp: lastTimestamp, turnId: currentTurnId, source: 'codex' }
      );

      if (appendResult.success && appendResult.isDuplicate) {
        result.skippedDuplicates++;
      } else {
        result.importedResponses++;
      }
      storedCount++;
      textBuffer = [];
    };

    try {
      for await (const line of rl) {
        if (storedCount >= limit) break;
        try {
          const entry = JSON.parse(line) as CodexLogLine;
          result.totalMessages++;

          if (entry.type === 'response_item' && isRecord(entry.payload)) {
            const payload = entry.payload as CodexResponseItemMessagePayload;
            if (payload.type !== 'message') continue;

            const role = typeof payload.role === 'string' ? payload.role : null;
            if (!role) continue;

            if (role === 'user') {
              await flushTextBuffer();

              const content = extractTextFromContent(payload.content);
              if (!content) continue;

              currentTurnId = randomUUID();

              const appendResult = await this.memoryService.storeUserPrompt(
                sessionId,
                content,
                { importedFrom: filePath, originalTimestamp: entry.timestamp, turnId: currentTurnId, source: 'codex' }
              );

              if (appendResult.success && appendResult.isDuplicate) {
                result.skippedDuplicates++;
              } else {
                result.importedPrompts++;
              }
              storedCount++;
            } else if (role === 'assistant') {
              const content = extractTextFromContent(payload.content);
              if (content) {
                textBuffer.push(content);
                if (typeof entry.timestamp === 'string') {
                  lastTimestamp = entry.timestamp;
                }
              }
            } else {
              // developer/system/tool messages are ignored by default
            }
          }

          const now = Date.now();
          if (now - lastProgressAt > 200) {
            lastProgressAt = now;
            onProgress?.({
              phase: 'session-progress',
              sessionIndex,
              messagesProcessed: result.totalMessages,
              imported: result.importedPrompts + result.importedResponses,
              skipped: result.skippedDuplicates
            });
          }
        } catch (parseError) {
          result.errors.push(`Parse error: ${parseError}`);
        }
      }
    } finally {
      await flushTextBuffer();
      rl.close();
      fileStream.close();
    }

    await this.memoryService.endSession(sessionId);

    if (effectiveProjectPath) {
      registerSession(sessionId, effectiveProjectPath);
    }

    if (options.verbose) {
      console.log(`Imported ${result.importedPrompts} prompts, ${result.importedResponses} responses from ${filePath}`);
    }

    return result;
  }

  async listAvailableSessions(projectPath?: string): Promise<Array<{
    sessionId: string;
    filePath: string;
    size: number;
    modifiedAt: Date;
  }>> {
    const sessionsRoot = this.getSessionsRoot();
    if (!fs.existsSync(sessionsRoot)) return [];

    const files = listCodexSessionFilesRecursive(sessionsRoot);
    const sessions: Array<{ sessionId: string; filePath: string; size: number; modifiedAt: Date }> = [];

    const normalizedTarget = projectPath ? normalizeMaybeRealpath(projectPath) : null;

    for (const filePath of files) {
      try {
        const stats = fs.statSync(filePath);

        let sessionId = this.deriveSessionIdFromFileName(filePath) ?? path.basename(filePath, '.jsonl');
        if (normalizedTarget) {
          const meta = await this.readSessionMeta(filePath);
          if (!meta.cwd) continue;
          if (normalizeMaybeRealpath(meta.cwd) !== normalizedTarget) continue;
          sessionId = meta.sessionId ?? sessionId;
        }

        sessions.push({
          sessionId,
          filePath,
          size: stats.size,
          modifiedAt: stats.mtime
        });
      } catch {
        // ignore
      }
    }

    sessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
    return sessions;
  }
}

export function createCodexSessionHistoryImporter(
  memoryService: MemoryService,
  options: CodexSessionHistoryImporterOptions = {}
): CodexSessionHistoryImporter {
  return new CodexSessionHistoryImporter(memoryService, options);
}
