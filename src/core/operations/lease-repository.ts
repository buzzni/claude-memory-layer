import { randomUUID } from 'crypto';

import {
  sqliteGet,
  sqliteRun,
  sqliteTransaction,
  toDateFromSQLite,
  type SQLiteDatabase
} from '../sqlite-wrapper.js';
import {
  AcquireLeaseInputSchema,
  LeaseTargetTypeSchema,
  ReleaseLeaseInputSchema,
  RenewLeaseInputSchema,
  type LeaseTargetType,
  type MemoryLease
} from './actions.js';
import { sanitizeGovernanceAuditValue, writeGovernanceAuditEntry } from './governance-audit.js';

interface MemoryLeaseRow {
  lease_id: string;
  target_type: string;
  target_id: string;
  holder: string;
  expires_at: string;
  metadata_json: string | null;
  created_at: string;
  renewed_at: string | null;
  released_at: string | null;
}

export interface LeaseAcquireResult {
  acquired: boolean;
  lease: MemoryLease;
}

function parseMetadata(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function rowToLease(row: MemoryLeaseRow): MemoryLease {
  return {
    leaseId: row.lease_id,
    targetType: LeaseTargetTypeSchema.parse(row.target_type),
    targetId: row.target_id,
    holder: row.holder,
    expiresAt: toDateFromSQLite(row.expires_at),
    metadata: parseMetadata(row.metadata_json),
    createdAt: toDateFromSQLite(row.created_at),
    renewedAt: row.renewed_at ? toDateFromSQLite(row.renewed_at) : undefined,
    releasedAt: row.released_at ? toDateFromSQLite(row.released_at) : undefined
  };
}

function leaseToAuditJson(lease: MemoryLease, transition: string): Record<string, unknown> {
  return {
    transition,
    leaseId: lease.leaseId,
    targetType: lease.targetType,
    targetId: lease.targetId,
    holder: lease.holder,
    expiresAt: lease.expiresAt.toISOString(),
    metadata: lease.metadata,
    createdAt: lease.createdAt.toISOString(),
    renewedAt: lease.renewedAt?.toISOString(),
    releasedAt: lease.releasedAt?.toISOString()
  };
}

export class LeaseRepository {
  constructor(private readonly db: SQLiteDatabase) {}

  async acquire(input: unknown): Promise<LeaseAcquireResult> {
    const parsed = AcquireLeaseInputSchema.parse(input);
    const now = parsed.now ?? new Date();
    const nowIso = now.toISOString();
    const lease = sqliteTransaction(this.db, () => {
      const active = this.getActiveLeaseSync(parsed.targetType, parsed.targetId, now);
      if (active) {
        return { acquired: active.holder === parsed.holder, lease: active, inserted: false };
      }
      const leaseId = randomUUID();
      const metadata = parsed.metadata
        ? sanitizeGovernanceAuditValue(parsed.metadata) as Record<string, unknown>
        : undefined;
      sqliteRun(
        this.db,
        `INSERT INTO memory_leases (lease_id, target_type, target_id, holder, expires_at, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          leaseId,
          parsed.targetType,
          parsed.targetId,
          parsed.holder,
          parsed.expiresAt.toISOString(),
          metadata ? JSON.stringify(metadata) : null,
          nowIso
        ]
      );
      return { acquired: true, lease: this.require(leaseId), inserted: true };
    });

    if (lease.inserted) {
      await this.auditLeaseTransition('acquire', lease.lease, parsed.actor, parsed.projectHash);
    }
    return { acquired: lease.acquired, lease: lease.lease };
  }

  async renew(input: unknown): Promise<MemoryLease | null> {
    const parsed = RenewLeaseInputSchema.parse(input);
    const before = this.get(parsed.leaseId);
    if (!before || before.holder !== parsed.holder || before.releasedAt) return null;
    const active = this.getActiveLeaseSync(before.targetType, before.targetId, parsed.now ?? new Date());
    if (!active || active.leaseId !== before.leaseId) return null;

    const renewedAt = new Date().toISOString();
    sqliteRun(
      this.db,
      `UPDATE memory_leases SET expires_at = ?, renewed_at = ? WHERE lease_id = ?`,
      [parsed.expiresAt.toISOString(), renewedAt, parsed.leaseId]
    );
    const after = this.require(parsed.leaseId);
    await this.auditLeaseTransition('renew', after, parsed.actor, parsed.projectHash, before);
    return after;
  }

  async release(input: unknown): Promise<boolean> {
    const parsed = ReleaseLeaseInputSchema.parse(input);
    const before = this.get(parsed.leaseId);
    if (!before || before.holder !== parsed.holder || before.releasedAt) return false;

    sqliteRun(this.db, `UPDATE memory_leases SET released_at = ? WHERE lease_id = ?`, [new Date().toISOString(), parsed.leaseId]);
    const after = this.require(parsed.leaseId);
    await this.auditLeaseTransition('release', after, parsed.actor, parsed.projectHash, before);
    return true;
  }

  get(leaseId: string): MemoryLease | null {
    const row = sqliteGet<MemoryLeaseRow>(this.db, `SELECT * FROM memory_leases WHERE lease_id = ?`, [leaseId]);
    return row ? rowToLease(row) : null;
  }

  async getActiveLease(targetType: LeaseTargetType, targetId: string, now = new Date()): Promise<MemoryLease | null> {
    return this.getActiveLeaseSync(LeaseTargetTypeSchema.parse(targetType), targetId.trim(), now);
  }

  private getActiveLeaseSync(targetType: LeaseTargetType, targetId: string, now: Date): MemoryLease | null {
    const row = sqliteGet<MemoryLeaseRow>(
      this.db,
      `SELECT * FROM memory_leases
       WHERE target_type = ? AND target_id = ? AND released_at IS NULL AND expires_at > ?
       ORDER BY expires_at DESC LIMIT 1`,
      [targetType, targetId, now.toISOString()]
    );
    return row ? rowToLease(row) : null;
  }

  private require(leaseId: string): MemoryLease {
    const lease = this.get(leaseId);
    if (!lease) throw new Error(`Memory lease not found: ${leaseId}`);
    return lease;
  }

  private async auditLeaseTransition(
    transition: string,
    after: MemoryLease,
    actor: string | undefined,
    projectHash: string | undefined,
    before?: MemoryLease
  ): Promise<void> {
    await writeGovernanceAuditEntry(this.db, {
      operation: 'lease_acquire',
      actor: actor ?? 'cml-core',
      projectHash,
      targetType: 'lease',
      targetId: after.leaseId,
      beforeJson: before ? leaseToAuditJson(before, transition) : undefined,
      afterJson: leaseToAuditJson(after, transition),
      sourceEventIds: []
    });
  }
}
