/**
 * Session End Hook
 * Called when session ends - generates and stores session summary
 */

import type { SessionEndInput } from '../../../core/types.js';
import { readStdin } from './hook-runtime.js';
import { handleClaudeSessionEnd } from './session-end-worker.js';

export async function main(): Promise<string> {
  try {
    // Read input from stdin (parse inside try so malformed JSON still emits a safe envelope)
    const input: SessionEndInput = JSON.parse(await readStdin());
    await handleClaudeSessionEnd(input);
    return JSON.stringify({});
  } catch (error) {
    if (process.env.CLAUDE_MEMORY_DEBUG) {
      console.error('Memory hook error:', error);
    }
    return JSON.stringify({});
  }
}

