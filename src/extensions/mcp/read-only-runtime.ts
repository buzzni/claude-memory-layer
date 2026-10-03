import { nativeRecallOwnedByHost } from '../../services/recall-host-contract.js';

/** Restricts native MCP access; neither marker grants filesystem or actor permissions. */
export function isReadOnlyMcpRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return nativeRecallOwnedByHost(env) || env.CLAUDE_MEMORY_MCP_READ_ONLY === '1';
}

// Only readers with a model-free, non-migrating snapshot path are enabled.
// Other operation readers remain unavailable until they have that contract.
export const READ_ONLY_MCP_TOOL_NAMES = new Set([
  'mem-context-pack', 'mem-search', 'mem-timeline', 'mem-details',
  'mem-project-timeline', 'mem-source-ref', 'mem-stats',
  'mem-lesson-get', 'mem-lesson-list', 'external-market-context'
]);
