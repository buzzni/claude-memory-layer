/**
 * Agent Response Normalization
 *
 * How a Claude transcript assistant message becomes stored agent_response
 * content. The dedupe key hashes the stored content, so every path that stores
 * Claude assistant messages (Stop, SessionEnd reconcile) must normalize the
 * same message to the same bytes or it stores it a second time.
 */

import { applyPrivacyFilter } from '../../../core/privacy/index.js';
import type { Config } from '../../../core/types.js';
import { readNumberEnv } from './hook-runtime.js';

// Default privacy config
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

const MAX_AGENT_RESPONSE_LEN = 5000;

export interface NormalizedAgentResponse {
  content: string;
  privacy: ReturnType<typeof applyPrivacyFilter>['metadata'];
}

/** Apply the privacy filter, then truncate very long responses. */
export function normalizeAgentResponse(text: string): NormalizedAgentResponse {
  const filterResult = applyPrivacyFilter(text, DEFAULT_PRIVACY_CONFIG);
  let content = filterResult.content;

  // Truncate very long responses
  if (content.length > MAX_AGENT_RESPONSE_LEN) {
    content = content.slice(0, MAX_AGENT_RESPONSE_LEN) + '...[truncated]';
  }

  return { content, privacy: filterResult.metadata };
}

export function readMinAgentResponseLength(): number {
  return readNumberEnv('CLAUDE_MEMORY_AGENT_RESPONSE_MIN_LEN', 150, { integer: true, min: 0 });
}

/**
 * Skip very short responses (likely just tool calls or transition messages),
 * but always keep the last message, which may be the final answer.
 */
export function isStorableAgentResponse(content: string, isLast: boolean, minLength: number): boolean {
  return isLast || content.trim().length >= minLength;
}
