import type { MemoryKind } from './memory-ref.js';

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
  // An empty selection with no diagnostics is not a failure. `runtime_error` is
  // reserved for a caught exception; anything else uncategorised is `unknown`.
  'unknown',
  // Rows written before the schema carried an honest default. Readers surface
  // this instead of re-classifying old data (specs R2).
  'legacy_unclassified',
  'runtime_error'
] as const;

export type RetrievalOutcomeReason = typeof RETRIEVAL_OUTCOME_REASONS[number];

export type UsefulnessAdoption = 'grounded' | 'navigated' | 'not_observed' | 'unknown';
export type UsefulnessTaskOutcome = 'success' | 'failure' | 'mixed' | 'unknown';
export type UsefulnessReaskOutcome = 'clarification' | 'repeat_failure' | 'topic_continuation' | 'none' | 'unknown';
export type UsefulnessExplicitFeedback = 'positive' | 'negative' | null;

/**
 * Evaluator identity for the delivery-evidence generation. v2 rows assumed
 * delivery; they are kept but never averaged together with v3 (specs R3).
 */
export const CURRENT_USEFULNESS_EVALUATOR_VERSION = 'v3';
export const LEGACY_ASSUMED_DELIVERY_EVALUATOR_VERSIONS = ['v2'] as const;

export interface MemoryUsefulnessObservationV2 {
  traceId: string;
  /** Retained field name for schema compatibility; may hold any memory kind. */
  eventId: string;
  /** Typed kind of `eventId`. Defaults to `event` only for legacy rows. */
  memoryKind?: MemoryKind;
  /** Owning project of the memory; part of its scope-aware identity (specs R1). */
  memoryProjectId?: string | null;
  observationKind: 'outcome';
  presentationMode: RetrievalPresentationMode;
  triggerType: RetrievalTriggerType;
  selected: boolean;
  delivered: boolean | null;
  deliveryStatus?: DeliveryStatus;
  deliveryEvidence?: DeliveryEvidenceSource;
  adoption: UsefulnessAdoption;
  contentOverlapScore: number | null;
  taskOutcome: UsefulnessTaskOutcome;
  reaskOutcome: UsefulnessReaskOutcome;
  explicitFeedback: UsefulnessExplicitFeedback;
  confidence: number;
  evaluatedAt: string | null;
  evaluatorVersion: string;
  /** Observation window applied after delivery, in ms. */
  evaluationWindowMs?: number;
  /** End of the window this evaluation could actually see. */
  evaluationCutoff?: string | null;
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
  /** Observed delivery evidence levels. `unknown` is never folded into 0. */
  deliveryStatusCounts: Record<DeliveryStatus, number>;
  /** Rows from an evaluator generation that assumed delivery (v2). */
  legacyAssumedDeliveryRows: number;
  /**
   * How the `delivered` values in this aggregate were obtained. A legacy
   * evaluator's rows are labelled `legacy_assumed` rather than presented as
   * observed delivery (specs R3).
   */
  deliveryEvidenceBasis: 'observed' | 'legacy_assumed';
  /** Selected memories by typed kind (specs R1). */
  selectedByKind: Record<MemoryKind, number>;
  /**
   * The population `evidenceGrounding` is measured over. The spec's headline
   * comparison is prompt-triggered evidence only; session_start, explicit
   * search and context-pack rows are reported separately, never averaged in.
   */
  evidenceGroundingScope: 'evidence/user_prompt';
  /** Same counts over every trigger, for transparency about what was excluded. */
  evidenceAllTriggers: { evaluated: number; grounded: number; unknown: number };
  /** Bounded observation window used by this evaluator, in ms. */
  evaluationWindowMs: number;
  /**
   * Every adoption/task signal below is a heuristic, not a confirmed outcome.
   * Surfaced in JSON and UI so a reader never reads them as measured causality.
   */
  heuristics: {
    grounding: 'text_overlap';
    groundingThreshold: number;
    taskOutcome: 'post_delivery_tool_success';
    note: string;
  };
}

export const USEFULNESS_HEURISTIC_NOTE =
  'Grounding is text overlap between the delivered excerpt and later responses; '
  + 'task outcome is post-delivery tool success. Both are heuristics, not verified causal effects.';

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
  evaluationWindowMs?: number;
  groundingThreshold?: number;
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
    evaluatorVersion: options.evaluatorVersion ?? CURRENT_USEFULNESS_EVALUATOR_VERSION,
    excludesSessionStart: options.includeSessionStart !== true,
    window: {
      since: options.since?.toISOString() ?? null,
      until: options.until?.toISOString() ?? null
    },
    deliveryStatusCounts: { unknown: 0, formatted: 0, emitted: 0, acknowledged: 0, failed: 0 },
    legacyAssumedDeliveryRows: 0,
    deliveryEvidenceBasis: LEGACY_ASSUMED_DELIVERY_EVALUATOR_VERSIONS.includes(
      (options.evaluatorVersion ?? CURRENT_USEFULNESS_EVALUATOR_VERSION) as typeof LEGACY_ASSUMED_DELIVERY_EVALUATOR_VERSIONS[number]
    )
      ? 'legacy_assumed'
      : 'observed',
    selectedByKind: { event: 0, lesson: 0, rule: 0, core: 0, unknown: 0 },
    evidenceGroundingScope: 'evidence/user_prompt',
    evidenceAllTriggers: { evaluated: 0, grounded: 0, unknown: 0 },
    evaluationWindowMs: options.evaluationWindowMs ?? 0,
    heuristics: {
      grounding: 'text_overlap',
      groundingThreshold: options.groundingThreshold ?? 0.3,
      taskOutcome: 'post_delivery_tool_success',
      note: USEFULNESS_HEURISTIC_NOTE
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
    : 'unknown';
}

export function normalizeRetrievalOutcomeDiagnostics(
  value: unknown,
  fallbackReason: RetrievalOutcomeReason = 'unknown'
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

/**
 * Bumped whenever the trace ledger gains a field a reader must know about.
 * Version 2 is the first schema with typed trace items, honest unknown outcome
 * reasons and request metadata (specs/recent-memory-patterns-2026-09-06 R1-R2).
 */
export const RETRIEVAL_TELEMETRY_SCHEMA_VERSION = 2;

/**
 * Rows without a schema version predate the honest-default migration. Their
 * stored `runtime_error` was a fallback, not an observed exception, so readers
 * present them as legacy instead of re-classifying the stored value.
 */
export function presentedOutcomeReason(
  storedReason: unknown,
  telemetrySchemaVersion: unknown
): RetrievalOutcomeReason {
  const version = Number(telemetrySchemaVersion);
  const reason = normalizeRetrievalOutcomeReason(storedReason);
  if (Number.isFinite(version) && version >= 2) return reason;
  return reason === 'runtime_error' ? 'legacy_unclassified' : reason;
}

/**
 * How far a selected memory actually got. Selection alone is not delivery:
 * `formatted` means the text was built, `emitted` means the hook wrote it to
 * stdout successfully, `acknowledged` requires evidence the consumer read it.
 */
export const DELIVERY_STATUSES = ['unknown', 'formatted', 'emitted', 'acknowledged', 'failed'] as const;
export type DeliveryStatus = typeof DELIVERY_STATUSES[number];

/** Where the delivery status came from. `legacy_assumed` is never a new write. */
export const DELIVERY_EVIDENCE_SOURCES = [
  'none',
  'context_formatted',
  'hook_stdout',
  'mcp_tool_result',
  'consumer_ack',
  'write_error',
  'legacy_assumed'
] as const;
export type DeliveryEvidenceSource = typeof DELIVERY_EVIDENCE_SOURCES[number];

const DELIVERY_STATUS_SET = new Set<string>(DELIVERY_STATUSES);
const DELIVERY_EVIDENCE_SET = new Set<string>(DELIVERY_EVIDENCE_SOURCES);

export function normalizeDeliveryStatus(value: unknown): DeliveryStatus {
  return typeof value === 'string' && DELIVERY_STATUS_SET.has(value)
    ? value as DeliveryStatus
    : 'unknown';
}

export function normalizeDeliveryEvidence(value: unknown): DeliveryEvidenceSource {
  return typeof value === 'string' && DELIVERY_EVIDENCE_SET.has(value)
    ? value as DeliveryEvidenceSource
    : 'none';
}

/**
 * `delivered` stays null until evidence exists. Only an emitted/acknowledged
 * delivery is true and only an observed write failure is false — a formatted
 * but never-flushed context is unknown, not delivered.
 */
export function deliveredFromStatus(status: DeliveryStatus): boolean | null {
  if (status === 'emitted' || status === 'acknowledged') return true;
  if (status === 'failed') return false;
  return null;
}

export interface RetrievalTelemetryContext {
  presentationMode?: RetrievalPresentationMode;
  triggerType?: RetrievalTriggerType;
  deliveryClient?: string;
  /** Stable id for the caller-visible request that produced this retrieval. */
  requestId?: string;
  /** Set only by offline/benchmark evaluation runs so they can be excluded. */
  evaluationRunId?: string;
  runtimeVersion?: string;
}

/** One typed reference inside a trace: a candidate, a selection, or both. */
export interface RetrievalTraceItemInput {
  kind: MemoryKind;
  id: string;
  projectId?: string | null;
  rank?: number;
  selected?: boolean;
  score?: number | null;
  /** Hash of the delivered excerpt. Never the excerpt itself. */
  contentHash?: string | null;
  memoryVersion?: string | null;
  deleted?: boolean;
}

export interface RetrievalTraceItem {
  traceId: string;
  itemKey: string;
  memoryKind: MemoryKind;
  memoryId: string;
  projectId: string | null;
  rank: number | null;
  selected: boolean;
  score: number | null;
  contentHash: string | null;
  memoryVersion: string | null;
  deleted: boolean;
}

/** Typed selection totals for a fixed sample, with unresolved refs kept apart. */
export interface TypedSelectionSummary {
  byKind: Record<MemoryKind, number>;
  total: number;
  unresolved: number;
  ambiguous: number;
  /** Traces whose items were reconstructed by the read-only legacy resolver. */
  legacyResolvedTraces: number;
  typedTraces: number;
}

export function emptyTypedSelectionSummary(): TypedSelectionSummary {
  return {
    byKind: { event: 0, lesson: 0, rule: 0, core: 0, unknown: 0 },
    total: 0,
    unresolved: 0,
    ambiguous: 0,
    legacyResolvedTraces: 0,
    typedTraces: 0
  };
}

/**
 * Per-client instrumentation coverage. A client whose requests we never see
 * cannot be reported as 0% coverage — that would claim an observation we do not
 * have — so `coverage` stays null with an explicit `unknown` state.
 */
export interface RetrievalClientCoverage {
  client: string;
  observedRequests: number;
  instrumentedRequests: number;
  unobservedOrUnknown: number;
  coverage: number | null;
  coverageState: 'measured' | 'unknown';
}

export function normalizeRequestId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, 128);
  return /^[A-Za-z0-9_.:@-]{1,128}$/.test(trimmed) ? trimmed : null;
}

export interface RecordReferenceNavigationInput {
  targetEventId: string;
  /** Typed kind of the opened memory. Defaults to `event` for legacy callers. */
  targetKind?: MemoryKind;
  targetProjectId?: string | null;
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
