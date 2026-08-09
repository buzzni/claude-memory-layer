#!/usr/bin/env node
import { readStdin } from '../adapters/claude/hooks/hook-runtime.js';
import { importCodexSessionAtEnd, type CodexSessionAutoImportInput } from '../services/codex-session-auto-import.js';

async function main(): Promise<void> {
  try {
    const input = JSON.parse(await readStdin()) as CodexSessionAutoImportInput;
    if (!input.transcriptPath || !input.projectPath) return;
    await importCodexSessionAtEnd(input);
  } catch (error) {
    if (process.env.CLAUDE_MEMORY_DEBUG) {
      console.error('Codex session import worker error:', error);
    }
  }
}

void main();
