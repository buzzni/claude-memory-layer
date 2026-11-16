/**
 * PreToolUse Hook (edit tools only)
 * Called right before Claude Code runs an edit tool. When the pre-edit check
 * is switched on (operations.json `preEditCheck.enabled`), adds what earlier
 * sessions left about the file as context next to the tool result.
 *
 * Claude Code input:
 * { session_id, transcript_path, cwd, hook_event_name, tool_name, tool_input, tool_use_id }
 *
 * Never blocks the tool: no permissionDecision (an "allow" would also skip the
 * permission prompt), and on any error or with nothing to say the output is
 * empty, which leaves the tool call to the normal permission flow.
 */

import { isAbsolute } from 'path';
import { excludesUntrustedFromAutoInjection, loadMemoryOperationsConfig } from '../../../services/operations-config-loader.js';
import { formatClaudeContextHookOutput } from './hook-output.js';
import { readStdin } from './hook-runtime.js';
import { buildPreEditContext } from './pre-edit-memory.js';

/** Matcher for the hook registration; MultiEdit is kept for Claude Code versions that still have it. */
export const PRE_TOOL_USE_EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;

/** Watchdog ceiling. The tool waits for this hook, and its reads are bounded well below this. */
export const PRE_TOOL_USE_TIMEOUT_MS = 3000;

interface PreToolUseInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
}

function targetFile(input: PreToolUseInput): string | null {
  if (!(PRE_TOOL_USE_EDIT_TOOLS as readonly string[]).includes(input.tool_name)) return null;
  const filePath = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  return typeof filePath === 'string' && isAbsolute(filePath) ? filePath : null;
}

export async function main(): Promise<string> {
  let input: PreToolUseInput;
  try {
    input = JSON.parse(await readStdin());
    if (!input || typeof input.cwd !== 'string' || !isAbsolute(input.cwd)
      || typeof input.session_id !== 'string' || !input.session_id.trim()
      || typeof input.tool_name !== 'string') {
      throw new Error('invalid hook input');
    }
  } catch {
    return '';
  }

  const filePath = targetFile(input);
  if (!filePath || loadMemoryOperationsConfig()?.preEditCheck.enabled !== true) return '';

  try {
    const context = await buildPreEditContext({
      cwd: input.cwd,
      sessionId: input.session_id,
      filePath,
      excludeUntrustedOrigins: excludesUntrustedFromAutoInjection()
    });
    return context ? formatClaudeContextHookOutput('PreToolUse', context) : '';
  } catch (error) {
    if (process.env.CLAUDE_MEMORY_DEBUG) console.error('PreToolUse hook error:', error);
    return '';
  }
}
