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

