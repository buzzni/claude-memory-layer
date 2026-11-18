/**
 * Which PostToolUse and PostToolUseFailure calls are worth storing, decided
 * from the hook input alone. Kept apart from post-tool-use.ts, which loads
 * the store, so the hook entries can drop the rest without loading it.
 */

import { readStdin, readNumberEnv } from './hook-runtime.js';
import type { PostToolUseFailureInput, PostToolUseInput, Config } from '../../../core/types.js';

// Default config
export const DEFAULT_CONFIG: Config['toolObservation'] = {
  enabled: true,
  excludedTools: [
    // Trivial meta tools
    'TodoWrite', 'TodoRead',
    // Reproducible query tools (no storage value)
    'Read', 'Grep', 'Glob',
    'ToolSearch', 'WebFetch', 'WebSearch', 'NotebookRead',
    // Low-value system tools
    'Skill', 'EnterPlanMode',
  ],
  minOutputLength: readNumberEnv('CLAUDE_MEMORY_TOOL_MIN_OUTPUT_LEN', 100, { integer: true, min: 0 }),
  maxOutputLength: 10000,
  maxOutputLines: 100,
  storeOnlyOnSuccess: false
};

// Tools that are always stored regardless of output length
const ALWAYS_STORE_TOOLS = new Set([
  'Write', 'Edit', 'MultiEdit', 'Agent', 'Task', 'ExitPlanMode'
]);

// Keywords that indicate a Bash output is worth storing
const IMPORTANT_BASH_KEYWORDS = [
  'error', 'failed', 'exception', 'traceback', 'panic',
  'warning', 'deprecated',
  'test passed', 'test failed', 'tests passed', 'tests failed',
  'coverage', 'assert',
  'published', 'deployed', 'built successfully', 'build complete',
  'successfully installed', 'successfully created',
];

/**
 * For Bash commands, only store output that is significant:
 * - Has stderr content
 * - Contains important keywords (errors, test results, deploy events)
 * - Output is very long (> 2000 chars), indicating meaningful work
 */
function isBashSignificant(output: string, response: PostToolUseInput['tool_response']): boolean {
  if (response?.stderr && response.stderr.trim().length > 20) return true;
  const lower = output.toLowerCase();
  if (IMPORTANT_BASH_KEYWORDS.some((kw) => lower.includes(kw))) return true;
  return output.trim().length > 2000;
}

/**
 * Determine if a tool output is significant enough to store.
 * Always-store tools bypass the length check.
 * Bash uses keyword-based significance detection.
 * Other tools require non-empty stderr or output length >= minLen.
 */
function hasSignificantOutput(
  toolName: string,
  output: string,
  response: PostToolUseInput['tool_response'],
  minLen: number
): boolean {
  if (ALWAYS_STORE_TOOLS.has(toolName)) return true;
  if (toolName === 'Bash') return isBashSignificant(output, response);
  if (response?.stderr && response.stderr.trim().length > 0) return true;
  return output.trim().length >= minLen;
}

/**
 * Extract text output from tool_response object
 */
export function extractToolOutput(response: PostToolUseInput['tool_response']): string {
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
export function isToolSuccess(response: PostToolUseInput['tool_response']): boolean {
  if (!response) return false;
  if (response.interrupted) return false;
  // If stderr has content but stdout also has content, still consider success
  return true;
}

/**
 * DEFAULT_CONFIG with the env blocklist override applied, or null when calls
 * of this tool are not stored at all.
 */
function observedToolConfig(toolName: string): Config['toolObservation'] | null {
  const config = { ...DEFAULT_CONFIG };

  // Allow env-based blocklist override
  const envBlocklist = process.env.CLAUDE_MEMORY_TOOL_BLOCKLIST;
  if (envBlocklist !== undefined) {
    config.excludedTools = envBlocklist.split(',').map((s) => s.trim()).filter(Boolean);
  }

  // 1. Check if tool observation is enabled
  if (!config.enabled) {
    return null;
  }

  // 2. Check if tool is excluded
  if (config.excludedTools?.includes(toolName)) {
    return null;
  }

  return config;
}

/**
 * Reads the hook input and returns it when the call is worth storing, or
 * null when it is not (malformed input included).
 */
export async function readToolObservationInput(): Promise<PostToolUseInput | null> {
  // Read input from stdin. Guard the parse so a malformed/empty body still emits
  // a valid envelope instead of throwing past the hook into an unhandled rejection.
  let input: PostToolUseInput;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return null;
  }

  const config = observedToolConfig(input.tool_name);
  if (!config) {
    return null;
  }

  // 3. Extract output from tool_response object
  const toolOutput = extractToolOutput(input.tool_response);
  const success = isToolSuccess(input.tool_response);

  // 4. Check success filter
  if (!success && config.storeOnlyOnSuccess) {
    return null;
  }

  // 4.5. Output-level filter: skip low-signal outputs
  if (!hasSignificantOutput(
    input.tool_name, toolOutput, input.tool_response,
    config.minOutputLength ?? 100
  )) {
    return null;
  }

  return input;
}

/**
 * Reads the PostToolUseFailure input and returns it when the failed call is
 * worth storing, or null when it is not (malformed input included). The same
 * tools are stored as for PostToolUse, but without the output-level filter:
 * a failure is worth keeping even when its error is one line ("Exit code 1").
 */
export async function readToolFailureInput(): Promise<PostToolUseFailureInput | null> {
  let input: PostToolUseFailureInput;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return null;
  }
  if (!input || typeof input.session_id !== 'string' || typeof input.tool_name !== 'string') {
    return null;
  }

  const config = observedToolConfig(input.tool_name);
  if (!config || config.storeOnlyOnSuccess) {
    return null;
  }
  return input;
}
