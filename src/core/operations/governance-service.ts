import { randomUUID } from 'crypto';
import { z } from 'zod';

import {
  sanitizeGovernanceAuditValue,
  type MemoryGovernanceAuditEntry
} from './governance-audit.js';
import {
  sqliteGet,
  sqliteRun,
  sqliteTransaction,
  type SQLiteDatabase
} from '../sqlite-wrapper.js';

const SafeGovernanceLabelSchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'must be a safe label');

const QuarantineInputSchema = z.object({
  targetType: z.literal('event'),
  targetId: z.string().trim().min(1),
  projectHash: SafeGovernanceLabelSchema,
  actor: SafeGovernanceLabelSchema.default('cml-core'),
  category: SafeGovernanceLabelSchema.default('manual'),
  reason: SafeGovernanceLabelSchema,
  sourceEventIds: z.array(z.string().trim().min(1)).default([]),
  now: z.date().optional()
});

export type QuarantineInput = z.input<typeof QuarantineInputSchema>;
type ParsedQuarantineInput = z.output<typeof QuarantineInputSchema>;

export interface GovernanceQuarantineMetadata {
  status: 'active';
  category: string;
  reason: string;
  actor: string;
  expectedProjectHash: string;
  quarantinedAt: string;
  detectedAt: string;
}

export interface GovernanceQuarantineResult {
  targetType: 'event';
  targetId: string;
  projectHash: string;
  changed: boolean;
  quarantine: GovernanceQuarantineMetadata;
  auditEntry?: MemoryGovernanceAuditEntry;
}

export interface GovernanceServiceOptions {
  /** @internal Test hook used to simulate a stale row between validation and write. */
  beforeQuarantineUpdate?: () => void;
}

interface EventMetadataRow {
  id: string;
  metadata: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getNestedString(root: Record<string, unknown> | undefined, path: string[]): string | undefined {
  let cursor: unknown = root;
  for (const key of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[key];
  }
  return typeof cursor === 'string' && cursor.trim().length > 0 ? cursor.trim() : undefined;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (isRecord(value)) return { ...value };
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? { ...parsed } : {};
  } catch {
    return {};
  }
}

function metadataProjectHash(metadata: Record<string, unknown>): string | undefined {
  return getNestedString(metadata, ['scope', 'project', 'hash'])
    ?? getNestedString(metadata, ['projectHash']);
}

function eventToAuditJson(row: EventMetadataRow, metadata: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    metadata
  };
}

function appendMetadataTag(metadata: Record<string, unknown>, tag: string): void {
  const tags = Array.isArray(metadata.tags)
    ? metadata.tags.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : [];
  if (!tags.includes(tag)) metadata.tags = [...tags, tag];
}

function createAuditEntryInTransaction(
  db: SQLiteDatabase,
  input: ParsedQuarantineInput,
  beforeJson: Record<string, unknown>,
  afterJson: Record<string, unknown>,
  createdAt: Date
): MemoryGovernanceAuditEntry {
  const sanitizedTargetId = sanitizeGovernanceAuditValue(input.targetId) as string;
  const sanitizedSourceEventIds = sanitizeGovernanceAuditValue(input.sourceEventIds) as string[];
  const entry: MemoryGovernanceAuditEntry = {
    auditId: randomUUID(),
    operation: 'quarantine',
    actor: input.actor,
    projectHash: input.projectHash,
    targetType: input.targetType,
    targetId: sanitizedTargetId,
    beforeJson: sanitizeGovernanceAuditValue(beforeJson) as Record<string, unknown>,
    afterJson: sanitizeGovernanceAuditValue(afterJson) as Record<string, unknown>,
    sourceEventIds: sanitizedSourceEventIds,
    createdAt
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

export class GovernanceService {
  constructor(
    private readonly db: SQLiteDatabase,
    private readonly options: GovernanceServiceOptions = {}
  ) {}

  async quarantine(input: QuarantineInput): Promise<GovernanceQuarantineResult> {
    const parsed = QuarantineInputSchema.parse(input);

    return sqliteTransaction(this.db, () => {
      const row = sqliteGet<EventMetadataRow>(
        this.db,
        `SELECT id, metadata FROM events WHERE id = ?`,
        [parsed.targetId]
      );
      if (!row) {
        throw new Error(`event not found: ${parsed.targetId}`);
      }

      const metadata = parseMetadata(row.metadata);
      const currentProjectHash = metadataProjectHash(metadata);
      if (!currentProjectHash) {
        throw new Error(`Cannot quarantine event without explicit project scope: ${parsed.targetId}`);
      }
      if (currentProjectHash !== parsed.projectHash) {
        throw new Error(`event projectHash mismatch: event uses ${currentProjectHash} but input uses ${parsed.projectHash}`);
      }

      const now = parsed.now ?? new Date();
      const nowIso = now.toISOString();
      const quarantine: GovernanceQuarantineMetadata = {
        status: 'active',
        category: parsed.category,
        reason: parsed.reason,
        actor: parsed.actor,
        expectedProjectHash: parsed.projectHash,
        quarantinedAt: nowIso,
        detectedAt: nowIso
      };
      const beforeMetadata = { ...metadata };
      const afterMetadata: Record<string, unknown> = {
        ...metadata,
        quarantine: {
          ...(isRecord(metadata.quarantine) ? metadata.quarantine : {}),
          ...quarantine
        }
      };
      appendMetadataTag(afterMetadata, `quarantine:${parsed.category}`);

      const changed = JSON.stringify(beforeMetadata) !== JSON.stringify(afterMetadata);
      if (!changed) {
        return {
          targetType: parsed.targetType,
          targetId: parsed.targetId,
          projectHash: parsed.projectHash,
          changed,
          quarantine
        };
      }

      this.options.beforeQuarantineUpdate?.();
      const updateResult = sqliteRun(
        this.db,
        `UPDATE events SET metadata = ? WHERE id = ? AND metadata IS ?`,
        [JSON.stringify(afterMetadata), parsed.targetId, row.metadata]
      );
      if (updateResult.changes !== 1) {
        throw new Error(`event changed during quarantine validation; retry: ${parsed.targetId}`);
      }
      const auditEntry = createAuditEntryInTransaction(
        this.db,
        parsed,
        eventToAuditJson(row, beforeMetadata),
        eventToAuditJson(row, afterMetadata),
        now
      );

      return {
        targetType: parsed.targetType,
        targetId: parsed.targetId,
        projectHash: parsed.projectHash,
        changed,
        quarantine,
        auditEntry
      };
    });
  }
}
