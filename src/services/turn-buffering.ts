/**
 * Shared turn-buffering helpers for the session-history importers.
 *
 * The Claude, Codex, and Hermes importers all reconstruct a single
 * agent_response per turn by buffering assistant text blocks and merging them on
 * the next user prompt / end of session. That merge + truncation logic was
 * copy-pasted byte-for-byte across the three (and had already drifted), so it
 * lives here as small pure functions both to de-duplicate it and to make it
 * unit-testable in isolation.
 */

/** Minimum length for a buffered assistant text block to count as substantive. */
export const MIN_SUBSTANTIVE_RESPONSE_LEN = 100;

/** Maximum stored length of a merged agent response before truncation. */
export const MAX_AGENT_RESPONSE_LEN = 10000;

/**
 * Merge buffered assistant text blocks into one response body: prefer the
 * substantive blocks (>= MIN_SUBSTANTIVE_RESPONSE_LEN) joined with blank lines,
 * otherwise fall back to the single longest block. Returns '' when there is
 * nothing to store.
 */
export function mergeAgentResponseBlocks(blocks: string[]): string {
  const substantive = blocks.filter((block) => block.length >= MIN_SUBSTANTIVE_RESPONSE_LEN);
  if (substantive.length > 0) return substantive.join('\n\n');
  return blocks.reduce((longest, block) => (longest.length >= block.length ? longest : block), '');
}

/** Truncate a merged response to the storage cap, marking it when cut. */
export function truncateAgentResponse(text: string): string {
  return text.length > MAX_AGENT_RESPONSE_LEN
    ? `${text.slice(0, MAX_AGENT_RESPONSE_LEN)}...[truncated]`
    : text;
}
