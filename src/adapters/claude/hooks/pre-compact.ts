/**
 * PreCompact Hook
 * Called right before Claude Code compacts the conversation. Saves where the
 * session stood as a checkpoint; SessionStart (source "compact") re-injects it.
 *
 * Claude Code input:
 * { session_id, transcript_path, cwd, hook_event_name, trigger: 'manual' | 'auto', custom_instructions }
 *
 * Output is always empty. This hook's stdout becomes instructions for the
 * compaction summary, and exit code 2 would block the compaction, so it adds
 * nothing and fails open.
 */

import { isAbsolute } from 'path';
import { readStdin } from './hook-runtime.js';
import { saveCompactionCheckpoint } from './compaction-checkpoint.js';

interface PreCompactInput {
  session_id: string;
  cwd: string;
  trigger?: string;
}

export async function main(): Promise<string> {
  let input: PreCompactInput;
  try {
    input = JSON.parse(await readStdin());
    if (!input || typeof input.cwd !== 'string' || !isAbsolute(input.cwd)
      || typeof input.session_id !== 'string' || !input.session_id.trim()) {
      throw new Error('invalid hook input');
    }
  } catch {
    return '';
  }

  try {
    await saveCompactionCheckpoint({
      cwd: input.cwd,
      sessionId: input.session_id,
      trigger: input.trigger === 'manual' || input.trigger === 'auto' ? input.trigger : 'unknown'
    });
  } catch (error) {
    if (process.env.CLAUDE_MEMORY_DEBUG) console.error('PreCompact hook error:', error);
  }
  return '';
}
