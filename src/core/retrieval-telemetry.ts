export const RETRIEVAL_PRESENTATION_MODES = ['evidence', 'reference', 'core', 'unknown'] as const;
export type RetrievalPresentationMode = typeof RETRIEVAL_PRESENTATION_MODES[number];

export const RETRIEVAL_TRIGGER_TYPES = [
  'session_start',
  'user_prompt',
  'explicit_search',
  'context_pack',
  'unknown'
] as const;
export type RetrievalTriggerType = typeof RETRIEVAL_TRIGGER_TYPES[number];

export const REFERENCE_NAVIGATION_ACTIONS = ['source_ref', 'details', 'expand', 'source'] as const;
export type ReferenceNavigationAction = typeof REFERENCE_NAVIGATION_ACTIONS[number];

export type ReferenceNavigationOutcome = 'attributed' | 'ambiguous' | 'unattributed';

export const RETRIEVAL_OUTCOME_REASONS = [
  'selected',
  'no_project_events',
  'freshness_gap',
  'scope_filtered',
  'no_keyword_candidates',
  'no_vector_candidates',
  'stale_vector_schema',
  'below_score_threshold',
  'quality_filtered',
  'session_rescue_empty',
  'context_pack_policy_filtered',
  'runtime_error'
] as const;

export type RetrievalOutcomeReason = typeof RETRIEVAL_OUTCOME_REASONS[number];

export type UsefulnessAdoption = 'grounded' | 'navigated' | 'not_observed' | 'unknown';
export type UsefulnessTaskOutcome = 'success' | 'failure' | 'mixed' | 'unknown';
export type UsefulnessReaskOutcome = 'clarification' | 'repeat_failure' | 'topic_continuation' | 'none' | 'unknown';
export type UsefulnessExplicitFeedback = 'positive' | 'negative' | null;

export interface MemoryUsefulnessObservationV2 {
  traceId: string;
  eventId: string;
  observationKind: 'outcome';
  presentationMode: RetrievalPresentationMode;
  triggerType: RetrievalTriggerType;
  selected: boolean;
  delivered: boolean | null;
  adoption: UsefulnessAdoption;
  contentOverlapScore: number | null;
  taskOutcome: UsefulnessTaskOutcome;
  reaskOutcome: UsefulnessReaskOutcome;
  explicitFeedback: UsefulnessExplicitFeedback;
  confidence: number;
  evaluatedAt: string | null;
  evaluatorVersion: string;
}

export interface UsefulnessRateV2 {
  numerator: number;
  denominator: number;
  unknown: number;
  value: number | null;
}

export interface UsefulnessAggregateV2 {
  eligible: number;
  selected: number;
  delivered: number;
  evidenceEvaluated: number;
  evidenceGrounded: number;
  referencesEligible: number;
  referencesNavigated: number;
  taskOutcomesEvaluated: number;
  taskOutcomesSuccessful: number;
  explicitPositive: number;
  explicitNegative: number;
  unknown: number;
  unknownByDimension: {
    delivery: number;
    adoption: number;
    taskOutcome: number;
    reaskOutcome: number;
    explicitFeedback: number;
  };
  rates: {
    selectionYield: UsefulnessRateV2;
    deliveryRate: UsefulnessRateV2;
    evidenceGrounding: UsefulnessRateV2;
    referenceNavigation: UsefulnessRateV2;
    taskSuccess: UsefulnessRateV2;
    explicitPositive: UsefulnessRateV2;
  };
  sampleState: 'sufficient' | 'insufficient_sample';
  minimumSample: number;
  evaluatorVersion: string;
  excludesSessionStart: boolean;
  window: { since: string | null; until: string | null };
}

export function normalizeUsefulnessMinimumSample(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 20;
  return Math.min(10_000, Math.max(1, Math.floor(value)));
}

export function emptyUsefulnessAggregateV2(options: {
  minimumSample?: number;
  evaluatorVersion?: string;
  includeSessionStart?: boolean;
  since?: Date;
  until?: Date;
} = {}): UsefulnessAggregateV2 {
  const rate = (): UsefulnessRateV2 => ({ numerator: 0, denominator: 0, unknown: 0, value: null });
  return {
    eligible: 0,
    selected: 0,
    delivered: 0,
    evidenceEvaluated: 0,
    evidenceGrounded: 0,
    referencesEligible: 0,
    referencesNavigated: 0,
    taskOutcomesEvaluated: 0,
    taskOutcomesSuccessful: 0,
    explicitPositive: 0,
    explicitNegative: 0,
    unknown: 0,
    unknownByDimension: { delivery: 0, adoption: 0, taskOutcome: 0, reaskOutcome: 0, explicitFeedback: 0 },
    rates: {
      selectionYield: rate(),
      deliveryRate: rate(),
      evidenceGrounding: rate(),
      referenceNavigation: rate(),
      taskSuccess: rate(),
      explicitPositive: rate()
    },
    sampleState: 'insufficient_sample',
    minimumSample: normalizeUsefulnessMinimumSample(options.minimumSample),
    evaluatorVersion: options.evaluatorVersion ?? 'v2',
    excludesSessionStart: options.includeSessionStart !== true,
    window: {
      since: options.since?.toISOString() ?? null,
      until: options.until?.toISOString() ?? null
    }
  };
}

export interface RetrievalOutcomeDiagnostics {
  outcomeReason: RetrievalOutcomeReason;
  laneCandidateCounts: Record<string, number>;
  filteredCounts: Record<string, number>;
  topScore: number | null;
  threshold: number;
  freshnessState: 'fresh' | 'stale' | 'unknown';
}

const RETRIEVAL_OUTCOME_REASON_SET = new Set<string>(RETRIEVAL_OUTCOME_REASONS);
const DIAGNOSTIC_COUNT_KEYS = new Set([
  'keyword', 'vector', 'summary', 'graph', 'session_rescue', 'shared',
  'scope', 'quality', 'threshold', 'context_pack_policy'
]);

export function normalizeRetrievalOutcomeReason(value: unknown): RetrievalOutcomeReason {
  return typeof value === 'string' && RETRIEVAL_OUTCOME_REASON_SET.has(value)
    ? value as RetrievalOutcomeReason
    : 'runtime_error';
}

export function normalizeRetrievalOutcomeDiagnostics(
  value: unknown,
  fallbackReason: RetrievalOutcomeReason = 'runtime_error'
): RetrievalOutcomeDiagnostics {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    outcomeReason: RETRIEVAL_OUTCOME_REASON_SET.has(String(raw.outcomeReason))
      ? raw.outcomeReason as RetrievalOutcomeReason
      : fallbackReason,
    laneCandidateCounts: normalizeDiagnosticCounts(raw.laneCandidateCounts),
    filteredCounts: normalizeDiagnosticCounts(raw.filteredCounts),
    topScore: typeof raw.topScore === 'number' && Number.isFinite(raw.topScore)
      ? Math.max(0, Math.min(1, raw.topScore))
      : null,
    threshold: typeof raw.threshold === 'number' && Number.isFinite(raw.threshold)
      ? Math.max(0, Math.min(1, raw.threshold))
      : 0,
    freshnessState: raw.freshnessState === 'fresh' || raw.freshnessState === 'stale'
      ? raw.freshnessState
      : 'unknown'
  };
}

function normalizeDiagnosticCounts(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key, count]) => DIAGNOSTIC_COUNT_KEYS.has(key) && Number.isFinite(Number(count)))
    .map(([key, count]) => [key, Math.max(0, Math.min(1_000_000, Math.floor(Number(count))))]));
}

export interface RetrievalTelemetryContext {
  presentationMode?: RetrievalPresentationMode;
  triggerType?: RetrievalTriggerType;
  deliveryClient?: string;
}

export interface RecordReferenceNavigationInput {
  targetEventId: string;
  action: ReferenceNavigationAction;
  navigationClient: string;
  /** Optional current delivery session. When supplied, attribution never crosses its boundary. */
  attributionSessionId?: string;
  openedAt?: Date;
}

export interface RecordReferenceNavigationResult {
  outcome: ReferenceNavigationOutcome;
  traceId: string | null;
  repeated: boolean;
}

export interface RetrievalPresentationBreakdown {
  presentationMode: RetrievalPresentationMode;
  traceCount: number;
  deliveredItemCount: number;
}

export interface RetrievalTriggerBreakdown {
  triggerType: RetrievalTriggerType;
  traceCount: number;
  deliveredItemCount: number;
}

export interface RetrievalTelemetryStats {
  deliveries: {
    totalTraces: number;
    totalItems: number;
    byPresentation: RetrievalPresentationBreakdown[];
    byTrigger: RetrievalTriggerBreakdown[];
    legacyUnknownRows: number;
  };
  evidenceGrounding: {
    evaluatedDeliveries: number;
    groundedDeliveries: number;
    groundingRate: number;
    averageContentOverlap: number;
  };
  referenceNavigation: {
    eligibleTraces: number;
    navigatedTraces: number;
    navigationRate: number;
    attributedOpenCount: number;
    ambiguousOpenCount: number;
    unattributedOpenCount: number;
  };
}

export function normalizeRetrievalPresentationMode(value: unknown): RetrievalPresentationMode {
  return typeof value === 'string' && (RETRIEVAL_PRESENTATION_MODES as readonly string[]).includes(value)
    ? value as RetrievalPresentationMode
    : 'unknown';
}

export function normalizeRetrievalTriggerType(value: unknown): RetrievalTriggerType {
  return typeof value === 'string' && (RETRIEVAL_TRIGGER_TYPES as readonly string[]).includes(value)
    ? value as RetrievalTriggerType
    : 'unknown';
}

export function normalizeTelemetryClient(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 48);
  return normalized || 'unknown';
}
