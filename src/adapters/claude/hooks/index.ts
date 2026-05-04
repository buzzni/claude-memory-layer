/** Claude Code hook adapter entrypoints and supporting runtime utilities. */

export { main as postToolUseMain } from './post-tool-use.js';
export { main as sessionEndMain } from './session-end.js';
export { main as semanticDaemonMain } from './semantic-daemon.js';
export { main as sessionStartMain } from './session-start.js';
export { main as stopMain } from './stop.js';
export { main as userPromptSubmitMain } from './user-prompt-submit.js';
export {
  handleSemanticDaemonRequest,
  isValidSemanticDaemonRequest,
  isVectorSessionFilterError,
  makeSemanticDaemonErrorResponse,
  parseSemanticDaemonRequest
} from './semantic-daemon.js';
export type {
  SemanticDaemonRequest,
  SemanticDaemonResponse,
  SemanticMemory
} from './semantic-daemon.js';
export * from './semantic-daemon-client.js';
