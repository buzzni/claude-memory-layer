/**
 * The storing part of the Claude PostToolUse and PostToolUseFailure hooks,
 * loaded by post-tool-use.js and post-tool-use-failure.js for a tool call they
 * store. A library, not an executable.
 */
export { captureToolFailure, captureToolObservation } from '../adapters/claude/hooks/post-tool-use.js';
