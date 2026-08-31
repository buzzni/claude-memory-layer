import {
  sqliteExec,
  sqliteGet,
  sqliteRun,
  type SQLiteDatabase
} from '../sqlite-wrapper.js';
import { evaluateRetentionCandidates } from './retention-audit.js';
import { RETENTION_POLICY_VERSION, type RetentionPolicyResult } from './retention-policy.js';
import { RetentionRepository, retentionScoreInputFromResult } from './retention-repository.js';

export interface RetentionLifecycleApplyOptions {
  projectHash: string;
  actor: string;
  policyVersion: string;
  expectedLifecycleVersion: number;
  limit?: number;
  now?: Date;
}

export interface RetentionLifecycleApplyResult {
  schemaVersion: 'retention-lifecycle-apply-v1';
  projectHash: string;
  policyVersion: typeof RETENTION_POLICY_VERSION;
  previousLifecycleVersion: number;
  lifecycleVersion: number;
  evaluated: number;
  written: number;
  unchanged: number;
  deletedEvents: 0;
}

export async function applyRetentionLifecycle(
  db: SQLiteDatabase,
  options: RetentionLifecycleApplyOptions
): Promise<RetentionLifecycleApplyResult> {
  const projectHash = normalizeProjectHash(options.projectHash);
  const actor = options.actor.trim();
  if (!actor) throw new Error('retention lifecycle actor is required');
  if (options.policyVersion !== RETENTION_POLICY_VERSION) {
    throw new Error(`unsupported retention lifecycle policy: ${options.policyVersion}`);
  }
  if (!Number.isInteger(options.expectedLifecycleVersion) || options.expectedLifecycleVersion < 0) {
    throw new Error('expected lifecycle version must be a non-negative integer');
  }

  const versionKey = `retention_lifecycle_version:${projectHash}`;
  let transactionOpen = false;
  try {
    sqliteExec(db, 'BEGIN IMMEDIATE');
    transactionOpen = true;
    const currentVersion = readLifecycleVersion(db, versionKey);
    if (currentVersion !== options.expectedLifecycleVersion) {
      throw new Error(`retention lifecycle version conflict: expected ${options.expectedLifecycleVersion}, current ${currentVersion}`);
    }

    const candidates = evaluateRetentionCandidates(db, {
      projectHash,
      limit: options.limit,
      now: options.now,
      dryRun: true
    });
    const repository = new RetentionRepository(db);
    let written = 0;
    let unchanged = 0;

    for (const candidate of candidates) {
      const existing = repository.getLatestForTarget({
        targetType: candidate.result.targetType,
        targetId: candidate.result.targetId,
        projectHash,
        policyVersion: options.policyVersion
      });
      if (existing && sameRetentionDecision(existing, candidate.result)) {
        unchanged += 1;
        continue;
      }
      repository.upsertSync(retentionScoreInputFromResult(candidate.result, {
        projectHash,
        actor,
        sourceEventIds: [candidate.result.targetId]
      }));
      written += 1;
    }

    const lifecycleVersion = written > 0 ? currentVersion + 1 : currentVersion;
    if (written > 0) {
      sqliteRun(
        db,
        `INSERT INTO endless_config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
        [versionKey, String(lifecycleVersion)]
      );
    }
    sqliteExec(db, 'COMMIT');
    transactionOpen = false;
    return {
      schemaVersion: 'retention-lifecycle-apply-v1',
      projectHash,
      policyVersion: RETENTION_POLICY_VERSION,
      previousLifecycleVersion: currentVersion,
      lifecycleVersion,
      evaluated: candidates.length,
      written,
      unchanged,
      deletedEvents: 0
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        sqliteExec(db, 'ROLLBACK');
      } catch {
        // Preserve the original lifecycle failure.
      }
    }
    throw error;
  }
}

function readLifecycleVersion(db: SQLiteDatabase, key: string): number {
  const row = sqliteGet<{ value: string }>(db, 'SELECT value FROM endless_config WHERE key = ?', [key]);
  if (!row) return 0;
  const normalized = row.value.trim();
  if (!/^(?:0|[1-9]\d*)$/.test(normalized)) {
    throw new Error('stored retention lifecycle version is invalid');
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('stored retention lifecycle version is invalid');
  }
  return parsed;
}

function sameRetentionDecision(
  existing: ReturnType<RetentionRepository['getLatestForTarget']> & {},
  result: RetentionPolicyResult
): boolean {
  return existing.decision === result.decision
    && existing.lifecycleScore === result.lifecycleScore
    && JSON.stringify(existing.factors) === JSON.stringify(result.factors)
    && JSON.stringify(existing.reasons) === JSON.stringify(result.reasons)
    && JSON.stringify(existing.dryRunDiff) === JSON.stringify(result.dryRunDiff);
}

function normalizeProjectHash(value: string): string {
  const normalized = value.trim();
  if (!/^[a-f0-9]{8}$/.test(normalized)) {
    throw new Error('retention lifecycle requires an exact 8-character lowercase project hash');
  }
  return normalized;
}
