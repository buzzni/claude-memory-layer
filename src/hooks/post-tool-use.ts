#!/usr/bin/env node
/**
 * PostToolUse Hook
 * Called after each tool execution - stores tool observations
 */

import { getDefaultMemoryService } from '../services/memory-service.js';
import { applyPrivacyFilter, maskSensitiveInput, truncateOutput } from '../core/privacy/index.js';
import { extractMetadata, createToolObservationEmbedding } from '../core/metadata-extractor.js';
import type { PostToolUseInput, ToolObservationPayload, Config } from '../core/types.js';

// Default config (will be overridden by actual config when available)
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
 * Calculate duration from ISO timestamps
 */
function calculateDuration(startedAt: string, endedAt: string): number {
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  return end - start;
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

  // 3. Check success filter
  const success = !input.tool_error;
  if (!success && config.storeOnlyOnSuccess) {
    console.log(JSON.stringify({}));
    return;
  }

  try {
    const memoryService = getDefaultMemoryService();

    // 4. Mask sensitive data in input
    const maskedInput = maskSensitiveInput(input.tool_input);

    // 5. Apply privacy filter to output
    const filterResult = applyPrivacyFilter(input.tool_output, privacyConfig);
    const maskedOutput = filterResult.content;

    // 6. Truncate output
    const truncatedOutput = truncateOutput(maskedOutput, {
      maxLength: config.maxOutputLength,
      maxLines: config.maxOutputLines
    });

    // 7. Extract metadata
    const metadata = extractMetadata(
      input.tool_name,
      maskedInput,
      input.tool_output,
      success
    );

    // 8. Create payload
    const payload: ToolObservationPayload = {
      toolName: input.tool_name,
      toolInput: maskedInput,
      toolOutput: truncatedOutput,
      durationMs: calculateDuration(input.started_at, input.ended_at),
      success,
      errorMessage: input.tool_error,
      metadata
    };

    // 9. Store observation
    await memoryService.storeToolObservation(input.session_id, payload);

    // Output empty (hook doesn't return context)
    console.log(JSON.stringify({}));
  } catch (error) {
    console.error('PostToolUse hook error:', error);
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
