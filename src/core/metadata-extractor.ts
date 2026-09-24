/**
 * Metadata Extractor
 * Extracts tool-specific metadata from tool inputs and outputs
 */

import type { ToolMetadata } from './types.js';

/**
 * Get file type from path
 */
function getFileType(filePath: string): string | undefined {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (!ext) return undefined;

  const typeMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    c: 'c',
    cpp: 'cpp',
    h: 'header',
    hpp: 'header',
    cs: 'csharp',
    php: 'php',
    html: 'html',
    css: 'css',
    scss: 'scss',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    md: 'markdown',
    sql: 'sql',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell'
  };

  return typeMap[ext];
}

/**
 * Count lines in content
 */
function countLines(content: string): number {
  return content.split('\n').length;
}

/**
 * Extract bash command (without arguments that might contain secrets)
 */
function extractCommand(fullCommand: string): string {
  // Get first word (command name)
  const parts = fullCommand.trim().split(/\s+/);
  const command = parts[0];

  // For common commands, include safe arguments
  const safeCommands = ['git', 'npm', 'yarn', 'pnpm', 'node', 'python', 'go', 'cargo', 'make'];
  if (safeCommands.includes(command) && parts.length > 1) {
    // Include subcommand for these
    return `${command} ${parts[1]}`;
  }

  return command;
}

/**
 * Extract metadata from tool usage
 */
export function extractMetadata(
  toolName: string,
  input: Record<string, unknown>,
  output: string,
  success: boolean
): ToolMetadata {
  switch (toolName) {
    case 'Read': {
      const filePath = input.file_path as string | undefined;
      return {
        filePath,
        fileType: filePath ? getFileType(filePath) : undefined,
        lineCount: success ? countLines(output) : undefined
      };
    }

    case 'Write': {
      const filePath = input.file_path as string | undefined;
      const content = input.content as string | undefined;
      return {
        filePath,
        fileType: filePath ? getFileType(filePath) : undefined,
        lineCount: content ? countLines(content) : undefined
      };
    }

    case 'Edit': {
      const filePath = input.file_path as string | undefined;
      return {
        filePath,
        fileType: filePath ? getFileType(filePath) : undefined
      };
    }

    case 'Bash': {
      const fullCommand = input.command as string | undefined;
      return {
        command: fullCommand ? extractCommand(fullCommand) : undefined
      };
    }

    case 'Grep': {
      const pattern = input.pattern as string | undefined;
      // Count matches from output
      const matchCount = success
        ? (output.match(/\n/g) || []).length + (output.trim() ? 1 : 0)
        : undefined;
      return {
        pattern,
        matchCount
      };
    }

    case 'Glob': {
      const pattern = input.pattern as string | undefined;
      const matchCount = success
        ? (output.match(/\n/g) || []).length + (output.trim() ? 1 : 0)
        : undefined;
      return {
        pattern,
        matchCount
      };
    }

    case 'WebFetch': {
      const url = input.url as string | undefined;
      // Try to extract status code from output
      const statusMatch = output.match(/status:\s*(\d{3})/i);
      return {
        url,
        statusCode: statusMatch ? parseInt(statusMatch[1], 10) : undefined
      };
    }

    case 'WebSearch': {
      return {};
    }

    case 'NotebookEdit': {
      const notebookPath = input.notebook_path as string | undefined;
      return {
        filePath: notebookPath,
        fileType: 'jupyter'
      };
    }

    default:
      return {};
  }
}

/**
 * Create embedding content for tool observation
 */
export function createToolObservationEmbedding(
  toolName: string,
  metadata: ToolMetadata,
  success: boolean
): string {
  const parts: string[] = [];

  parts.push(`Tool: ${toolName}`);

  if (metadata.filePath) {
    parts.push(`File: ${metadata.filePath}`);
  }
  if (metadata.command) {
    parts.push(`Command: ${metadata.command}`);
  }
  if (metadata.pattern) {
    parts.push(`Pattern: ${metadata.pattern}`);
  }
  if (metadata.url) {
    // Only include domain for privacy
    try {
      const url = new URL(metadata.url);
      parts.push(`URL: ${url.hostname}`);
    } catch {
      // Invalid URL, skip
    }
  }

  parts.push(`Result: ${success ? 'Success' : 'Failed'}`);

  return parts.join('\n');
}
