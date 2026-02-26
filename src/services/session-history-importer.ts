/**
 * Session History Importer
 * Imports existing Claude Code conversation history into memory
 *
 * Claude Code stores session history in:
 * ~/.claude/projects/<project-hash>/<session-id>.jsonl
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { randomUUID } from 'crypto';
import { MemoryService, registerSession } from './memory-service.js';

export type ProgressEvent =
  | { phase: 'scan'; message: string }
  | { phase: 'session-start'; sessionIndex: number; totalSessions: number; filePath: string }
  | { phase: 'session-progress'; sessionIndex: number; messagesProcessed: number; imported: number; skipped: number }
  | { phase: 'session-done'; sessionIndex: number; importedPrompts: number; importedResponses: number; skipped: number }
  | { phase: 'embedding'; processed: number; total: number }
  | { phase: 'done'; result: ImportResult };

export interface ImportOptions {
  projectPath?: string;
  sessionId?: string;
  limit?: number;
  skipExisting?: boolean;
  force?: boolean;
  verbose?: boolean;
  onProgress?: (event: ProgressEvent) => void;
}

export interface ImportResult {
  totalSessions: number;
  totalMessages: number;
  importedPrompts: number;
  importedResponses: number;
  skippedDuplicates: number;
  errors: string[];
}

export interface ClaudeMessage {
  type: string;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string; name?: string; tool_use_id?: string }>;
  };
  sessionId?: string;
  timestamp?: string;
}

/**
 * Classify a JSONL entry into a logical message type:
 * - 'user_prompt': Real user input (string content or text blocks without tool_result)
 * - 'tool_result': Tool execution result (user message with tool_result blocks)
 * - 'agent_text': Assistant text response (text blocks)
 * - 'tool_use': Assistant tool call (tool_use blocks)
 * - 'thinking': Assistant thinking (thinking blocks)
 * - 'skip': Everything else (progress, system, summary, etc.)
 */
function classifyEntry(entry: ClaudeMessage): 'user_prompt' | 'tool_result' | 'agent_text' | 'tool_use' | 'thinking' | 'skip' {
  if (entry.type !== 'user' && entry.type !== 'assistant') {
    return 'skip';
  }

  const content = entry.message?.content;
  if (!content) return 'skip';

  if (entry.type === 'user') {
    // String content = real user input
    if (typeof content === 'string') return 'user_prompt';

    // Array content: check for tool_result blocks
    if (Array.isArray(content)) {
      const hasToolResult = content.some(b => b.type === 'tool_result');
      if (hasToolResult) return 'tool_result';

      // Text-only blocks from user = real user input
      const hasText = content.some(b => b.type === 'text' && b.text);
      if (hasText) return 'user_prompt';
    }
    return 'skip';
  }

  // assistant type
  if (Array.isArray(content)) {
    const hasToolUse = content.some(b => b.type === 'tool_use');
    if (hasToolUse) return 'tool_use';

    const hasText = content.some(b => b.type === 'text' && b.text);
    if (hasText) return 'agent_text';

    const hasThinking = content.some(b => b.type === 'thinking');
    if (hasThinking) return 'thinking';
  } else if (typeof content === 'string' && content.length > 0) {
    return 'agent_text';
  }

  return 'skip';
}

export class SessionHistoryImporter {
  private readonly memoryService: MemoryService;
  private readonly claudeDir: string;

  constructor(memoryService: MemoryService) {
    this.memoryService = memoryService;
    this.claudeDir = path.join(os.homedir(), '.claude');
  }

  /**
   * Import all sessions from a project
   */
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

    // Find project directory
    onProgress?.({ phase: 'scan', message: 'Scanning for session files...' });
    const projectDirs = await this.findProjectDirs(projectPath);
    if (projectDirs.length === 0) {
      result.errors.push(`Project directory not found for: ${projectPath}`);
      return result;
    }

    // Find all session files across matched directories
    const allSessionFiles: string[] = [];
    for (const dir of projectDirs) {
      const files = await this.findSessionFiles(dir);
      allSessionFiles.push(...files);
    }
    const sessionFiles = [...new Set(allSessionFiles)];
    result.totalSessions = sessionFiles.length;
    onProgress?.({
      phase: 'scan',
      message: `Found ${sessionFiles.length} sessions in ${projectDirs.length} matched project folder(s)`
    });

    if (options.verbose) {
      console.log(`Matched project folders:`);
      for (const dir of projectDirs) {
        console.log(`  - ${dir}`);
      }
      console.log(`Found ${sessionFiles.length} session files across matched folders`);
    }

    // Import each session
    for (let i = 0; i < sessionFiles.length; i++) {
      const sessionFile = sessionFiles[i];
      try {
        onProgress?.({ phase: 'session-start', sessionIndex: i, totalSessions: sessionFiles.length, filePath: sessionFile });
        const sessionResult = await this.importSessionFile(sessionFile, {
          ...options,
          _sessionIndex: i,
        } as ImportOptions & { _sessionIndex: number });
        result.totalMessages += sessionResult.totalMessages;
        result.importedPrompts += sessionResult.importedPrompts;
        result.importedResponses += sessionResult.importedResponses;
        result.skippedDuplicates += sessionResult.skippedDuplicates;
        onProgress?.({
          phase: 'session-done', sessionIndex: i,
          importedPrompts: sessionResult.importedPrompts,
          importedResponses: sessionResult.importedResponses,
          skipped: sessionResult.skippedDuplicates
        });
      } catch (error) {
        result.errors.push(`Failed to import ${sessionFile}: ${error}`);
      }
    }

    return result;
  }

  /**
   * Import a specific session file
   */
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

    // Extract session ID from filename
    const sessionId = path.basename(filePath, '.jsonl');

    // Force reimport: delete existing events for this session
    if (options.force) {
      const deleted = await this.memoryService.deleteSessionEvents(sessionId);
      if (options.verbose && deleted > 0) {
        console.log(`  Deleted ${deleted} existing events for session ${sessionId}`);
      }
    }

    // Start session in memory
    await this.memoryService.startSession(sessionId, options.projectPath);

    // Read and parse JSONL file
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let lineCount = 0;
    const limit = options.limit || Infinity;
    const onProgress = options.onProgress;
    const sessionIndex = (options as ImportOptions & { _sessionIndex?: number })._sessionIndex ?? 0;
    let lastProgressAt = 0;

    // Turn grouping with buffering:
    // - Buffer assistant text blocks within a turn
    // - On new user_prompt or EOF, flush buffer as a single merged agent_response
    // - Filter out short transitional text (< 100 chars) like "Let me check..."
    let currentTurnId: string | null = null;
    let textBuffer: string[] = [];
    let lastTimestamp: string | undefined;

    // Flush buffered text as a single agent_response
    const flushTextBuffer = async () => {
      if (textBuffer.length === 0 || !currentTurnId) return;

      // Filter: keep substantive text (>= 100 chars), discard short transitional phrases
      const substantive = textBuffer.filter(t => t.length >= 100);

      // If all filtered out, keep the longest block (there's always something meaningful)
      const merged = substantive.length > 0
        ? substantive.join('\n\n')
        : textBuffer.reduce((a, b) => a.length >= b.length ? a : b, '');

      if (!merged) { textBuffer = []; return; }

      // Truncate if very long
      const truncated = merged.length > 10000
        ? merged.slice(0, 10000) + '...[truncated]'
        : merged;

      const appendResult = await this.memoryService.storeAgentResponse(
        sessionId,
        truncated,
        { importedFrom: filePath, originalTimestamp: lastTimestamp, turnId: currentTurnId }
      );

      if (appendResult.isDuplicate) {
        result.skippedDuplicates++;
      } else {
        result.importedResponses++;
      }
      lineCount++;
      textBuffer = [];
    };

    for await (const line of rl) {
      if (lineCount >= limit) break;

      try {
        const entry = JSON.parse(line) as ClaudeMessage;
        result.totalMessages++;

        const msgClass = classifyEntry(entry);

        if (msgClass === 'user_prompt') {
          // Flush previous turn's buffered responses before starting new turn
          await flushTextBuffer();

          const content = this.extractContent(entry);
          if (!content) continue;

          // New turn starts with each real user prompt
          currentTurnId = randomUUID();

          const appendResult = await this.memoryService.storeUserPrompt(
            sessionId,
            content,
            { importedFrom: filePath, originalTimestamp: entry.timestamp, turnId: currentTurnId }
          );

          if (appendResult.isDuplicate) {
            result.skippedDuplicates++;
          } else {
            result.importedPrompts++;
          }
          lineCount++;
        } else if (msgClass === 'agent_text') {
          // Buffer text instead of storing immediately
          const content = this.extractContent(entry);
          if (content) {
            textBuffer.push(content);
            lastTimestamp = entry.timestamp;
          }
        }
        // tool_result, tool_use, thinking, skip → ignored

        // Emit progress periodically
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
        // Skip malformed lines
        result.errors.push(`Parse error on line: ${parseError}`);
      }
    }

    // Flush any remaining buffered text from the last turn
    await flushTextBuffer();

    // End session
    await this.memoryService.endSession(sessionId);

    // Register session in registry so projects API can map hash → path
    if (options.projectPath) {
      registerSession(sessionId, options.projectPath);
    }

    if (options.verbose) {
      console.log(`Imported ${result.importedPrompts} prompts, ${result.importedResponses} responses from ${filePath}`);
    }

    return result;
  }

  /**
   * Import all sessions from all projects
   */
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

    const projectsDir = path.join(this.claudeDir, 'projects');
    if (!fs.existsSync(projectsDir)) {
      result.errors.push(`Projects directory not found: ${projectsDir}`);
      return result;
    }

    // Find all project directories and session files
    onProgress?.({ phase: 'scan', message: 'Scanning all projects...' });
    const projectDirs = fs.readdirSync(projectsDir)
      .map(name => path.join(projectsDir, name))
      .filter(p => fs.statSync(p).isDirectory());

    // Collect all session files across all projects
    const allSessionFiles: string[] = [];
    for (const projectDir of projectDirs) {
      const sessionFiles = await this.findSessionFiles(projectDir);
      allSessionFiles.push(...sessionFiles);
    }
    onProgress?.({ phase: 'scan', message: `Found ${allSessionFiles.length} sessions across ${projectDirs.length} projects` });

    if (options.verbose) {
      console.log(`Found ${projectDirs.length} project directories, ${allSessionFiles.length} sessions`);
    }

    // Import all session files with progress tracking
    for (let i = 0; i < allSessionFiles.length; i++) {
      const sessionFile = allSessionFiles[i];
      try {
        onProgress?.({ phase: 'session-start', sessionIndex: i, totalSessions: allSessionFiles.length, filePath: sessionFile });
        const sessionResult = await this.importSessionFile(sessionFile, {
          ...options,
          _sessionIndex: i,
        } as ImportOptions & { _sessionIndex: number });
        result.totalSessions++;
        result.totalMessages += sessionResult.totalMessages;
        result.importedPrompts += sessionResult.importedPrompts;
        result.importedResponses += sessionResult.importedResponses;
        result.skippedDuplicates += sessionResult.skippedDuplicates;
        result.errors.push(...sessionResult.errors);
        onProgress?.({
          phase: 'session-done', sessionIndex: i,
          importedPrompts: sessionResult.importedPrompts,
          importedResponses: sessionResult.importedResponses,
          skipped: sessionResult.skippedDuplicates
        });
      } catch (error) {
        result.errors.push(`Failed to process ${sessionFile}: ${error}`);
      }
    }

    return result;
  }

  /**
   * Find project directories from project path.
   * Supports wrappers (e.g. happy) that append extra path segments in folder names.
   */
  private async findProjectDirs(projectPath: string): Promise<string[]> {
    const projectsDir = path.join(this.claudeDir, 'projects');
    if (!fs.existsSync(projectsDir)) {
      return [];
    }

    const projectDirs = fs.readdirSync(projectsDir)
      .map(name => path.join(projectsDir, name))
      .filter(p => fs.statSync(p).isDirectory());

    const normalizedPath = projectPath.replace(/\/+/g, '/').replace(/\/$/, '');
    const normalizedDashed = normalizedPath.replace(/\//g, '-').replace(/^-/, '');
    const baseName = path.basename(normalizedPath);

    const scored = projectDirs.map((dir) => {
      const dirName = path.basename(dir);
      let score = 0;

      // strong matches
      if (dirName.includes(normalizedDashed)) score += 100;
      if (normalizedDashed.includes(dirName)) score += 80;

      // basename signal (handles wrappers adding extra suffix)
      if (baseName && dirName.includes(baseName)) score += 30;

      // token overlap signal
      const pathTokens = normalizedDashed.split('-').filter(Boolean);
      const tokenHits = pathTokens.filter(t => t.length >= 3 && dirName.includes(t)).length;
      score += Math.min(tokenHits, 20);

      return { dir, score, dirName };
    }).filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return [];

    // Keep close matches (same family) to include wrapper-generated variants
    const top = scored[0].score;
    const threshold = Math.max(30, top - 25);

    return scored
      .filter(x => x.score >= threshold)
      .map(x => x.dir);
  }

  /**
   * Find all JSONL session files in a directory
   */
  private async findSessionFiles(dir: string): Promise<string[]> {
    if (!fs.existsSync(dir)) {
      return [];
    }

    return fs.readdirSync(dir)
      .filter(name => name.endsWith('.jsonl'))
      .map(name => path.join(dir, name))
      .filter(p => fs.statSync(p).isFile());
  }

  /**
   * Extract text content from Claude message
   */
  private extractContent(entry: ClaudeMessage): string | null {
    if (!entry.message?.content) {
      return null;
    }

    const content = entry.message.content;

    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      // Extract text from content blocks
      const texts = content
        .filter(block => block.type === 'text' && block.text)
        .map(block => block.text as string);

      return texts.join('\n');
    }

    return null;
  }

  /**
   * List available sessions for import
   */
  async listAvailableSessions(projectPath?: string): Promise<Array<{
    sessionId: string;
    filePath: string;
    size: number;
    modifiedAt: Date;
  }>> {
    const sessions: Array<{
      sessionId: string;
      filePath: string;
      size: number;
      modifiedAt: Date;
    }> = [];

    let projectDirs: string[] = [];

    if (projectPath) {
      projectDirs = await this.findProjectDirs(projectPath);
    } else {
      const projectsDir = path.join(this.claudeDir, 'projects');
      if (fs.existsSync(projectsDir)) {
        projectDirs = fs.readdirSync(projectsDir)
          .map(name => path.join(projectsDir, name))
          .filter(p => fs.statSync(p).isDirectory());
      }
    }

    for (const projectDir of projectDirs) {
      const sessionFiles = await this.findSessionFiles(projectDir);

      for (const filePath of sessionFiles) {
        const stats = fs.statSync(filePath);
        sessions.push({
          sessionId: path.basename(filePath, '.jsonl'),
          filePath,
          size: stats.size,
          modifiedAt: stats.mtime
        });
      }
    }

    // Sort by modified date (newest first)
    sessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());

    return sessions;
  }
}

/**
 * Create importer with default memory service
 */
export function createSessionHistoryImporter(memoryService: MemoryService): SessionHistoryImporter {
  return new SessionHistoryImporter(memoryService);
}
