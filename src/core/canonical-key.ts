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

// ============================================================
// Entity Canonical Keys (Task Entity System)
// ============================================================

export type EntityKeyType = 'task' | 'condition' | 'artifact';

/**
 * Normalize text for entity key generation
 */
function normalizeForKey(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, '_')
    .trim();
}

/**
 * Generate canonical key for entities
 * Format: {type}:{project}:{normalized_identifier}
 */
export function makeEntityCanonicalKey(
  entityType: EntityKeyType,
  identifier: string,
  context?: { project?: string }
): string {
  const project = context?.project ?? 'default';

  switch (entityType) {
    case 'task':
      return `task:${project}:${normalizeForKey(identifier)}`;
    case 'condition':
      return `cond:${project}:${normalizeForKey(identifier)}`;
    case 'artifact':
      return makeArtifactKey(identifier);
  }
}

/**
 * Generate canonical key for artifacts based on identifier pattern
 * - URL: art:url:{sha1(url)}
 * - JIRA key: art:jira:{key}
 * - GitHub issue: art:gh_issue:{repo}:{num}
 * - Generic: art:generic:{sha1(identifier)}
 */
export function makeArtifactKey(identifier: string): string {
  // URL pattern
  if (/^https?:\/\//.test(identifier)) {
    const hash = createHash('sha1').update(identifier).digest('hex').slice(0, 12);
    return `art:url:${hash}`;
  }

  // JIRA key pattern (e.g., PROJ-123)
  const jiraMatch = identifier.match(/^([A-Z]+-\d+)$/);
  if (jiraMatch) {
    return `art:jira:${jiraMatch[1].toLowerCase()}`;
  }

  // GitHub issue pattern (e.g., owner/repo#123)
  const ghMatch = identifier.match(/^([^\/]+\/[^#]+)#(\d+)$/);
  if (ghMatch) {
    return `art:gh_issue:${ghMatch[1]}:${ghMatch[2]}`;
  }

  // Generic identifier
  const hash = createHash('sha1').update(identifier).digest('hex').slice(0, 12);
  return `art:generic:${hash}`;
}

/**
 * Generate dedupe key for task events
 */
export function makeTaskEventDedupeKey(
  eventType: string,
  taskId: string,
  sessionId: string,
  additionalContext?: string
): string {
  const parts = [eventType, taskId, sessionId];
  if (additionalContext) {
    parts.push(additionalContext);
  }
  const combined = parts.join(':');
  return createHash('sha256').update(combined).digest('hex');
}

/**
 * Parse entity canonical key to extract type and identifier
 */
export function parseEntityCanonicalKey(canonicalKey: string): {
  entityType: EntityKeyType;
  project?: string;
  identifier: string;
} | null {
  const taskMatch = canonicalKey.match(/^task:([^:]+):(.+)$/);
  if (taskMatch) {
    return { entityType: 'task', project: taskMatch[1], identifier: taskMatch[2] };
  }

  const condMatch = canonicalKey.match(/^cond:([^:]+):(.+)$/);
  if (condMatch) {
    return { entityType: 'condition', project: condMatch[1], identifier: condMatch[2] };
  }

  const artMatch = canonicalKey.match(/^art:([^:]+):(.+)$/);
  if (artMatch) {
    return { entityType: 'artifact', identifier: artMatch[2] };
  }

  return null;
}
