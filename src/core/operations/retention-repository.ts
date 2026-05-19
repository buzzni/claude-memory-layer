import { randomUUID } from 'crypto';
import { z } from 'zod';

import {
  sqliteAll,
  sqliteGet,
  sqliteRun,
  toDateFromSQLite,
  type SQLiteDatabase
} from '../sqlite-wrapper.js';
import {
  RETENTION_POLICY_VERSION,
  RetentionDecisionSchema,
  RetentionDryRunActionSchema,
  RetentionTargetTypeSchema,
  type RetentionDecision,
  type RetentionDryRunDiff,
  type RetentionPolicyResult,
  type RetentionReason,
  type RetentionScoreFactors,
  type RetentionTargetType
} from './retention-policy.js';
import { writeGovernanceAuditEntry } from './governance-audit.js';

const RequiredTrimmedStringSchema = z.string().trim().min(1);

const OptionalTrimmedStringSchema = z.string().trim().min(1).optional();

const DateLikeSchema = z.preprocess((value) => {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value);
  return value;
}, z.date());

const RetentionReasonSchema = z.object({
  code: RequiredTrimmedStringSchema,
  message: z.string(),
  contribution: z.number()
});

const RetentionScoreFactorsSchema = z.object({
  level: z.number(),
  recency: z.number(),
  retrieval: z.number(),
  helpfulness: z.number(),
  evidence: z.number(),
  eventType: z.number(),
  privacy: z.number(),
  manual: z.number()
});

const RetentionDryRunDiffSchema = z.object({
  wouldChange: z.boolean(),
  action: RetentionDryRunActionSchema,
  after: z.object({
    retentionDecision: RetentionDecisionSchema,
    policyVersion: z.string().min(1)
  }).optional()
});

const RetentionPolicyResultSchema = z.object({
  targetId: RequiredTrimmedStringSchema,
  targetType: RetentionTargetTypeSchema,
  projectHash: OptionalTrimmedStringSchema,
  policyVersion: z.string().min(1),
  dryRun: z.literal(true),
  decision: RetentionDecisionSchema,
  lifecycleScore: z.number().min(0).max(1),
  factors: RetentionScoreFactorsSchema,
  reasons: z.array(RetentionReasonSchema),
  dryRunDiff: RetentionDryRunDiffSchema,
  evaluatedAt: DateLikeSchema
});

type ParsedRetentionPolicyResult = z.output<typeof RetentionPolicyResultSchema>;

const StringArraySchema = z.array(z.preprocess(
  (value) => typeof value === 'string' ? value.trim() : value,
  z.string().min(1)
)).default([]);

const FlatUpsertInputSchema = RetentionPolicyResultSchema.extend({
  actor: OptionalTrimmedStringSchema,
  sourceEventIds: StringArraySchema
});

const WrappedUpsertInputSchema = z.object({
  result: RetentionPolicyResultSchema,
  projectHash: OptionalTrimmedStringSchema,
  actor: OptionalTrimmedStringSchema,
  sourceEventIds: StringArraySchema
});

const GetRetentionScoreInputSchema = z.object({
  targetType: RetentionTargetTypeSchema,
  targetId: RequiredTrimmedStringSchema,
  projectHash: RequiredTrimmedStringSchema,
  policyVersion: z.string().min(1).optional()
});

const ListRetentionScoresInputSchema = z.object({
  projectHash: RequiredTrimmedStringSchema,
  policyVersion: z.string().min(1).optional(),
  decision: RetentionDecisionSchema.optional(),
  limit: z.number().int().min(1).max(1000).default(100)
});

export type UpsertRetentionScoreInput = z.input<typeof FlatUpsertInputSchema> | z.input<typeof WrappedUpsertInputSchema>;
export type GetRetentionScoreInput = z.input<typeof GetRetentionScoreInputSchema>;
export type ListRetentionScoresInput = z.input<typeof ListRetentionScoresInputSchema>;

export interface MemoryRetentionScore {
  scoreId: string;
  targetType: RetentionTargetType;
  targetId: string;
  projectHash: string;
  policyVersion: string;
  decision: RetentionDecision;
  lifecycleScore: number;
  factors: RetentionScoreFactors;
  reasons: RetentionReason[];
  dryRunDiff: RetentionDryRunDiff;
  sourceEventIds: string[];
  evaluatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface MemoryRetentionScoreRow {
  score_id: string;
  target_type: string;
  target_id: string;
  project_hash: string;
  policy_version: string;
  decision: string;
  lifecycle_score: number;
  factors_json: string;
  reasons_json: string;
  dry_run_diff_json: string;
  source_event_ids: string;
  evaluated_at: string;
  created_at: string;
  updated_at: string;
}

interface NormalizedUpsertInput {
  result: ParsedRetentionPolicyResult;
  projectHash: string;
  actor?: string;
  sourceEventIds: string[];
}

function parseJson<T>(value: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(value));
  } catch {
    return schema.parse(undefined);
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
  } catch {
    return [];
  }
}

function rowToRetentionScore(row: MemoryRetentionScoreRow): MemoryRetentionScore {
  return {
    scoreId: row.score_id,
    targetType: RetentionTargetTypeSchema.parse(row.target_type),
    targetId: row.target_id,
    projectHash: row.project_hash,
    policyVersion: row.policy_version,
    decision: RetentionDecisionSchema.parse(row.decision),
    lifecycleScore: Number(row.lifecycle_score),
    factors: parseJson(row.factors_json, RetentionScoreFactorsSchema) as RetentionScoreFactors,
    reasons: parseJson(row.reasons_json, z.array(RetentionReasonSchema)) as RetentionReason[],
    dryRunDiff: parseJson(row.dry_run_diff_json, RetentionDryRunDiffSchema) as RetentionDryRunDiff,
    sourceEventIds: parseStringArray(row.source_event_ids),
    evaluatedAt: toDateFromSQLite(row.evaluated_at),
    createdAt: toDateFromSQLite(row.created_at),
    updatedAt: toDateFromSQLite(row.updated_at)
  };
}

function normalizeUpsertInput(input: unknown): NormalizedUpsertInput {
  const maybeInput = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  if ('result' in maybeInput) {
    const parsed = WrappedUpsertInputSchema.parse(input);
    const resultProjectHash = parsed.result.projectHash;
    if (parsed.projectHash && resultProjectHash && parsed.projectHash !== resultProjectHash) {
      throw new Error(`projectHash mismatch: result uses ${resultProjectHash} but input uses ${parsed.projectHash}`);
    }
    const projectHash = parsed.projectHash ?? resultProjectHash;
    if (!projectHash) throw new Error('projectHash is required for retention score writes');
    return {
      result: parsed.result,
      projectHash,
      actor: parsed.actor,
      sourceEventIds: parsed.sourceEventIds
    };
  }

  const parsed = FlatUpsertInputSchema.parse(input);
  if (!parsed.projectHash) throw new Error('projectHash is required for retention score writes');
  return {
    result: parsed,
    projectHash: parsed.projectHash,
    actor: parsed.actor,
    sourceEventIds: parsed.sourceEventIds
  };
}

function retentionScoreToAuditJson(score: MemoryRetentionScore): Record<string, unknown> {
  return {
    scoreId: score.scoreId,
    targetType: score.targetType,
    targetId: score.targetId,
    projectHash: score.projectHash,
    policyVersion: score.policyVersion,
    decision: score.decision,
    lifecycleScore: score.lifecycleScore,
    factors: score.factors,
    reasons: score.reasons,
    dryRunDiff: score.dryRunDiff,
    sourceEventIds: score.sourceEventIds,
    evaluatedAt: score.evaluatedAt.toISOString(),
    createdAt: score.createdAt.toISOString(),
    updatedAt: score.updatedAt.toISOString()
  };
}

export class RetentionRepository {
  constructor(private readonly db: SQLiteDatabase) {}

  async upsert(input: unknown): Promise<MemoryRetentionScore> {
    const parsed = normalizeUpsertInput(input);
    const existing = this.getLatestForTarget({
      targetType: parsed.result.targetType,
      targetId: parsed.result.targetId,
      projectHash: parsed.projectHash,
      policyVersion: parsed.result.policyVersion
    });
    const now = new Date().toISOString();
    const scoreId = existing?.scoreId ?? randomUUID();

    if (existing) {
      sqliteRun(
        this.db,
        `UPDATE memory_retention_scores
         SET decision = ?, lifecycle_score = ?, factors_json = ?, reasons_json = ?,
             dry_run_diff_json = ?, source_event_ids = ?, evaluated_at = ?, updated_at = ?
         WHERE score_id = ? AND project_hash = ?`,
        [
          parsed.result.decision,
          parsed.result.lifecycleScore,
          JSON.stringify(parsed.result.factors),
          JSON.stringify(parsed.result.reasons),
          JSON.stringify(parsed.result.dryRunDiff),
          JSON.stringify(parsed.sourceEventIds),
          parsed.result.evaluatedAt.toISOString(),
          now,
          scoreId,
          parsed.projectHash
        ]
      );
    } else {
      sqliteRun(
        this.db,
        `INSERT INTO memory_retention_scores (
          score_id, target_type, target_id, project_hash, policy_version, decision,
          lifecycle_score, factors_json, reasons_json, dry_run_diff_json,
          source_event_ids, evaluated_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          scoreId,
          parsed.result.targetType,
          parsed.result.targetId,
          parsed.projectHash,
          parsed.result.policyVersion,
          parsed.result.decision,
          parsed.result.lifecycleScore,
          JSON.stringify(parsed.result.factors),
          JSON.stringify(parsed.result.reasons),
          JSON.stringify(parsed.result.dryRunDiff),
          JSON.stringify(parsed.sourceEventIds),
          parsed.result.evaluatedAt.toISOString(),
          now,
          now
        ]
      );
    }

    const saved = this.require(scoreId, parsed.projectHash);
    await writeGovernanceAuditEntry(this.db, {
      operation: 'retention_score',
      actor: parsed.actor ?? 'cml-core',
      projectHash: parsed.projectHash,
      targetType: parsed.result.targetType,
      targetId: parsed.result.targetId,
      beforeJson: existing ? retentionScoreToAuditJson(existing) : undefined,
      afterJson: retentionScoreToAuditJson(saved),
      sourceEventIds: parsed.sourceEventIds
    });
    return saved;
  }

  getLatestForTarget(input: unknown): MemoryRetentionScore | null {
    const parsed = GetRetentionScoreInputSchema.parse(input);
    const params: unknown[] = [parsed.targetType, parsed.targetId, parsed.projectHash];
    const clauses = ['target_type = ?', 'target_id = ?', 'project_hash = ?'];
    if (parsed.policyVersion) {
      clauses.push('policy_version = ?');
      params.push(parsed.policyVersion);
    }
    const sql = 'SELECT * FROM memory_retention_scores WHERE ' + clauses.join(' AND ') + ' ORDER BY evaluated_at DESC LIMIT 1';
    const row = sqliteGet<MemoryRetentionScoreRow>(this.db, sql, params);
    return row ? rowToRetentionScore(row) : null;
  }

  async list(input: unknown): Promise<MemoryRetentionScore[]> {
    const parsed = ListRetentionScoresInputSchema.parse(input);
    const clauses = ['project_hash = ?'];
    const params: unknown[] = [parsed.projectHash];
    if (parsed.policyVersion) {
      clauses.push('policy_version = ?');
      params.push(parsed.policyVersion);
    }
    if (parsed.decision) {
      clauses.push('decision = ?');
      params.push(parsed.decision);
    }
    params.push(parsed.limit);
    const whereClause = clauses.join(' AND ');
    const sql = 'SELECT * FROM memory_retention_scores WHERE ' + whereClause + ' ORDER BY lifecycle_score ASC, evaluated_at DESC LIMIT ?';
    return sqliteAll<MemoryRetentionScoreRow>(this.db, sql, params).map(rowToRetentionScore);
  }

  private require(scoreId: string, projectHash: string): MemoryRetentionScore {
    const row = sqliteGet<MemoryRetentionScoreRow>(
      this.db,
      `SELECT * FROM memory_retention_scores WHERE score_id = ? AND project_hash = ?`,
      [scoreId, projectHash]
    );
    if (!row) throw new Error(`Memory retention score not found: ${scoreId}`);
    return rowToRetentionScore(row);
  }
}

export function retentionScoreInputFromResult(
  result: RetentionPolicyResult,
  options: { projectHash?: string; sourceEventIds?: string[]; actor?: string } = {}
): UpsertRetentionScoreInput {
  return {
    result,
    projectHash: options.projectHash ?? result.projectHash,
    sourceEventIds: options.sourceEventIds ?? [],
    actor: options.actor
  };
}

export { RETENTION_POLICY_VERSION };
