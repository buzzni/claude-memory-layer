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
import { randomUUID } from 'crypto';
import { MemoryService, registerSession } from './memory-service.js';
import type { ImportOptions, ImportResult } from './session-history-importer.js';

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

function extractTextFromContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const b = block as CodexContentBlock;
    const t = typeof b.type === 'string' ? b.type : '';
    if (t !== 'input_text' && t !== 'output_text' && t !== 'text') continue;
    if (typeof b.text === 'string' && b.text.length > 0) {
      texts.push(b.text);
    }
  }
  if (texts.length === 0) return null;
  return texts.join('\n');
}

export class CodexSessionHistoryImporter {
  private readonly memoryService: MemoryService;
  private readonly codexDir: string;

  constructor(memoryService: MemoryService) {
    this.memoryService = memoryService;
    this.codexDir = path.join(os.homedir(), '.codex');
  }

  private getSessionsRoot(): string {
    return path.join(this.codexDir, 'sessions');
  }

  private listSessionFilesRecursive(rootDir: string): string[] {
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

    return out;
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

    const sessionFiles = this.listSessionFilesRecursive(sessionsRoot);
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

    result.totalSessions = matchingFiles.length;
    onProgress?.({ phase: 'scan', message: `Found ${matchingFiles.length} Codex session(s) for this project` });

    const effectiveProjectPath = options.projectPath ?? projectPath;

    for (let i = 0; i < matchingFiles.length; i++) {
      const filePath = matchingFiles[i];
      try {
        onProgress?.({ phase: 'session-start', sessionIndex: i, totalSessions: matchingFiles.length, filePath });
        const sessionResult = await this.importSessionFile(filePath, {
          ...options,
          projectPath: effectiveProjectPath,
          _sessionIndex: i,
        } as ImportOptions & { _sessionIndex: number });

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
    const sessionFiles = this.listSessionFilesRecursive(sessionsRoot);
    result.totalSessions = sessionFiles.length;
    onProgress?.({ phase: 'scan', message: `Found ${sessionFiles.length} Codex session file(s)` });

    for (let i = 0; i < sessionFiles.length; i++) {
      const filePath = sessionFiles[i];
      try {
        onProgress?.({ phase: 'session-start', sessionIndex: i, totalSessions: sessionFiles.length, filePath });
        const sessionResult = await this.importSessionFile(filePath, {
          ...options,
          _sessionIndex: i,
        } as ImportOptions & { _sessionIndex: number });

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

      const substantive = textBuffer.filter(t => t.length >= 100);
      const merged = substantive.length > 0
        ? substantive.join('\n\n')
        : textBuffer.reduce((a, b) => a.length >= b.length ? a : b, '');

      if (!merged) { textBuffer = []; return; }

      const truncated = merged.length > 10000
        ? merged.slice(0, 10000) + '...[truncated]'
        : merged;

      const appendResult = await this.memoryService.storeAgentResponse(
        sessionId,
        truncated,
        { importedFrom: filePath, originalTimestamp: lastTimestamp, turnId: currentTurnId, source: 'codex' }
      );

      if (appendResult.isDuplicate) {
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

              if (appendResult.isDuplicate) {
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

    const files = this.listSessionFilesRecursive(sessionsRoot);
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

export function createCodexSessionHistoryImporter(memoryService: MemoryService): CodexSessionHistoryImporter {
  return new CodexSessionHistoryImporter(memoryService);
}
