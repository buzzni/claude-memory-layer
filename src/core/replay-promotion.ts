import { createHash } from 'node:crypto';

export type RetrievalReviewReason =
  | 'rewritten-query-no-selection'
  | 'candidate-no-selection'
  | 'empty-candidate-set'
  | 'low-selection-rate';

export type ReplayPromotionExpectation = 'match';

export interface RetrievalReviewQueueSummary {
  totalTraces?: number;
  reviewItems?: number;
  returnedItems?: number;
  candidateNoSelection?: number;
  emptyCandidateSet?: number;
  rewrittenNoSelection?: number;
  lowSelectionRate?: number;
  [key: string]: unknown;
}

export interface RetrievalReviewQueueDetail {
  eventId?: string;
  score?: number;
  semanticScore?: number;
  lexicalScore?: number;
  recencyScore?: number;
  [key: string]: unknown;
}

export interface RetrievalReviewQueueItem {
  traceId?: string;
  reason?: string;
  severity?: string;
  priority?: number;
  queryRewriteKind?: string;
  rewritten?: boolean;
  strategy?: string;
  candidateCount?: number;
  selectedCount?: number;
  candidateEventIds?: string[];
  selectedEventIds?: string[];
  candidateDetails?: RetrievalReviewQueueDetail[];
  selectedDetails?: RetrievalReviewQueueDetail[];
  createdAt?: string;
  [key: string]: unknown;
}

export interface RetrievalReviewQueueExport {
  summary?: RetrievalReviewQueueSummary;
  items?: RetrievalReviewQueueItem[];
  [key: string]: unknown;
}

export interface ReplayPromotionPlanOptions {
  generatedAt?: string;
  maxItems?: number;
}

export interface ReplayPromotionQuerySkeleton {
  queryId: string;
  category: string;
  query: string;
  expectation: ReplayPromotionExpectation;
  expectedIds: string[];
  expectedRelevance: Record<string, number>;
  forbiddenIds: string[];
}

export interface ReplayPromotionCandidate {
  candidateId: string;
  sourceTraceId: string;
  reviewReason: RetrievalReviewReason;
  category: string;
  priority: number;
  suggestedExpectation: ReplayPromotionExpectation;
  queryRewriteKind: string;
  rewritten: boolean;
  strategy: string | null;
  candidateCount: number;
  selectedCount: number;
  candidateEventIds: string[];
  selectedEventIds: string[];
  candidateDetails: RetrievalReviewQueueDetail[];
  selectedDetails: RetrievalReviewQueueDetail[];
  createdAt: string | null;
  replayQuerySkeleton: ReplayPromotionQuerySkeleton;
  manualLabelingChecklist: string[];
}

export interface ReplayPromotionPlan {
  name: 'retrieval-review-golden-promotion-candidates';
  description: string;
  generatedAt: string;
  metadata: {
    rawContentIncluded: false;
    requiresHumanLabeling: true;
    source: 'retrieval-review-queue';
  };
  sourceSummary: {
    totalTraces: number;
    reviewItems: number;
    returnedItems: number;
    candidateNoSelection: number;
    emptyCandidateSet: number;
    rewrittenNoSelection: number;
    lowSelectionRate: number;
  };
  summary: {
    sourceReviewItems: number;
    promotedCandidates: number;
    requiresHumanLabeling: number;
  };
  candidates: ReplayPromotionCandidate[];
}

const PLACEHOLDER_EXPECTED_ID = 'TODO_EXPECTED_MEMORY_ID';

const REASON_PRIORITY: Record<RetrievalReviewReason, number> = {
  'rewritten-query-no-selection': 100,
  'candidate-no-selection': 90,
  'empty-candidate-set': 70,
  'low-selection-rate': 60
};

export function buildReplayPromotionPlan(
  reviewQueue: RetrievalReviewQueueExport,
  options: ReplayPromotionPlanOptions = {}
): ReplayPromotionPlan {
  const items = Array.isArray(reviewQueue.items) ? reviewQueue.items : [];
  const generatedAt = options.generatedAt === undefined
    ? new Date().toISOString()
    : validateCanonicalUtcIsoTimestamp(options.generatedAt, 'generatedAt');
  const maxItems = Number.isFinite(options.maxItems) && options.maxItems !== undefined
    ? Math.max(0, Math.floor(options.maxItems))
    : items.length;
  const candidates = makeCandidateIdsUnique(items
    .map((item) => buildPromotionCandidate(item))
    .sort((a, b) => b.priority - a.priority || compareCreatedAt(b.createdAt, a.createdAt)))
    .slice(0, maxItems);
  const sourceSummary = sanitizeSourceSummary(reviewQueue.summary, items.length);

  return {
    name: 'retrieval-review-golden-promotion-candidates',
    description: 'Privacy-safe candidate plan for manually promoting bad retrieval review queue items into the golden replay fixture.',
    generatedAt,
    metadata: {
      rawContentIncluded: false,
      requiresHumanLabeling: true,
      source: 'retrieval-review-queue'
    },
    sourceSummary,
    summary: {
      sourceReviewItems: sourceSummary.reviewItems,
      promotedCandidates: candidates.length,
      requiresHumanLabeling: candidates.length
    },
    candidates
  };
}

export function formatReplayPromotionMarkdown(plan: ReplayPromotionPlan): string {
  const lines: string[] = [];
  lines.push('# Retrieval Review Golden Promotion Candidates');
  lines.push('');
  lines.push(`- Generated at: ${plan.generatedAt}`);
  lines.push(`- Source review items: ${plan.summary.sourceReviewItems}`);
  lines.push(`- Promotion candidates: ${plan.summary.promotedCandidates}`);
  lines.push(`- Requires human labeling: ${plan.summary.requiresHumanLabeling}`);
  lines.push('');
  lines.push('## Candidates');
  lines.push('');

  if (plan.candidates.length === 0) {
    lines.push('No review queue items were available for promotion.');
  } else {
    lines.push('| candidateId | queryId | reason | category | candidates | selected | rewrite |');
    lines.push('|---|---|---|---|---:|---:|---|');
    for (const candidate of plan.candidates) {
      lines.push(
        `| ${escapeMarkdownCell(candidate.candidateId)} | ${escapeMarkdownCell(candidate.replayQuerySkeleton.queryId)} | ${escapeMarkdownCell(candidate.reviewReason)} | ${escapeMarkdownCell(candidate.category)} | ${candidate.candidateCount} | ${candidate.selectedCount} | ${escapeMarkdownCell(candidate.queryRewriteKind)} |`
      );
    }
  }

  lines.push('');
  lines.push('## Manual labeling checklist');
  lines.push('');
  lines.push('1. Fill `query` with a privacy-safe synthetic prompt that represents the reviewed failure.');
  lines.push('2. Replace `TODO_EXPECTED_MEMORY_ID` with the expected memory ID after manual review.');
  lines.push('3. Add or reference a privacy-safe synthetic memory fixture for that expected ID.');
  lines.push('4. Copy the labeled case into `benchmarks/replay/golden-memory-usefulness-v1.json`.');
  lines.push('5. Run `npm run eval:retrieval-replay` after promotion.');
  lines.push('');
  lines.push('## Query skeletons');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(plan.candidates.map((candidate) => candidate.replayQuerySkeleton), null, 2));
  lines.push('```');
  lines.push('');
  lines.push('> Report intentionally omits raw query and memory text.');
  lines.push('');
  return lines.join('\n');
}

function buildPromotionCandidate(item: RetrievalReviewQueueItem): ReplayPromotionCandidate {
  const sourceTraceId = safeIdentifier(item.traceId, 'trace');
  const reason = normalizeReason(item.reason);
  const category = `review-${reason}`;
  const priority = safeInteger(item.priority, REASON_PRIORITY[reason]);
  const queryId = `q-review-${sourceTraceId}`;
  const queryRewriteKind = normalizeQueryRewriteKind(item.queryRewriteKind);

  return {
    candidateId: `promo-${sourceTraceId}`,
    sourceTraceId,
    reviewReason: reason,
    category,
    priority,
    suggestedExpectation: 'match',
    queryRewriteKind,
    rewritten: queryRewriteKind !== 'none',
    strategy: safeOptionalIdentifier(item.strategy),
    candidateCount: safeInteger(item.candidateCount, 0),
    selectedCount: safeInteger(item.selectedCount, 0),
    candidateEventIds: sanitizeIdentifierList(item.candidateEventIds, 'event'),
    selectedEventIds: sanitizeIdentifierList(item.selectedEventIds, 'event'),
    candidateDetails: sanitizeDetails(item.candidateDetails),
    selectedDetails: sanitizeDetails(item.selectedDetails),
    createdAt: safeTimestamp(item.createdAt),
    replayQuerySkeleton: {
      queryId,
      category,
      query: `TODO_REDACTED_SYNTHETIC_QUERY_${sourceTraceId}`,
      expectation: 'match',
      expectedIds: [PLACEHOLDER_EXPECTED_ID],
      expectedRelevance: { [PLACEHOLDER_EXPECTED_ID]: 2 },
      forbiddenIds: []
    },
    manualLabelingChecklist: [
      'Replace the synthetic query placeholder with a privacy-safe prompt.',
      'Choose expected IDs only after manual review of local private data.',
      'Use synthetic memory content before adding this case to the committed golden fixture.',
      'Run the gated replay command after promotion.'
    ]
  };
}

function makeCandidateIdsUnique(candidates: ReplayPromotionCandidate[]): ReplayPromotionCandidate[] {
  const seen = new Map<string, number>();
  return candidates.map((candidate) => {
    const count = (seen.get(candidate.sourceTraceId) ?? 0) + 1;
    seen.set(candidate.sourceTraceId, count);
    if (count === 1) return candidate;
    const suffix = `-${count}`;
    return {
      ...candidate,
      candidateId: `promo-${candidate.sourceTraceId}${suffix}`,
      replayQuerySkeleton: {
        ...candidate.replayQuerySkeleton,
        queryId: `q-review-${candidate.sourceTraceId}${suffix}`,
        query: `TODO_REDACTED_SYNTHETIC_QUERY_${candidate.sourceTraceId}${suffix}`
      }
    };
  });
}

function sanitizeSourceSummary(summary: RetrievalReviewQueueSummary | undefined, fallbackItems: number) {
  return {
    totalTraces: safeInteger(summary?.totalTraces, fallbackItems),
    reviewItems: safeInteger(summary?.reviewItems, fallbackItems),
    returnedItems: safeInteger(summary?.returnedItems, fallbackItems),
    candidateNoSelection: safeInteger(summary?.candidateNoSelection, 0),
    emptyCandidateSet: safeInteger(summary?.emptyCandidateSet, 0),
    rewrittenNoSelection: safeInteger(summary?.rewrittenNoSelection, 0),
    lowSelectionRate: safeInteger(summary?.lowSelectionRate, 0)
  };
}

function sanitizeIdentifierList(values: string[] | undefined, prefix: string): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of values) {
    const id = safeIdentifier(value, prefix);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.slice(0, 10);
}

function sanitizeDetails(details: RetrievalReviewQueueDetail[] | undefined): RetrievalReviewQueueDetail[] {
  if (!Array.isArray(details)) return [];
  return details.slice(0, 5).map((detail) => {
    const sanitized: RetrievalReviewQueueDetail = {
      eventId: safeIdentifier(detail.eventId, 'event'),
      score: safeScore(detail.score)
    };
    if (detail.semanticScore !== undefined) sanitized.semanticScore = safeScore(detail.semanticScore);
    if (detail.lexicalScore !== undefined) sanitized.lexicalScore = safeScore(detail.lexicalScore);
    if (detail.recencyScore !== undefined) sanitized.recencyScore = safeScore(detail.recencyScore);
    return sanitized;
  });
}

function safeIdentifier(value: unknown, prefix: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (isKnownSafeIdentifier(raw, prefix)) return raw;
  const digest = createHash('sha256').update(raw || prefix).digest('hex').slice(0, 12);
  return `${prefix}-${digest}`;
}

function isKnownSafeIdentifier(value: string, prefix: string): boolean {
  if (!value || isCredentialLikeIdentifier(value)) return false;
  if (prefix === 'trace') return /^trace-[A-Za-z0-9][A-Za-z0-9_.:-]{0,120}$/.test(value);
  if (prefix === 'event') return /^(?:candidate|selected|event|m|q|e)-[A-Za-z0-9][A-Za-z0-9_.:-]{0,120}$/.test(value);
  if (prefix === 'value') return /^(?:auto|fast|deep|hybrid|none)$/.test(value);
  return false;
}

function isCredentialLikeIdentifier(value: string): boolean {
  return /(?:gh[pousr]_|github_pat_|glpat-|xox[a-z]-|AKIA[A-Z0-9]|ASIA[A-Z0-9]|AIza|ya29\.|(?:^|[-_.:])sk-[A-Za-z0-9_-]+)/i.test(value) ||
    /(?:api[_-]?key|secret|password|passwd|token|credential)/i.test(value);
}

function safeOptionalIdentifier(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  return safeIdentifier(value, 'value');
}

function normalizeReason(reason: unknown): RetrievalReviewReason {
  if (
    reason === 'rewritten-query-no-selection' ||
    reason === 'candidate-no-selection' ||
    reason === 'empty-candidate-set' ||
    reason === 'low-selection-rate'
  ) {
    return reason;
  }
  return 'candidate-no-selection';
}

function normalizeQueryRewriteKind(kind: unknown): string {
  if (kind === 'follow-up-context' || kind === 'intent-rewrite') return kind;
  return 'none';
}

function safeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function safeScore(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(1, parsed));
}

function safeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

function validateCanonicalUtcIsoTimestamp(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`Invalid ${fieldName}: expected a canonical UTC ISO timestamp`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`Invalid ${fieldName}: expected a canonical UTC ISO timestamp`);
  }
  return value;
}

function compareCreatedAt(left: string | null, right: string | null): number {
  const leftMs = left ? new Date(left).getTime() : 0;
  const rightMs = right ? new Date(right).getTime() : 0;
  return leftMs - rightMs;
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
