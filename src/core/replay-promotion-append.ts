import { createHash } from 'node:crypto';

import type {
  ReplayEvaluationFixture,
  ReplayEvaluationQuery
} from './replay-evaluator.js';
import type {
  ReplayPromotionPlan,
  ReplayPromotionQuerySkeleton
} from './replay-promotion.js';

export type ReplayPromotionAppendIssueCode =
  | 'invalid_plan'
  | 'invalid_fixture'
  | 'unsafe_field'
  | 'unsafe_value'
  | 'placeholder_remaining'
  | 'duplicate_query_id'
  | 'invalid_query'
  | 'unknown_expected_id'
  | 'missing_expected_relevance';

export interface ReplayPromotionAppendIssue {
  code: ReplayPromotionAppendIssueCode;
  candidateId?: string;
  queryId?: string;
  field?: string;
}

export interface ReplayPromotionAppendOptions {
  generatedAt?: string;
}

export interface ReplayPromotionAppendSummary {
  candidatesRead: number;
  appendedQueries: number;
  existingQueries: number;
  memoryCount: number;
  issueCount: number;
}

export interface ReplayPromotionAppendReport {
  ok: boolean;
  generatedAt: string;
  summary: ReplayPromotionAppendSummary;
  issues: ReplayPromotionAppendIssue[];
  mergedFixture?: ReplayEvaluationFixture;
}

const PLACEHOLDER_PATTERN = /TODO[A-Za-z0-9_-]*/i;
const LOCAL_PATH_PATTERN = /(?:^|[^A-Za-z0-9])(?:~[\\/]|\/[A-Za-z0-9._-]+(?:[\\/]|$|(?=[^A-Za-z0-9]))|[A-Za-z]:[\\/]|\\\\[A-Za-z0-9_.-]+[\\/])/;
const UNSAFE_VALUE_PATTERN = /(?:PRIVATE_|raw-query-should-not-leak|raw-memory-should-not-leak)/i;
const CREDENTIAL_LIKE_PATTERN = /(?:ghp_|github_pat_|gho_|ghu_|ghs_|ghr_|xox[bcaprs]-|AKIA[0-9A-Z]{8,}|ASIA[0-9A-Z]{8,}|AIza[0-9A-Za-z_-]{6,}|ya29\.|glpat-|sk-[A-Za-z0-9_-]{4,}|authorization\s*:\s*\S+|bearer\s+[A-Za-z0-9._~+\/=-]{6,}|(?:api[_-]?key|token|secret|password|passwd|credential)(?:[:=_-][A-Za-z0-9_.:-]{2,}|[A-Z][A-Za-z0-9_.:-]{3,}))/i;
const SAFE_PUBLIC_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const FIELD_SEPARATOR = '[\\s_-]*';
const UNSAFE_FIELD_PATTERN = new RegExp(
  `^(?:raw(?:[A-Za-z0-9_ -]*)?|.*(?:Memory${FIELD_SEPARATOR}(?:Content|Text)|Query${FIELD_SEPARATOR}(?:Content|Text)|Prompt${FIELD_SEPARATOR}(?:Content|Text)|private${FIELD_SEPARATOR}key|authorization|api${FIELD_SEPARATOR}key|secret|token|password|passwd|credential).*|query${FIELD_SEPARATOR}text|effective${FIELD_SEPARATOR}query|enriched${FIELD_SEPARATOR}query|prompt|title|detail|action|content)$`,
  'i'
);
const NORMALIZED_UNSAFE_FIELD_PATTERN = /^(?:raw.*|.*(?:memory(?:content|text)|query(?:content|text)|prompt(?:content|text)|privatekey|authorization|apikey|secret|token|password|passwd|credential).*|querytext|effectivequery|enrichedquery|prompt|title|detail|action|content)$/i;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function buildReplayPromotionAppendReport(
  promotionPlan: ReplayPromotionPlan,
  fixture: ReplayEvaluationFixture,
  options: ReplayPromotionAppendOptions = {}
): ReplayPromotionAppendReport {
  const generatedAt = options.generatedAt === undefined
    ? new Date().toISOString()
    : validateCanonicalUtcIsoTimestamp(options.generatedAt, 'generatedAt');
  const issues: ReplayPromotionAppendIssue[] = [];
  const candidates = Array.isArray(promotionPlan?.candidates) ? promotionPlan.candidates : [];
  const existingQueries = Array.isArray(fixture?.queries) ? fixture.queries : [];
  const memories = Array.isArray(fixture?.memories) ? fixture.memories : [];

  if (!isRecord(promotionPlan) || !Array.isArray(promotionPlan.candidates)) {
    issues.push({ code: 'invalid_plan' });
  }
  if (!isRecord(fixture) || !Array.isArray(fixture.queries) || !Array.isArray(fixture.memories)) {
    issues.push({ code: 'invalid_fixture' });
  }

  const knownMemoryIds = new Set(memories.map((memory) => memory.id).filter((id): id is string => typeof id === 'string'));
  const seenQueryIds = new Set(existingQueries.map((query) => query.queryId).filter(Boolean));
  const appendedQueries: ReplayEvaluationQuery[] = [];

  for (const candidate of candidates) {
    const candidateId = safeCandidateId(candidate);
    collectUnsafeIssues(candidate, issues, candidateId);
    const query = isRecord(candidate) ? candidate.replayQuerySkeleton : undefined;
    if (!isReplayPromotionQuerySkeleton(query)) {
      issues.push({ code: 'invalid_query', candidateId });
      continue;
    }

    const queryId = query.queryId;
    const publicQueryId = sanitizePublicIdentifier(queryId, 'query');
    if (containsPlaceholder(query)) {
      issues.push({ code: 'placeholder_remaining', candidateId, queryId: publicQueryId });
    }
    if (seenQueryIds.has(queryId)) {
      issues.push({ code: 'duplicate_query_id', candidateId, queryId: publicQueryId });
    }
    seenQueryIds.add(queryId);

    if (query.expectation === 'match' && query.expectedIds.length === 0) {
      issues.push({ code: 'invalid_query', candidateId, queryId: publicQueryId, field: 'expectedIds' });
    }
    for (const expectedId of query.expectedIds) {
      if (!knownMemoryIds.has(expectedId)) {
        issues.push({ code: 'unknown_expected_id', candidateId, queryId: publicQueryId });
      }
      if (!Object.prototype.hasOwnProperty.call(query.expectedRelevance, expectedId)) {
        issues.push({ code: 'missing_expected_relevance', candidateId, queryId: publicQueryId });
      }
    }
    for (const relevanceId of Object.keys(query.expectedRelevance)) {
      if (!query.expectedIds.includes(relevanceId)) {
        issues.push({ code: 'missing_expected_relevance', candidateId, queryId: publicQueryId });
      }
    }

    appendedQueries.push({
      queryId: query.queryId,
      category: query.category,
      query: query.query,
      expectation: query.expectation,
      expectedIds: [...query.expectedIds],
      expectedRelevance: { ...query.expectedRelevance },
      forbiddenIds: [...query.forbiddenIds]
    });
  }

  const summary: ReplayPromotionAppendSummary = {
    candidatesRead: candidates.length,
    appendedQueries: issues.length === 0 ? appendedQueries.length : 0,
    existingQueries: existingQueries.length,
    memoryCount: memories.length,
    issueCount: issues.length
  };

  if (issues.length > 0) {
    return {
      ok: false,
      generatedAt,
      summary,
      issues: dedupeIssues(issues)
    };
  }

  const mergedFixture: ReplayEvaluationFixture = {
    ...fixture,
    metadata: {
      ...fixture.metadata,
      rawContentIncluded: false,
      generatedAt
    },
    queries: [...fixture.queries, ...appendedQueries],
    memories: [...fixture.memories]
  };

  return {
    ok: true,
    generatedAt,
    summary,
    issues: [],
    mergedFixture
  };
}

export function formatReplayPromotionAppendMarkdown(report: ReplayPromotionAppendReport): string {
  const lines: string[] = [];
  lines.push('# Replay Promotion Append Validation');
  lines.push('');
  lines.push(`- Status: ${report.ok ? 'PASS' : 'FAIL'}`);
  lines.push(`- Generated at: ${report.generatedAt}`);
  lines.push(`- Candidates read: ${report.summary.candidatesRead}`);
  lines.push(`- Appended queries: ${report.summary.appendedQueries}`);
  lines.push(`- Existing queries: ${report.summary.existingQueries}`);
  lines.push(`- Memory count: ${report.summary.memoryCount}`);
  lines.push(`- Issue count: ${report.summary.issueCount}`);
  lines.push('');
  if (report.issues.length > 0) {
    lines.push('## Issues');
    lines.push('');
    lines.push('| code | candidateId | queryId | field |');
    lines.push('|---|---|---|---|');
    for (const issue of report.issues) {
      lines.push(`| ${issue.code} | ${issue.candidateId ?? ''} | ${issue.queryId ?? ''} | ${issue.field ?? ''} |`);
    }
    lines.push('');
  }
  lines.push('## Next step');
  lines.push('');
  lines.push('- Run `npm run eval:retrieval-replay` after writing the merged fixture.');
  lines.push('- Report intentionally omits raw query text and memory content.');
  return `${lines.join('\n')}\n`;
}

export function stripMergedFixtureFromReport(report: ReplayPromotionAppendReport): Omit<ReplayPromotionAppendReport, 'mergedFixture'> {
  const { mergedFixture: _mergedFixture, ...publicReport } = report;
  return publicReport;
}

function validateCanonicalUtcIsoTimestamp(value: string, field: string): string {
  if (!ISO_INSTANT_PATTERN.test(value)) {
    throw new Error(`Invalid ${field}: expected a canonical UTC ISO timestamp`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`Invalid ${field}: expected a canonical UTC ISO timestamp`);
  }
  return value;
}

function isReplayPromotionQuerySkeleton(value: unknown): value is ReplayPromotionQuerySkeleton {
  if (!isRecord(value)) return false;
  if (typeof value.queryId !== 'string' || value.queryId.trim() === '') return false;
  if (typeof value.category !== 'string' || value.category.trim() === '') return false;
  if (typeof value.query !== 'string' || value.query.trim() === '') return false;
  if (value.expectation !== 'match') return false;
  if (!Array.isArray(value.expectedIds) || value.expectedIds.some((id) => typeof id !== 'string')) return false;
  if (!isRecord(value.expectedRelevance)) return false;
  if (!Array.isArray(value.forbiddenIds) || value.forbiddenIds.some((id) => typeof id !== 'string')) return false;
  return Object.values(value.expectedRelevance).every((score) => typeof score === 'number' && Number.isFinite(score));
}

function containsPlaceholder(query: ReplayPromotionQuerySkeleton): boolean {
  return PLACEHOLDER_PATTERN.test(query.query)
    || PLACEHOLDER_PATTERN.test(query.queryId)
    || PLACEHOLDER_PATTERN.test(query.category)
    || query.expectedIds.some((id) => PLACEHOLDER_PATTERN.test(id))
    || Object.keys(query.expectedRelevance).some((id) => PLACEHOLDER_PATTERN.test(id))
    || query.forbiddenIds.some((id) => PLACEHOLDER_PATTERN.test(id));
}

function collectUnsafeIssues(value: unknown, issues: ReplayPromotionAppendIssue[], candidateId?: string, path = ''): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectUnsafeIssues(entry, issues, candidateId, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    if (typeof value === 'string') {
      if (PLACEHOLDER_PATTERN.test(value)) {
        issues.push({ code: 'placeholder_remaining', candidateId });
      } else if (isUnsafePublicString(value)) {
        issues.push({ code: 'unsafe_value', candidateId });
      }
    }
    return;
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    if (PLACEHOLDER_PATTERN.test(key)) {
      issues.push({ code: 'placeholder_remaining', candidateId, field: sanitizeUnsafeFieldName(key) });
      continue;
    }
    if (isUnsafeFieldName(key) || isUnsafePublicString(key)) {
      issues.push({ code: 'unsafe_field', candidateId, field: sanitizeUnsafeFieldName(key) });
      continue;
    }
    collectUnsafeIssues(nestedValue, issues, candidateId, path ? `${path}.${key}` : key);
  }
}

function safeCandidateId(candidate: unknown): string | undefined {
  if (!isRecord(candidate) || typeof candidate.candidateId !== 'string') return undefined;
  return sanitizePublicIdentifier(candidate.candidateId, 'candidate');
}

function isUnsafePublicString(value: string): boolean {
  return isUnsafeFieldName(value)
    || UNSAFE_VALUE_PATTERN.test(value)
    || LOCAL_PATH_PATTERN.test(value)
    || CREDENTIAL_LIKE_PATTERN.test(value);
}

function isUnsafeFieldName(value: string): boolean {
  const normalized = value.replace(/[^A-Za-z0-9]/g, '');
  return UNSAFE_FIELD_PATTERN.test(value)
    || (normalized.length > 0 && NORMALIZED_UNSAFE_FIELD_PATTERN.test(normalized));
}

function sanitizePublicIdentifier(value: string, prefix: string): string {
  const trimmed = value.trim();
  if (
    SAFE_PUBLIC_IDENTIFIER_PATTERN.test(trimmed)
    && !isUnsafeFieldName(trimmed)
    && !isUnsafePublicString(trimmed)
    && !PLACEHOLDER_PATTERN.test(trimmed)
  ) {
    return trimmed;
  }
  return `${prefix}-${hashIdentifier(trimmed || prefix)}`;
}

function sanitizeUnsafeFieldName(value: string): string {
  return `field-${hashIdentifier(value.trim() || 'unsafe-field')}`;
}

function hashIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function dedupeIssues(issues: ReplayPromotionAppendIssue[]): ReplayPromotionAppendIssue[] {
  const seen = new Set<string>();
  const deduped: ReplayPromotionAppendIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.code}\u0000${issue.candidateId ?? ''}\u0000${issue.queryId ?? ''}\u0000${issue.field ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(issue);
  }
  return deduped;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
