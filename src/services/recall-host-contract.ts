/**
 * Installed-artifact handshake for a host that owns Codex event recall.
 * Keep this entry point dependency-free: checking compatibility must not open
 * memory storage, start workers, or load native SQLite bindings.
 */
export const CML_RECALL_HOST_CAPABILITIES = Object.freeze({
  version: 1,
  nativeEventOwnerMarker: true
});

export function nativeRecallOwnedByHost(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_MEMORY_RECALL_OWNER === 'host';
}
