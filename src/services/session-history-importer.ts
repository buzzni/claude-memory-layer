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
import { MemoryService } from './memory-service.js';

export interface ImportOptions {
  projectPath?: string;
  sessionId?: string;
  limit?: number;
  skipExisting?: boolean;
  verbose?: boolean;
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
    content: string | Array<{ type: string; text?: string }>;
  };
  sessionId?: string;
  timestamp?: string;
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

    // Find project directory
    const projectDir = await this.findProjectDir(projectPath);
    if (!projectDir) {
      result.errors.push(`Project directory not found for: ${projectPath}`);
      return result;
    }

    // Find all session files
    const sessionFiles = await this.findSessionFiles(projectDir);
    result.totalSessions = sessionFiles.length;

    if (options.verbose) {
      console.log(`Found ${sessionFiles.length} session files in ${projectDir}`);
    }

    // Import each session
    for (const sessionFile of sessionFiles) {
      try {
        const sessionResult = await this.importSessionFile(sessionFile, options);
        result.totalMessages += sessionResult.totalMessages;
        result.importedPrompts += sessionResult.importedPrompts;
        result.importedResponses += sessionResult.importedResponses;
        result.skippedDuplicates += sessionResult.skippedDuplicates;
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

    for await (const line of rl) {
      if (lineCount >= limit) break;

      try {
        const entry = JSON.parse(line) as ClaudeMessage;
        result.totalMessages++;

        // Process message entries
        if (entry.type === 'user' || entry.type === 'assistant') {
          const content = this.extractContent(entry);
          if (!content) continue;

          if (entry.type === 'user') {
            const appendResult = await this.memoryService.storeUserPrompt(
              sessionId,
              content,
              { importedFrom: filePath, originalTimestamp: entry.timestamp }
            );

            if (appendResult.isDuplicate) {
              result.skippedDuplicates++;
            } else {
              result.importedPrompts++;
            }
          } else if (entry.type === 'assistant') {
            // Truncate very long responses
            const truncatedContent = content.length > 5000
              ? content.slice(0, 5000) + '...[truncated]'
              : content;

            const appendResult = await this.memoryService.storeAgentResponse(
              sessionId,
              truncatedContent,
              { importedFrom: filePath, originalTimestamp: entry.timestamp }
            );

            if (appendResult.isDuplicate) {
              result.skippedDuplicates++;
            } else {
              result.importedResponses++;
            }
          }

          lineCount++;
        }
      } catch (parseError) {
        // Skip malformed lines
        result.errors.push(`Parse error on line: ${parseError}`);
      }
    }

    // End session
    await this.memoryService.endSession(sessionId);

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

    const projectsDir = path.join(this.claudeDir, 'projects');
    if (!fs.existsSync(projectsDir)) {
      result.errors.push(`Projects directory not found: ${projectsDir}`);
      return result;
    }

    // Find all project directories
    const projectDirs = fs.readdirSync(projectsDir)
      .map(name => path.join(projectsDir, name))
      .filter(p => fs.statSync(p).isDirectory());

    if (options.verbose) {
      console.log(`Found ${projectDirs.length} project directories`);
    }

    for (const projectDir of projectDirs) {
      try {
        const sessionFiles = await this.findSessionFiles(projectDir);

        for (const sessionFile of sessionFiles) {
          const sessionResult = await this.importSessionFile(sessionFile, options);
          result.totalSessions++;
          result.totalMessages += sessionResult.totalMessages;
          result.importedPrompts += sessionResult.importedPrompts;
          result.importedResponses += sessionResult.importedResponses;
          result.skippedDuplicates += sessionResult.skippedDuplicates;
          result.errors.push(...sessionResult.errors);
        }
      } catch (error) {
        result.errors.push(`Failed to process ${projectDir}: ${error}`);
      }
    }

    return result;
  }

  /**
   * Find project directory from project path
   */
  private async findProjectDir(projectPath: string): Promise<string | null> {
    const projectsDir = path.join(this.claudeDir, 'projects');
    if (!fs.existsSync(projectsDir)) {
      return null;
    }

    // Claude uses a hash of the project path as directory name
    // Try to find matching directory by checking all projects
    const projectDirs = fs.readdirSync(projectsDir)
      .map(name => path.join(projectsDir, name))
      .filter(p => fs.statSync(p).isDirectory());

    // Look for directory that matches the project path pattern
    // The directory name format is: -home-user-project-name
    const normalizedPath = projectPath.replace(/\//g, '-').replace(/^-/, '');

    for (const dir of projectDirs) {
      const dirName = path.basename(dir);
      if (dirName.includes(normalizedPath) || normalizedPath.includes(dirName)) {
        return dir;
      }
    }

    // If exact match not found, return first match or null
    return projectDirs.length > 0 ? projectDirs[0] : null;
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
      const projectDir = await this.findProjectDir(projectPath);
      if (projectDir) {
        projectDirs = [projectDir];
      }
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
