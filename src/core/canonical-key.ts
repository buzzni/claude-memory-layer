/**
 * AXIOMMIND canonical_key.py port
 * Deterministic normalization ensuring identical titles always map to same keys
 */

import { createHash } from 'crypto';

const MAX_KEY_LENGTH = 200;

/**
 * Convert text to a normalized canonical key
 *
 * Normalization steps:
 * 1. NFKC unicode normalization
 * 2. Lowercase conversion
 * 3. Punctuation removal
 * 4. Consecutive whitespace cleanup
 * 5. Context addition (optional)
 * 6. Long key truncation with MD5
 */
export function makeCanonicalKey(
  title: string,
  context?: { project?: string; sessionId?: string }
): string {
  // Step 1: NFKC normalization
  let normalized = title.normalize('NFKC');

  // Step 2: Lowercase conversion
  normalized = normalized.toLowerCase();

  // Step 3: Punctuation removal (unicode compatible)
  normalized = normalized.replace(/[^\p{L}\p{N}\s]/gu, '');

  // Step 4: Consecutive whitespace cleanup
  normalized = normalized.replace(/\s+/g, ' ').trim();

  // Step 5: Context addition
  let key = normalized;
  if (context?.project) {
    key = `${context.project}::${key}`;
  }

  // Step 6: Long key handling
  if (key.length > MAX_KEY_LENGTH) {
    const hashSuffix = createHash('md5').update(key).digest('hex').slice(0, 8);
    key = key.slice(0, MAX_KEY_LENGTH - 9) + '_' + hashSuffix;
  }

  return key;
}

/**
 * Check if two texts have the same canonical key
 */
export function isSameCanonicalKey(a: string, b: string): boolean {
  return makeCanonicalKey(a) === makeCanonicalKey(b);
}

/**
 * Generate dedupe key (content + session for uniqueness)
 * AXIOMMIND Principle 3: Idempotency guarantee
 */
export function makeDedupeKey(content: string, sessionId: string): string {
  const contentHash = createHash('sha256').update(content).digest('hex');
  return `${sessionId}:${contentHash}`;
}

/**
 * Generate content hash for deduplication
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
