#!/usr/bin/env node
/**
 * PostToolUse Hook
 * Called after each tool execution - stores tool observations
 *
 * Actual Claude Code input format:
 * {
 *   session_id, tool_name, tool_input, tool_use_id,
 *   tool_response: { stdout?, stderr?, content?, interrupted?, isImage? },
 *   cwd, transcript_path, permission_mode, hook_event_name
 * }
 */

import { getLightweightMemoryService } from '../services/memory-service.js';
import { applyPrivacyFilter, maskSensitiveInput, truncateOutput } from '../core/privacy/index.js';
import { extractMetadata } from '../core/metadata-extractor.js';
import { readTurnState } from '../core/turn-state.js';
import type { PostToolUseInput, ToolObservationPayload, Config } from '../core/types.js';

// Default config
const DEFAULT_CONFIG: Config['toolObservation'] = {
  enabled: true,
  excludedTools: ['TodoWrite', 'TodoRead'],
  maxOutputLength: 10000,
  maxOutputLines: 100,
  storeOnlyOnSuccess: false
};

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

/**
 * Extract text output from tool_response object
 */
function extractToolOutput(response: PostToolUseInput['tool_response']): string {
  if (!response) return '';

  // Bash tools: stdout + stderr
  if (response.stdout !== undefined) {
    const parts: string[] = [];
    if (response.stdout) parts.push(response.stdout);
    if (response.stderr) parts.push(`[stderr] ${response.stderr}`);
    return parts.join('\n') || '';
  }

  // Other tools may have content field
  if (response.content !== undefined) {
    return typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content);
  }

  // Fallback: stringify the whole response
  return JSON.stringify(response);
}

/**
 * Determine if the tool execution was successful
 */
function isToolSuccess(response: PostToolUseInput['tool_response']): boolean {
  if (!response) return false;
  if (response.interrupted) return false;
  // If stderr has content but stdout also has content, still consider success
  return true;
}

async function main(): Promise<void> {
  // Read input from stdin
  const inputData = await readStdin();
  const input: PostToolUseInput = JSON.parse(inputData);

  const config = DEFAULT_CONFIG;
  const privacyConfig = DEFAULT_PRIVACY_CONFIG;

  // 1. Check if tool observation is enabled
  if (!config.enabled) {
    console.log(JSON.stringify({}));
    return;
  }

  // 2. Check if tool is excluded
  if (config.excludedTools?.includes(input.tool_name)) {
    console.log(JSON.stringify({}));
    return;
  }

  // 3. Extract output from tool_response object
  const toolOutput = extractToolOutput(input.tool_response);
  const success = isToolSuccess(input.tool_response);

  // 4. Check success filter
  if (!success && config.storeOnlyOnSuccess) {
    console.log(JSON.stringify({}));
    return;
  }

  try {
    const memoryService = getLightweightMemoryService(input.session_id);

    // 5. Mask sensitive data in input
    const maskedInput = maskSensitiveInput(input.tool_input);

    // 6. Apply privacy filter to output
    const filterResult = applyPrivacyFilter(toolOutput, privacyConfig);
    const maskedOutput = filterResult.content;

    // 7. Truncate output
    const truncatedOutput = truncateOutput(maskedOutput, {
      maxLength: config.maxOutputLength,
      maxLines: config.maxOutputLines
    });

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
      durationMs: 0, // Claude Code doesn't provide timing info
      success,
      errorMessage: input.tool_response?.stderr || undefined,
      metadata: {
        ...metadata,
        ...(turnId ? { turnId } : {})
      }
    };

    // 10. Store observation
    await memoryService.storeToolObservation(input.session_id, payload);

    // Output empty (hook doesn't return context)
    console.log(JSON.stringify({}));
  } catch (error) {
    if (process.env.CLAUDE_MEMORY_DEBUG) {
      console.error('PostToolUse hook error:', error);
    }
    console.log(JSON.stringify({}));
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data);
    });
  });
}

main().catch(console.error);
