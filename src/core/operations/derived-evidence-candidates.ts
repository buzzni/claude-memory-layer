/**
 * Shadow evaluation of derived evidence candidates
 * (specs/recent-memory-patterns-2026-09-06 R4).
 *
 * 76.8% of what gets stored is tool output, but only 0.61% of it is an exact
 * duplicate — so the reuse problem is not deduplication, it is that a
 * repeatable decision buried in tool output never becomes something a later
 * session can recall. This module derives small candidates from the evidence
 * the existing `LessonCandidateService` already mined, and attaches the
 * provenance R4 requires: typed source references, the conditions under which
 * the candidate applies, the reasoning, a review condition, a confidence and
 * the generator version.
 *
 * It deliberately does **not** promote anything. Every candidate starts in
 * shadow: `usableForRecall` is false until a reviewer verifies it, so turning
 * the derivation off restores the original retrieval policy exactly. Promotion
 * stays the existing, human-invoked `mem-lesson-save` path.
 */

import { sqliteAll, toDateFromSQLite, type SQLiteDatabase } from '../sqlite-wrapper.js';
import { sanitizeGovernanceAuditValue } from './governance-audit.js';
import type { LessonCandidate } from './lesson-candidate-service.js';
import type { MemoryRef } from '../memory-ref.js';

/** Bumped whenever the derivation's inputs or safeguards change. */
export const DERIVED_EVIDENCE_GENERATOR_VERSION = 'derived-evidence-v1';

/** Default review horizon for a derived candidate, in days. */
export const DERIVED_EVIDENCE_REVIEW_DAYS = 90;

/**
 * Why a candidate must not be promoted to a durable lesson.
 *
 * These are the exclusions R4 names. Each one describes something that looked
 * like a reusable procedure but is not: it depends on one machine's state, it
 * only ever failed, it narrates a single pull request, or it is a copy of a
 * file that already lives in the repository.
 */
export const DERIVED_EVIDENCE_REJECTIONS = [
  'sensitive_material',
  'environment_dependent_failure',
  'missing_credentials',
  'unresolved_failure',
  'one_off_pr_narrative',
  'repository_document_copy',
  'no_source_refs'
] as const;
export type DerivedEvidenceRejection = typeof DERIVED_EVIDENCE_REJECTIONS[number];

export type DerivedEvidencePromotionState = 'shadow_candidate' | 'blocked';

export interface DerivedEvidenceSourceClock {
  /** Earliest original event time across the sources, when the importer kept one. */
  occurredAt: string | null;
  /** Earliest time this store wrote them. */
  ingestedAt: string | null;
  /** Largest observed store-time minus source-time across the sources. */
  maxIngestLagMs: number | null;
  /** Sources whose original time is unknown; their lag cannot be computed. */
  unknownSourceClocks: number;
}

export interface DerivedEvidenceCandidate {
  candidateId: string;
  projectId: string | null;
  name: string;
  trigger: string;
  steps: string[];
  /** Typed references to the events this candidate is derived from (specs R1). */
  sourceRefs: MemoryRef[];
  /** When this candidate applies. Never empty: an unconditional rule is not one. */
  applicability: string[];
  /** Why the derivation believes it. */
  rationale: string[];
  /** When to look at it again, and what would invalidate it. */
  validity: { reviewAfterDays: number; reviewWhen: string[] };
  confidence: number;
  generatorVersion: string;
  sourceClock: DerivedEvidenceSourceClock;
  promotion: {
    state: DerivedEvidencePromotionState;
    /** Empty for a shadow candidate; populated for a blocked one. */
    rejections: DerivedEvidenceRejection[];
    /** Always false here: shadow candidates never enter retrieval. */
    usableForRecall: boolean;
  };
}

export interface DerivedEvidenceShadowReport {
  generatorVersion: string;
  mode: 'shadow';
  evaluated: number;
  shadowCandidates: DerivedEvidenceCandidate[];
  blocked: DerivedEvidenceCandidate[];
  rejectionCounts: Record<DerivedEvidenceRejection, number>;
  /** Source events that could not be read back; their candidates are blocked. */
  unresolvedSourceRefs: number;
  note: string;
}

interface SourceEventRow {
  id: string;
  event_type: string;
  timestamp: string;
  content: string;
  metadata: string | null;
}

interface SourceEvidence {
  refs: MemoryRef[];
  rows: SourceEventRow[];
  text: string;
  clock: DerivedEvidenceSourceClock;
}

/**
 * Environment-dependent installation failures. These read like procedures
 * ("run npm install, it failed with EACCES") but describe one machine's state,
 * so promoting them teaches a later session something that was never true of
 * the project.
 */
const ENVIRONMENT_FAILURE_PATTERN =
  /\b(?:eacces|eperm|enoent|enotempty|network\s+timeout|etimedout|econnrefused|enospc|disk\s+full|permission\s+denied|gyp\s+err|node-gyp|code\s+elifecycle|npm\s+err!\s+code\s+e[a-z]+)\b/i;

const MISSING_CREDENTIAL_PATTERN =
  /\b(?:401\s+unauthorized|403\s+forbidden|invalid[_\s-]?(?:api[_\s-]?key|token|credential)|missing[_\s-]?(?:api[_\s-]?key|token|credential)|authentication\s+failed|not\s+logged\s+in|otp\s+required|requires?\s+auth)\b/i;

/**
 * A single pull-request narrative. Useful history, but not a rule: it names one
 * change rather than a condition that recurs.
 */
const PR_NARRATIVE_PATTERN =
  /(?:\bpull\s+request\b|\bPR\s*#\d+|\bmerged\s+#\d+|\bcherry-pick(?:ed)?\b|\brevert(?:ed)?\s+commit\b)/i;

/**
 * Repository documents that already ship with the code. Copying them into
 * memory adds a second, silently diverging copy of a file the agent can read
 * directly.
 */
const REPOSITORY_DOCUMENT_PATTERN =
  /(?:\bAGENTS\.md\b|\bCLAUDE\.md\b|\bREADME(?:\.md)?\b|\bCONTRIBUTING\.md\b|\bdocs?\/[A-Za-z0-9_-]+\.md\b)/;

/**
 * A secret-looking assignment, including env-style names the audit sanitizer's
 * word boundary misses (`NPM_TOKEN=...`, `MY_API_KEY: ...`). The value itself is
 * never captured or stored — only the fact that one is present.
 */
const SECRET_ASSIGNMENT_PATTERN =
  /[A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|credential)[A-Za-z0-9_-]*\s*[:=]\s*\S+/i;

const SUCCESS_PATTERN = /\b(?:passed|passing|succeeded|success|ok\b|0\s+errors?|all\s+tests?\s+pass)\b/i;
const FAILURE_PATTERN = /\b(?:failed|failure|error|blocked)\b|\bexit[_ -]?code\s*[:=]?\s*[1-9]\d*\b/i;
const RETRY_PATTERN = /\b(?:retry|retried|retrying|re-?run|second\s+attempt|다시\s*시도|재시도)\b/i;

/** Redacted, bounded text used for classification. Never stored. */
function classifiableText(rows: SourceEventRow[]): string {
  return rows
    .map((row) => String(sanitizeGovernanceAuditValue(row.content ?? '')))
    .join('\n')
    .slice(0, 40_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMetadata(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `timestamp` is when this store wrote the row; some importers also keep the
 * original conversation time. R4 asks for the two to stay distinguishable, so
 * they are reported separately together with the observed lag — and a source
 * whose original time is unknown is counted, not assumed to be lag-free.
 */
export function readSourceClock(rows: SourceEventRow[]): DerivedEvidenceSourceClock {
  let occurredAt: number | null = null;
  let ingestedAt: number | null = null;
  let maxLagMs: number | null = null;
  let unknown = 0;

  for (const row of rows) {
    const storedMs = toDateFromSQLite(row.timestamp).getTime();
    if (Number.isFinite(storedMs)) {
      ingestedAt = ingestedAt === null ? storedMs : Math.min(ingestedAt, storedMs);
    }
    const metadata = parseMetadata(row.metadata);
    const original = metadata?.originalTimestamp
      ?? (isRecord(metadata?.ingest) ? (metadata.ingest as Record<string, unknown>).occurredAt : undefined);
    const originalMs = typeof original === 'string' ? toDateFromSQLite(original).getTime() : NaN;
    if (!Number.isFinite(originalMs)) {
      unknown += 1;
      continue;
    }
    occurredAt = occurredAt === null ? originalMs : Math.min(occurredAt, originalMs);
    if (Number.isFinite(storedMs)) {
      const lag = storedMs - originalMs;
      if (lag >= 0) maxLagMs = maxLagMs === null ? lag : Math.max(maxLagMs, lag);
    }
  }

  return {
    occurredAt: occurredAt === null ? null : new Date(occurredAt).toISOString(),
    ingestedAt: ingestedAt === null ? null : new Date(ingestedAt).toISOString(),
    maxIngestLagMs: maxLagMs,
    unknownSourceClocks: unknown
  };
}

function loadSourceEvidence(
  db: SQLiteDatabase,
  candidate: LessonCandidate,
  projectId: string | null
): SourceEvidence {
  const ids = Array.from(new Set(candidate.sourceEventIds.filter((id) => typeof id === 'string' && id.length > 0)));
  const rows: SourceEventRow[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    rows.push(...sqliteAll<SourceEventRow>(
      db,
      `SELECT id, event_type, timestamp, content, metadata
       FROM events WHERE id IN (${chunk.map(() => '?').join(',')})`,
      chunk
    ));
  }
  const found = new Set(rows.map((row) => row.id));
  const refs: MemoryRef[] = ids.map((id) => ({
    projectId,
    // A source the store cannot read back is not silently typed as an event.
    kind: found.has(id) ? 'event' : 'unknown',
    id
  }));
  return { refs, rows, text: classifiableText(rows), clock: readSourceClock(rows) };
}

/**
 * Safeguards from R4. A candidate collects every reason it fails, so a review
 * sees the whole picture instead of only the first trip-wire.
 */
export function classifyDerivedEvidence(
  candidate: LessonCandidate,
  evidence: { text: string; refs: MemoryRef[] }
): DerivedEvidenceRejection[] {
  const rejections = new Set<DerivedEvidenceRejection>();
  const lessonText = [candidate.name, candidate.trigger, ...candidate.steps, ...candidate.failureModes, ...candidate.reasons, ...candidate.pattern.tools, ...candidate.pattern.fileCategories, ...candidate.pattern.taskPatterns].join('\n');
  const haystack = `${lessonText}\n${evidence.text}`;

  if (evidence.refs.length === 0 || evidence.refs.some((ref) => ref.kind === 'unknown')) {
    // Without a source that can be read back, "verified" would be unverifiable.
    rejections.add('no_source_refs');
  }
  // Two independent signals. The audit sanitizer replaces credential
  // assignments it recognises with [REDACTED]; the pattern below catches the
  // shapes it does not, such as an env-style `NPM_TOKEN=...` whose underscore
  // defeats the sanitizer's word boundary.
  const sanitizerRedacted = /\[REDACTED\]/.test(evidence.text)
    && /(?:secret|token|password|api[_-]?key|credential)/i.test(haystack);
  if (sanitizerRedacted || SECRET_ASSIGNMENT_PATTERN.test(haystack)) {
    rejections.add('sensitive_material');
  }
  if (MISSING_CREDENTIAL_PATTERN.test(haystack)) rejections.add('missing_credentials');
  if (ENVIRONMENT_FAILURE_PATTERN.test(haystack)) rejections.add('environment_dependent_failure');
  if (PR_NARRATIVE_PATTERN.test(haystack)) rejections.add('one_off_pr_narrative');
  if (REPOSITORY_DOCUMENT_PATTERN.test(haystack)) rejections.add('repository_document_copy');
  // Failure with no success anywhere in the evidence is an attempt, not a
  // procedure. A failure that was followed by a retry keeps only the retry
  // condition (see `applicabilityFor`), which is the reusable part.
  if (FAILURE_PATTERN.test(evidence.text) && !SUCCESS_PATTERN.test(evidence.text)) {
    rejections.add('unresolved_failure');
  }
  return Array.from(rejections);
}

function applicabilityFor(candidate: LessonCandidate, evidence: { text: string }): string[] {
  const conditions: string[] = [];
  if (candidate.pattern.taskPatterns.length > 0) {
    conditions.push(`Task pattern: ${candidate.pattern.taskPatterns.join(', ')}`);
  }
  if (candidate.pattern.fileCategories.length > 0) {
    conditions.push(`File categories: ${candidate.pattern.fileCategories.join(', ')}`);
  }
  if (candidate.pattern.tools.length > 0) {
    conditions.push(`Validated with: ${candidate.pattern.tools.join(', ')}`);
  }
  // R4: when the evidence shows a failure that a retry resolved, only the retry
  // condition survives — not the failure narrative.
  if (FAILURE_PATTERN.test(evidence.text) && RETRY_PATTERN.test(evidence.text) && SUCCESS_PATTERN.test(evidence.text)) {
    conditions.push('Applies on retry after the first attempt failed; the failure itself is not the lesson.');
  }
  if (conditions.length === 0) {
    conditions.push(`Trigger only: ${candidate.trigger}`);
  }
  return conditions;
}

function toDerivedCandidate(
  candidate: LessonCandidate,
  evidence: SourceEvidence,
  projectId: string | null,
  rejections: DerivedEvidenceRejection[]
): DerivedEvidenceCandidate {
  // A blocked verdict is not a privacy boundary on its own. Never return the
  // sensitive candidate's prose alongside that verdict (including rationale
  // and applicability, which can repeat extractor output).
  const sensitive = rejections.includes('sensitive_material');
  return {
    candidateId: candidate.candidateId,
    projectId,
    name: sensitive ? '[Sensitive candidate withheld]' : candidate.name,
    trigger: sensitive ? '[REDACTED]' : candidate.trigger,
    steps: sensitive ? [] : candidate.steps,
    sourceRefs: evidence.refs,
    applicability: sensitive ? [] : applicabilityFor(candidate, evidence),
    rationale: sensitive ? ['Sensitive material detected; candidate text withheld.'] : candidate.reasons,
    validity: {
      reviewAfterDays: DERIVED_EVIDENCE_REVIEW_DAYS,
      reviewWhen: [
        'The tools or file categories above stop appearing in this project',
        'A later session contradicts one of the steps',
        `The generator version changes from ${DERIVED_EVIDENCE_GENERATOR_VERSION}`
      ]
    },
    confidence: candidate.confidence,
    generatorVersion: DERIVED_EVIDENCE_GENERATOR_VERSION,
    sourceClock: evidence.clock,
    promotion: {
      state: rejections.length > 0 ? 'blocked' : 'shadow_candidate',
      rejections,
      // Shadow mode: a derived candidate is never retrievable. Only an explicit
      // human promotion (mem-lesson-save) turns one into a recalled lesson.
      usableForRecall: false
    }
  };
}

export function emptyRejectionCounts(): Record<DerivedEvidenceRejection, number> {
  return Object.fromEntries(DERIVED_EVIDENCE_REJECTIONS.map((reason) => [reason, 0])) as
    Record<DerivedEvidenceRejection, number>;
}

/**
 * Evaluate mined lesson candidates in shadow mode.
 *
 * Read-only: it reads the source events back to classify them and writes
 * nothing. The caller decides whether to show the result; nothing here changes
 * retrieval.
 */
export function evaluateDerivedEvidenceShadow(
  db: SQLiteDatabase,
  candidates: LessonCandidate[],
  options: { projectId?: string | null } = {}
): DerivedEvidenceShadowReport {
  const projectId = options.projectId ?? null;
  const shadowCandidates: DerivedEvidenceCandidate[] = [];
  const blocked: DerivedEvidenceCandidate[] = [];
  const rejectionCounts = emptyRejectionCounts();
  let unresolvedSourceRefs = 0;

  for (const candidate of candidates) {
    const evidence = loadSourceEvidence(db, candidate, projectId);
    unresolvedSourceRefs += evidence.refs.filter((ref) => ref.kind === 'unknown').length;
    const rejections = classifyDerivedEvidence(candidate, evidence);
    for (const reason of rejections) rejectionCounts[reason] += 1;
    const derived = toDerivedCandidate(candidate, evidence, projectId, rejections);
    if (rejections.length > 0) blocked.push(derived);
    else shadowCandidates.push(derived);
  }

  return {
    generatorVersion: DERIVED_EVIDENCE_GENERATOR_VERSION,
    mode: 'shadow',
    evaluated: candidates.length,
    shadowCandidates,
    blocked,
    rejectionCounts,
    unresolvedSourceRefs,
    note: 'Shadow evaluation only. No candidate here is retrievable; promotion stays an explicit mem-lesson-save '
      + 'by a reviewer. Token and precision targets from the spec are experiment criteria and are not measured here.'
  };
}
