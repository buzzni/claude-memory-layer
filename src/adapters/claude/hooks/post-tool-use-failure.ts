/**
 * PostToolUseFailure Hook
 * Called when a tool call fails - stores it as an unsuccessful tool observation
 *
 * Claude Code sends a failed call here, never to PostToolUse. Input format:
 * {
 *   session_id, tool_name, tool_input, tool_use_id,
 *   error?, is_interrupt?, duration_ms?,
 *   cwd, transcript_path, permission_mode, hook_event_name
 * }
 * There is no tool_response: `error` is the text Claude received as the result.
 */

import { readStdin } from './hook-runtime.js';
import {
  isToolObserved,
  maskToolOutput,
  resolveToolObservationConfig,
  storeToolCall
} from './post-tool-use.js';
import type { PostToolUseFailureInput } from '../../../core/types.js';

export async function main(): Promise<string> {
  // Same guard as PostToolUse: a malformed body still emits a valid envelope.
  let input: PostToolUseFailureInput;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return JSON.stringify({});
  }
  if (!input || typeof input.session_id !== 'string' || typeof input.tool_name !== 'string') {
    return JSON.stringify({});
  }

  const config = resolveToolObservationConfig();
  if (!isToolObserved(config, input.tool_name) || config.storeOnlyOnSuccess) {
    return JSON.stringify({});
  }

  // No output-length filter: a failure is worth keeping even when its error is
  // one short line ("Exit code 1", "String to replace not found in file.").
  const error = typeof input.error === 'string' ? input.error : '';
  return storeToolCall(
    { session_id: input.session_id, tool_name: input.tool_name, tool_input: input.tool_input ?? {} },
    config,
    {
      toolOutput: error,
      success: false,
      errorMessage: error ? maskToolOutput(error, config) : undefined
    }
  );
}
