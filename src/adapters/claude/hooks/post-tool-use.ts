/**
 * PostToolUse Hook
 * Called after each tool execution - stores tool observations. Also stores
 * the calls PostToolUseFailure reports (captureToolFailure).
 *
 * Actual Claude Code input format:
 * {
 *   session_id, tool_name, tool_input, tool_use_id,
 *   tool_response: { stdout?, stderr?, content?, interrupted?, isImage? },
 *   cwd, transcript_path, permission_mode, hook_event_name
 * }
 */

import { getLightweightMemoryService } from '../../../services/memory-service.js';
import { applyPrivacyFilter, maskSensitiveInput, truncateOutput } from '../../../core/privacy/index.js';
import { extractMetadata } from '../../../core/metadata-extractor.js';
import { readTurnState } from '../../../core/turn-state.js';
import { decideCapture, loadCapturePolicy } from './capture-policy.js';
import { DEFAULT_CONFIG, extractToolOutput, isToolSuccess, readToolObservationInput } from './post-tool-use-filter.js';
import type { PostToolUseFailureInput, PostToolUseInput, ToolObservationPayload, Config } from '../../../core/types.js';

const DEFAULT_PRIVACY_CONFIG: Config['privacy'] = {
  excludePatterns: ['password', 'secret', 'api_key', 'token', 'bearer'],
  anonymize: false,
  privateTags: {
    enabled: true,
    marker: '[PRIVATE]',
    preserveLineCount: false,
    supportedFormats: ['xml']
  }
};

export async function main(): Promise<string> {
  const input = await readToolObservationInput();
  return input ? captureToolObservation(input) : JSON.stringify({});
}

/** Stores a tool call that readToolObservationInput let through. */
export async function captureToolObservation(input: PostToolUseInput): Promise<string> {
  return storeToolCall(input, {
    toolOutput: extractToolOutput(input.tool_response),
    success: isToolSuccess(input.tool_response),
    errorMessage: maskToolOutput(input.tool_response?.stderr ?? '') || undefined
  });
}

/**
 * Stores a failed tool call that readToolFailureInput let through. Claude Code
 * sends a call that started and then failed here instead of to PostToolUse, so
 * the two never store the same call. Its `error` is both the output and the
 * error message, each through the same privacy filter and truncation.
 */
export async function captureToolFailure(input: PostToolUseFailureInput): Promise<string> {
  const error = typeof input.error === 'string' ? input.error : '';
  return storeToolCall(input, {
    toolOutput: error,
    success: false,
    errorMessage: maskToolOutput(error) || undefined,
    durationMs: typeof input.duration_ms === 'number' && Number.isFinite(input.duration_ms) && input.duration_ms >= 0
      ? input.duration_ms
      : 0
  });
}

/**
 * Privacy-filters and truncates tool output text before it is stored (steps 6-7).
 * Filter first: a cut made before it could drop a `<private>` section's closing
 * tag and leave the section's content unmasked.
 */
function maskToolOutput(text: string): string {
  // 6. Apply privacy filter to output
  const filterResult = applyPrivacyFilter(text, DEFAULT_PRIVACY_CONFIG);
  const maskedOutput = filterResult.content;

  // 7. Truncate output
  return truncateOutput(maskedOutput, {
    maxLength: DEFAULT_CONFIG.maxOutputLength,
    maxLines: DEFAULT_CONFIG.maxOutputLines
  });
}

/** Stores one tool call as a tool_observation, through the capture policy (steps 4.6-10). */
async function storeToolCall(
  input: Pick<PostToolUseInput, 'session_id' | 'agent_id' | 'agent_type' | 'tool_name' | 'tool_input'>,
  call: { toolOutput: string; success: boolean; errorMessage?: string; durationMs?: number }
): Promise<string> {
  const { toolOutput, success } = call;

  try {
    const memoryService = getLightweightMemoryService(input.session_id);

    // 4.6. Capture policy (operations.json `capturePolicy`): not stored, only counted
    const decision = decideCapture(input, loadCapturePolicy());
    if (!decision.capture) {
      await memoryService.recordCaptureSkipped(decision.reason);
      return JSON.stringify({});
    }

    // 5. Mask sensitive data in input, through the same privacy filter as the output
    const maskedInput = maskSensitiveInput(input.tool_input, DEFAULT_PRIVACY_CONFIG);

    // 6-7. Apply privacy filter to output and truncate it
    const truncatedOutput = maskToolOutput(toolOutput);

    // 8. Extract metadata
    const metadata = extractMetadata(
      input.tool_name,
      maskedInput,
      toolOutput,
      success
    );

    // 8.5. Read current turn_id from state file
    const turnId = readTurnState(input.session_id);

    // 9. Create payload (include turnId in metadata for grouping)
    const payload: ToolObservationPayload = {
      toolName: input.tool_name,
      toolInput: maskedInput,
      toolOutput: truncatedOutput,
      // Claude Code sends duration_ms (optional) to both hooks; only the
      // failure path stores it so far, PostToolUse still stores 0.
      durationMs: call.durationMs ?? 0,
      success,
      errorMessage: call.errorMessage,
      metadata: {
        ...metadata,
        ...(turnId ? { turnId } : {})
      }
    };

    // 10. Store observation
    await memoryService.storeToolObservation(input.session_id, payload);

    // Output empty (hook doesn't return context)
    return JSON.stringify({});
  } catch (error) {
    if (process.env.CLAUDE_MEMORY_DEBUG) {
      console.error('PostToolUse hook error:', error);
    }
    return JSON.stringify({});
  }
}
