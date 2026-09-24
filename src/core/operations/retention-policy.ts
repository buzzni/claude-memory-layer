import { z } from 'zod';

export const RETENTION_POLICY_VERSION = 'v1' as const;

export const RetentionDecisionSchema = z.enum([
  'keep',
  'review',
  'downgrade',
  'quarantine',
  'tombstone_candidate'
]);
export type RetentionDecision = z.infer<typeof RetentionDecisionSchema>;

export const RetentionDryRunActionSchema = z.enum([
  'none',
  'already_quarantined',
  'mark_review_required',
  'mark_downgrade_candidate',
  'mark_tombstone_candidate',
  'mark_quarantine_candidate'
]);
export type RetentionDryRunAction = z.infer<typeof RetentionDryRunActionSchema>;

export const RetentionTargetTypeSchema = z.enum([
  'event',
  'entity',
  'edge',
  'consolidated_memory',
  'lesson',
  'action'
]);
export type RetentionTargetType = z.infer<typeof RetentionTargetTypeSchema>;

export const RetentionMemoryLevelSchema = z.enum(['L0', 'L1', 'L2', 'L3', 'L4']);
export type RetentionMemoryLevel = z.infer<typeof RetentionMemoryLevelSchema>;

export const RetentionFacetSchema = z.object({
  dimension: z.string().trim().min(1),
  value: z.string().trim().min(1),
  confidence: z.number().min(0).max(1).default(1)
});
export type RetentionFacet = z.infer<typeof RetentionFacetSchema>;

const DateLikeSchema = z.preprocess((value) => {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value);
  return value;
}, z.date());

const NullableDateLikeSchema = z.preprocess((value) => {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value);
  return value;
}, z.date().nullable());

const OptionalTrimmedStringSchema = z.preprocess(
  (value) => typeof value === 'string' ? value.trim() : value,
  z.string().min(1).optional()
);

export const RetentionPolicyInputSchema = z.object({
  targetId: z.string().trim().min(1),
  targetType: RetentionTargetTypeSchema.default('event'),
  projectHash: OptionalTrimmedStringSchema,
  eventType: z.string().trim().min(1).optional(),
  memoryLevel: RetentionMemoryLevelSchema.default('L0'),
  createdAt: DateLikeSchema,
  lastAccessedAt: NullableDateLikeSchema.optional().default(null),
  retrievalCount: z.number().int().min(0).default(0),
  helpfulnessScore: z.number().min(0).max(1).optional(),
  adherenceScore: z.number().min(0).max(1).optional(),
  evidenceConfidence: z.number().min(0).max(1).optional(),
  metadata: z.record(z.unknown()).default({}),
  facets: z.array(RetentionFacetSchema).default([])
});
export type RetentionPolicyInput = z.input<typeof RetentionPolicyInputSchema>;
type ParsedRetentionPolicyInput = z.output<typeof RetentionPolicyInputSchema>;

export interface RetentionReason {
  code: string;
  message: string;
  contribution: number;
}

export interface RetentionScoreFactors {
  level: number;
  recency: number;
  retrieval: number;
  helpfulness: number;
  evidence: number;
  eventType: number;
  privacy: number;
  manual: number;
}

export interface RetentionDryRunDiff {
  wouldChange: boolean;
  action: RetentionDryRunAction;
  after?: {
    retentionDecision: RetentionDecision;
    policyVersion: typeof RETENTION_POLICY_VERSION;
  };
}

export interface RetentionPolicyResult {
  targetId: string;
  targetType: RetentionTargetType;
  projectHash?: string;
  policyVersion: typeof RETENTION_POLICY_VERSION;
  dryRun: true;
  decision: RetentionDecision;
  lifecycleScore: number;
  factors: RetentionScoreFactors;
  reasons: RetentionReason[];
  dryRunDiff: RetentionDryRunDiff;
  evaluatedAt: Date;
}

export interface RetentionPolicyOptions {
  now?: Date | string | number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const LEVEL_SCORE: Record<RetentionMemoryLevel, number> = {
  L0: 0.1,
  L1: 0.25,
  L2: 0.5,
  L3: 0.75,
  L4: 0.95
};

const WEIGHTS: Record<keyof RetentionScoreFactors, number> = {
  level: 0.18,
  recency: 0.18,
  retrieval: 0.17,
  helpfulness: 0.18,
  evidence: 0.18,
  eventType: 0.06,
  privacy: 0.05,
  manual: 0
};

export function evaluateRetentionPolicy(
  input: RetentionPolicyInput,
  options: RetentionPolicyOptions = {}
): RetentionPolicyResult {
  const parsed = RetentionPolicyInputSchema.parse(input);
  const evaluatedAt = normalizeNow(options.now);
  const reasons: RetentionReason[] = [];
  const manual = manualRetentionSignals(parsed.facets);
  const privacy = privacySignals(parsed);
  const factors = scoreFactors(parsed, evaluatedAt, privacy);

  addFactorReasons(reasons, parsed, evaluatedAt, factors, privacy);
  addManualReasons(reasons, manual);

  let lifecycleScore = weightedScore(factors);
  if (manual.keep) lifecycleScore = Math.max(lifecycleScore, 0.95);
  if (manual.discard) lifecycleScore = Math.min(lifecycleScore, 0.05);
  if (privacy.activeQuarantine) lifecycleScore = Math.min(lifecycleScore, 0.1);

  const decision = decide(lifecycleScore, manual, privacy);

  return {
    targetId: parsed.targetId,
    targetType: parsed.targetType,
    projectHash: parsed.projectHash,
    policyVersion: RETENTION_POLICY_VERSION,
    dryRun: true,
    decision,
    lifecycleScore: round(lifecycleScore),
    factors,
    reasons,
    dryRunDiff: dryRunDiff(decision, privacy),
    evaluatedAt
  };
}

function normalizeNow(value: Date | string | number | undefined): Date {
  if (value === undefined) return new Date();
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('Invalid retention policy now value');
  return parsed;
}

function scoreFactors(
  input: ParsedRetentionPolicyInput,
  now: Date,
  privacy: ReturnType<typeof privacySignals>
): RetentionScoreFactors {
  return {
    level: LEVEL_SCORE[input.memoryLevel],
    recency: recencyScore(input, now),
    retrieval: retrievalScore(input.retrievalCount),
    helpfulness: helpfulnessScore(input.helpfulnessScore, input.adherenceScore),
    evidence: input.evidenceConfidence ?? 0.5,
    eventType: eventTypeScore(input.eventType),
    privacy: privacy.activeQuarantine ? 0 : privacy.privateSignal ? 0.35 : 1,
    manual: 0
  };
}

function weightedScore(factors: RetentionScoreFactors): number {
  return round(Object.entries(factors).reduce((score, [key, value]) => {
    const weight = WEIGHTS[key as keyof RetentionScoreFactors];
    return score + value * weight;
  }, 0));
}

function decide(
  score: number,
  manual: ReturnType<typeof manualRetentionSignals>,
  privacy: ReturnType<typeof privacySignals>
): RetentionDecision {
  if (privacy.activeQuarantine) return 'quarantine';
  if (manual.discard) return 'tombstone_candidate';
  if (manual.review) return 'review';
  if (manual.keep) return 'keep';

  if (privacy.privateSignal && score < 0.45) return 'review';
  if (score >= 0.68) return 'keep';
  if (score >= 0.45) return 'review';
  if (score >= 0.25) return 'downgrade';
  return 'tombstone_candidate';
}

function dryRunDiff(decision: RetentionDecision, privacy: ReturnType<typeof privacySignals>): RetentionDryRunDiff {
  if (decision === 'keep') return { wouldChange: false, action: 'none' };
  if (decision === 'quarantine' && privacy.activeQuarantine) {
    return { wouldChange: false, action: 'already_quarantined' };
  }

  const actionByDecision: Record<Exclude<RetentionDecision, 'keep'>, RetentionDryRunAction> = {
    review: 'mark_review_required',
    downgrade: 'mark_downgrade_candidate',
    quarantine: 'mark_quarantine_candidate',
    tombstone_candidate: 'mark_tombstone_candidate'
  };

  return {
    wouldChange: true,
    action: actionByDecision[decision],
    after: {
      retentionDecision: decision,
      policyVersion: RETENTION_POLICY_VERSION
    }
  };
}

function recencyScore(input: ParsedRetentionPolicyInput, now: Date): number {
  const reference = input.lastAccessedAt ?? input.createdAt;
  const days = ageDays(reference, now);
  if (days <= 7) return 0.95;
  if (days <= 30) return 0.8;
  if (days <= 90) return 0.6;
  if (days <= 180) return 0.4;
  if (days <= 365) return 0.25;
  return 0.05;
}

function retrievalScore(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 0.25;
  if (count <= 4) return 0.45;
  if (count <= 9) return 0.65;
  if (count <= 19) return 0.8;
  return 0.95;
}

function helpfulnessScore(helpfulness: number | undefined, adherence: number | undefined): number {
  const values = [helpfulness, adherence].filter((value): value is number => typeof value === 'number');
  if (values.length === 0) return 0.5;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function eventTypeScore(eventType: string | undefined): number {
  switch (eventType) {
    case 'session_summary':
      return 0.8;
    case 'agent_response':
      return 0.65;
    case 'user_prompt':
      return 0.55;
    case 'tool_observation':
      return 0.25;
    default:
      return 0.45;
  }
}

function manualRetentionSignals(facets: RetentionFacet[]): {
  keep: boolean;
  review: boolean;
  discard: boolean;
} {
  return {
    keep: hasFacet(facets, 'retention', 'keep'),
    review: hasFacet(facets, 'retention', 'review'),
    discard: hasFacet(facets, 'retention', 'discard')
  };
}

function privacySignals(input: ParsedRetentionPolicyInput): {
  activeQuarantine: boolean;
  privateSignal: boolean;
} {
  const quarantine = recordValue(input.metadata, 'quarantine');
  const activeQuarantine = typeof quarantine === 'object'
    && quarantine !== null
    && !Array.isArray(quarantine)
    && (quarantine as Record<string, unknown>).status === 'active';

  const privateMetadata = input.metadata.private === true
    || input.metadata.isPrivate === true
    || input.metadata.visibility === 'private'
    || input.metadata.privacy === 'private';
  const privateFacet = hasFacet(input.facets, 'privacy', 'private');

  return {
    activeQuarantine,
    privateSignal: privateMetadata || privateFacet
  };
}

function addFactorReasons(
  reasons: RetentionReason[],
  input: ParsedRetentionPolicyInput,
  now: Date,
  factors: RetentionScoreFactors,
  privacy: ReturnType<typeof privacySignals>
): void {
  pushReason(reasons, 'memory_level', `Memory level ${input.memoryLevel} contributes ${formatFactor(factors.level)}.`, factors.level * WEIGHTS.level);

  const days = ageDays(input.lastAccessedAt ?? input.createdAt, now);
  pushReason(
    reasons,
    factors.recency <= 0.25 ? 'stale_created_at' : 'recency',
    `Recency signal uses ${Math.max(0, Math.floor(days))} days since last access or creation.`,
    factors.recency * WEIGHTS.recency
  );

  pushReason(
    reasons,
    input.retrievalCount <= 1 ? 'low_retrieval_count' : 'retrieval_count',
    `Retrieval count is ${input.retrievalCount}.`,
    factors.retrieval * WEIGHTS.retrieval
  );

  pushReason(
    reasons,
    factors.helpfulness < 0.5 ? 'low_helpfulness' : 'helpfulness',
    `Helpfulness/adherence signal is ${formatFactor(factors.helpfulness)}.`,
    factors.helpfulness * WEIGHTS.helpfulness
  );

  pushReason(
    reasons,
    factors.evidence < 0.5 ? 'low_evidence_confidence' : 'evidence_confidence',
    `Evidence confidence is ${formatFactor(factors.evidence)}.`,
    factors.evidence * WEIGHTS.evidence
  );

  pushReason(reasons, 'event_type', `Event type is ${input.eventType ?? 'unknown'}.`, factors.eventType * WEIGHTS.eventType);

  if (hasFacet(input.facets, 'quality', 'verified')) {
    pushReason(reasons, 'quality_verified', 'Verified quality facet supports retaining the memory.', 0.03);
  }

  if (privacy.privateSignal) {
    pushReason(reasons, 'private_metadata', 'Private metadata keeps lifecycle handling in review/quarantine-safe mode.', factors.privacy * WEIGHTS.privacy);
  }
  if (hasFacet(input.facets, 'privacy', 'private')) {
    pushReason(reasons, 'privacy_private_facet', 'Privacy facet marks this item as private.', 0);
  }
  if (privacy.activeQuarantine) {
    pushReason(reasons, 'active_quarantine', 'Active quarantine metadata takes precedence over retention scoring.', -1);
  }
}

function addManualReasons(reasons: RetentionReason[], manual: ReturnType<typeof manualRetentionSignals>): void {
  if (manual.keep) {
    pushReason(reasons, 'manual_retention_keep', 'Manual retention:keep facet requests preservation unless quarantine applies.', 1);
  }
  if (manual.review) {
    pushReason(reasons, 'manual_retention_review', 'Manual retention:review facet requests human lifecycle review.', 0);
  }
  if (manual.discard) {
    pushReason(reasons, 'manual_retention_discard', 'Manual retention:discard facet requests non-destructive tombstone candidacy.', -1);
  }
}

function hasFacet(facets: RetentionFacet[], dimension: string, value: string): boolean {
  return facets.some((facet) => facet.dimension === dimension && facet.value === value && facet.confidence > 0);
}

function recordValue(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function ageDays(date: Date, now: Date): number {
  return Math.max(0, (now.getTime() - date.getTime()) / DAY_MS);
}

function pushReason(reasons: RetentionReason[], code: string, message: string, contribution: number): void {
  reasons.push({ code, message, contribution: round(contribution) });
}

function formatFactor(value: number): string {
  return round(value).toFixed(2);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
