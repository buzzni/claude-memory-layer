import { randomUUID } from 'crypto';

import {
  sqliteRun,
  type SQLiteDatabase
} from '../sqlite-wrapper.js';

export const MEMORY_GOVERNANCE_AUDIT_OPERATIONS = [
  'facet_tag',
  'action_update',
  'lease_acquire',
  'checkpoint_create',
  'retention_score',
  'quarantine',
  'verify',
  'lesson_promote',
  'lesson_capture',
  'actor_card_upsert',
  'perspective_observation_create',
  'perspective_observation_delete',
  'core_memory_block_update',
  'entity_supersede',
  'memory_asset_create',
  'memory_asset_update',
  'memory_asset_bind',
  'memory_asset_grant_set'
] as const;

export type MemoryGovernanceAuditOperation = typeof MEMORY_GOVERNANCE_AUDIT_OPERATIONS[number];

export interface GovernanceAuditEntryInput {
  operation: MemoryGovernanceAuditOperation;
  actor: string;
  projectHash?: string;
  targetType: string;
  targetId: string;
  beforeJson?: Record<string, unknown>;
  afterJson?: Record<string, unknown>;
  sourceEventIds?: string[];
}

export interface MemoryGovernanceAuditEntry {
  auditId: string;
  operation: MemoryGovernanceAuditOperation;
  actor: string;
  projectHash?: string;
  targetType: string;
  targetId: string;
  beforeJson?: Record<string, unknown>;
  afterJson?: Record<string, unknown>;
  sourceEventIds: string[];
  createdAt: Date;
}

function normalizeRequiredString(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  return normalized;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

const REDACTED = '[REDACTED]';
const sensitiveKeyPattern = /(?:api[_-]?key|secret|password|passwd|token|access[_-]?token|client[_-]?secret|crtfc[_-]?key|hashkey|serviceKey)/i;
/**
 * The tail after the path's leading separator is `{0,300}` of any path-legal
 * character (spaces included — real paths contain "Application Support"),
 * then `[^\s…]*` to finish the current whitespace-free token.
 *
 * Both halves close an observed hole:
 * - Unbounded (`*`), one incidental "/" inside prose (a fraction, an "A/B"
 *   aside, LLM-generated lesson text) deleted everything to the end of the
 *   line. The 300-char bound caps that blast radius.
 * - Bounded alone, a path *longer* than 300 chars (deep node_modules/pnpm
 *   chains) leaked its tail — the most identifying part — into stored audit
 *   rows. Such paths contain no spaces, so finishing the current token
 *   redacts them in full while prose beyond the next space still survives.
 */
const POSIX_ABSOLUTE_PATH_PATTERN = /(^|[^A-Za-z0-9._\/\\-])\/(?!\/)[^\n\r"'<>|`]{0,300}[^\s"'<>|`]*/g;
const WINDOWS_DRIVE_PATH_PATTERN = /(^|[^A-Za-z0-9._\/\\-])(?:[A-Za-z]:[\\/][^\n\r"'<>|`]{0,300}[^\s"'<>|`]*)/g;
// The host segment stops at either separator so `\\host/share/...` (forward
// slashes after the host, which Windows accepts) is caught too — retention's
// deleted copy matched it, and consolidating on a backslash-only separator
// would have silently un-redacted those paths in retention previews.
const WINDOWS_UNC_PATH_PATTERN = /(^|[^A-Za-z0-9._\/\\-])(?:\\\\[^\\/\s"'<>|`]+[\\/][^\n\r"'<>|`]{0,300}[^\s"'<>|`]*)/g;
const credentialQueryPattern = /\b((?:api[_-]?key|token|access[_-]?token|client[_-]?secret|crtfc[_-]?key|hashkey|serviceKey)=)[^&\s`"'<>]+/gi;
const credentialAssignmentPattern = /\b((?:api[_-]?key|secret|password|passwd|token|access[_-]?token|client[_-]?secret|crtfc[_-]?key|hashkey|serviceKey)\s*[:=]\s*)[^\s`"'<>},]+/gi;

/**
 * Shared local-path redactor. Exported so retention-audit's preview redaction
 * uses these same patterns — a second hand-maintained copy of the regexes is
 * how the two files drifted apart in the first place.
 */
export function redactAbsolutePaths(value: string): string {
  return value
    .replace(WINDOWS_UNC_PATH_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(WINDOWS_DRIVE_PATH_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(POSIX_ABSOLUTE_PATH_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`);
}

function sanitizeAuditString(value: string): string {
  return redactAbsolutePaths(value)
    .replace(credentialQueryPattern, `$1${REDACTED}`)
    .replace(credentialAssignmentPattern, `$1${REDACTED}`);
}

export function sanitizeGovernanceAuditValue(value: unknown, key?: string): unknown {
  if (key && sensitiveKeyPattern.test(key)) {
    return REDACTED;
  }
  if (typeof value === 'string') {
    return sanitizeAuditString(value);
  }
  if (value instanceof Date) {
    return sanitizeAuditString(value.toISOString());
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeGovernanceAuditValue(item));
  }
  if (value && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      sanitized[sanitizeAuditString(entryKey)] = sanitizeGovernanceAuditValue(entryValue, entryKey);
    }
    return sanitized;
  }
  return value;
}

function sanitizeAuditJson(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return sanitizeGovernanceAuditValue(value) as Record<string, unknown>;
}

function normalizeSourceEventIds(sourceEventIds: string[] | undefined): string[] {
  return (sourceEventIds || [])
    .map((sourceEventId) => sanitizeAuditString(sourceEventId.trim()))
    .filter((sourceEventId) => sourceEventId.length > 0);
}

function normalizeOperation(operation: MemoryGovernanceAuditOperation): MemoryGovernanceAuditOperation {
  if ((MEMORY_GOVERNANCE_AUDIT_OPERATIONS as readonly string[]).indexOf(operation) === -1) {
    throw new Error(`Unsupported governance audit operation: ${operation}`);
  }
  return operation;
}

/**
 * Synchronous audit writer for callers that must include the audit row in an
 * existing better-sqlite3 transaction.
 */
export function writeGovernanceAuditEntrySync(
  db: SQLiteDatabase,
  input: GovernanceAuditEntryInput
): MemoryGovernanceAuditEntry {
  const entry: MemoryGovernanceAuditEntry = {
    auditId: randomUUID(),
    operation: normalizeOperation(input.operation),
    actor: sanitizeAuditString(normalizeRequiredString(input.actor, 'actor')),
    projectHash: normalizeOptionalString(input.projectHash),
    targetType: normalizeRequiredString(input.targetType, 'targetType'),
    targetId: sanitizeAuditString(normalizeRequiredString(input.targetId, 'targetId')),
    beforeJson: sanitizeAuditJson(input.beforeJson),
    afterJson: sanitizeAuditJson(input.afterJson),
    sourceEventIds: normalizeSourceEventIds(input.sourceEventIds),
    createdAt: new Date()
  };

  sqliteRun(
    db,
    `INSERT INTO memory_governance_audit (
      audit_id, operation, actor, project_hash, target_type, target_id,
      before_json, after_json, source_event_ids, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.auditId,
      entry.operation,
      entry.actor,
      entry.projectHash ?? null,
      entry.targetType,
      entry.targetId,
      entry.beforeJson === undefined ? null : JSON.stringify(entry.beforeJson),
      entry.afterJson === undefined ? null : JSON.stringify(entry.afterJson),
      JSON.stringify(entry.sourceEventIds),
      entry.createdAt.toISOString()
    ]
  );

  return entry;
}

/** Preserve the existing async API used by repositories and external callers. */
export async function writeGovernanceAuditEntry(
  db: SQLiteDatabase,
  input: GovernanceAuditEntryInput
): Promise<MemoryGovernanceAuditEntry> {
  return writeGovernanceAuditEntrySync(db, input);
}
