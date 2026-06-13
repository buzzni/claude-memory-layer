import type { ReplayEvaluationQueryMetrics, ReplayEvaluationReport } from './replay-evaluator.js';

export type LongMemEvalFailureType =
  | 'hit'
  | 'no_candidate'
  | 'candidate_but_filtered'
  | 'answer_below_k'
  | 'multi_evidence_partial'
  | 'lexical_mismatch'
  | 'unexpected_match';

export interface LongMemEvalAnalysisOptions {
  k?: number;
}

export interface LongMemEvalQueryAnalysis {
  queryId: string;
  category: string;
  expectedCount: number;
  hitsAtK: number;
  recallAnyAtK: number;
  recallAllAtK: number;
  fractionalRecallAtK: number;
  ndcgAtK: number;
  reciprocalRank: number;
  failureType: LongMemEvalFailureType;
  firstRelevantCandidateRank?: number;
  firstRelevantRetrievedRank?: number;
}

export interface LongMemEvalAggregateAnalysis {
  k: number;
  queryCount: number;
  recallAnyAtK: number;
  recallAllAtK: number;
  fractionalRecallAtK: number;
  ndcgAtK: number;
  mrr: number;
  failureBreakdown: Partial<Record<LongMemEvalFailureType, number>>;
}

export interface LongMemEvalRetrievalAnalysis extends LongMemEvalAggregateAnalysis {
  categoryBreakdown: Record<string, LongMemEvalAggregateAnalysis>;
  perQuery: LongMemEvalQueryAnalysis[];
}

export function analyzeLongMemEvalRetrievalReport(
  report: ReplayEvaluationReport,
  options: LongMemEvalAnalysisOptions = {}
): LongMemEvalRetrievalAnalysis {
  const k = options.k ?? inferLargestK(report);
  const perQuery = report.perQuery
    .filter((metric) => getExpectedIds(metric).length > 0)
    .map((metric) => analyzeLongMemEvalQuery(metric, { k }));
  const aggregate = aggregateQueryAnalyses(perQuery, k);
  const categoryBreakdown: Record<string, LongMemEvalAggregateAnalysis> = {};

  for (const [category, rows] of groupByCategory(perQuery)) {
    categoryBreakdown[category] = aggregateQueryAnalyses(rows, k);
  }

  return {
    ...aggregate,
    categoryBreakdown,
    perQuery
  };
}

export function analyzeLongMemEvalQuery(
  metric: ReplayEvaluationQueryMetrics,
  options: Required<LongMemEvalAnalysisOptions>
): LongMemEvalQueryAnalysis {
  const kMetric = metricAtK(metric, options.k);
  const expectedIds = getExpectedIds(metric);
  const expected = new Set(expectedIds);
  const retrievedAtK = metric.retrievedIds.slice(0, options.k);
  const hitsAtK = unique(retrievedAtK.filter((id) => expected.has(id))).length;
  const expectedCount = expectedIds.length;
  const firstRelevantCandidateRank = findFirstRelevantRank(metric.candidateIds, expectedIds);
  const firstRelevantRetrievedRank = findFirstRelevantRank(metric.retrievedIds, expectedIds);

  const analysis: LongMemEvalQueryAnalysis = {
    queryId: metric.queryId,
    category: normalizeCategory(metric.category),
    expectedCount,
    hitsAtK,
    recallAnyAtK: hitsAtK > 0 ? 1 : 0,
    recallAllAtK: expectedCount > 0 && hitsAtK >= expectedCount ? 1 : 0,
    fractionalRecallAtK: expectedCount === 0 ? 0 : hitsAtK / expectedCount,
    ndcgAtK: kMetric?.ndcg ?? 0,
    reciprocalRank: metric.reciprocalRank,
    failureType: classifyLongMemEvalQueryFailure(metric, options)
  };
  if (firstRelevantCandidateRank !== undefined) {
    analysis.firstRelevantCandidateRank = firstRelevantCandidateRank;
  }
  if (firstRelevantRetrievedRank !== undefined) {
    analysis.firstRelevantRetrievedRank = firstRelevantRetrievedRank;
  }
  return analysis;
}

export function formatLongMemEvalAnalysisMarkdown(analysis: LongMemEvalRetrievalAnalysis): string {
  const lines: string[] = [];
  lines.push('## LongMemEval official-style retrieval metrics');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---:|');
  lines.push(`| Queries | ${analysis.queryCount} |`);
  lines.push(`| Recall_any@${analysis.k} | ${formatMetric(analysis.recallAnyAtK)} |`);
  lines.push(`| Recall_all@${analysis.k} | ${formatMetric(analysis.recallAllAtK)} |`);
  lines.push(`| Fractional Recall@${analysis.k} | ${formatMetric(analysis.fractionalRecallAtK)} |`);
  lines.push(`| nDCG@${analysis.k} | ${formatMetric(analysis.ndcgAtK)} |`);
  lines.push(`| MRR | ${formatMetric(analysis.mrr)} |`);
  lines.push('');
  lines.push('### Failure breakdown');
  lines.push('');
  lines.push('| failure_type | count |');
  lines.push('|---|---:|');
  for (const [failureType, count] of sortedBreakdownEntries(analysis.failureBreakdown)) {
    lines.push(`| ${failureType} | ${count} |`);
  }
  if (Object.keys(analysis.categoryBreakdown).length > 0) {
    lines.push('');
    lines.push('### LongMemEval category breakdown');
    lines.push('');
    lines.push('| category | queries | Recall_any@k | Recall_all@k | Fractional Recall@k | nDCG@k | MRR | top failure |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---|');
    for (const category of Object.keys(analysis.categoryBreakdown).sort()) {
      const row = analysis.categoryBreakdown[category];
      if (!row) continue;
      const topFailure = sortedBreakdownEntries(row.failureBreakdown)[0]?.[0] ?? 'n/a';
      lines.push(
        `| ${escapeMarkdownCell(category)} | ${row.queryCount} | ${formatMetric(row.recallAnyAtK)} | ${formatMetric(row.recallAllAtK)} | ${formatMetric(row.fractionalRecallAtK)} | ${formatMetric(row.ndcgAtK)} | ${formatMetric(row.mrr)} | ${topFailure} |`
      );
    }
  }
  lines.push('');
  lines.push('> LongMemEval analysis reports IDs and aggregate metrics only; it intentionally omits raw query and memory text.');
  lines.push('');
  return lines.join('\n');
}

export function classifyLongMemEvalQueryFailure(
  metric: ReplayEvaluationQueryMetrics,
  options: Required<LongMemEvalAnalysisOptions>
): LongMemEvalFailureType {
  if (metric.expectation === 'no_match') {
    return metric.retrievedIds.length === 0 && (metric.forbiddenHitIds?.length ?? 0) === 0
      ? 'hit'
      : 'unexpected_match';
  }

  const expectedIds = getExpectedIds(metric);
  const expected = new Set(expectedIds);
  const retrievedAtK = metric.retrievedIds.slice(0, options.k);
  const hitsAtK = unique(retrievedAtK.filter((id) => expected.has(id))).length;
  if (expectedIds.length > 0 && hitsAtK >= expectedIds.length) {
    return 'hit';
  }
  if (hitsAtK > 0) {
    return 'multi_evidence_partial';
  }

  const candidateIds = metric.candidateIds ?? [];
  if (candidateIds.length === 0 && metric.retrievedIds.length === 0) {
    return 'no_candidate';
  }

  const firstRelevantCandidateRank = findFirstRelevantRank(candidateIds, expectedIds);
  if (firstRelevantCandidateRank !== undefined) {
    return firstRelevantCandidateRank > options.k ? 'answer_below_k' : 'candidate_but_filtered';
  }

  return 'lexical_mismatch';
}

function aggregateQueryAnalyses(
  rows: LongMemEvalQueryAnalysis[],
  k: number
): LongMemEvalAggregateAnalysis {
  const failureBreakdown: Partial<Record<LongMemEvalFailureType, number>> = {};
  for (const row of rows) {
    failureBreakdown[row.failureType] = (failureBreakdown[row.failureType] ?? 0) + 1;
  }
  return {
    k,
    queryCount: rows.length,
    recallAnyAtK: average(rows.map((row) => row.recallAnyAtK)),
    recallAllAtK: average(rows.map((row) => row.recallAllAtK)),
    fractionalRecallAtK: average(rows.map((row) => row.fractionalRecallAtK)),
    ndcgAtK: average(rows.map((row) => row.ndcgAtK)),
    mrr: average(rows.map((row) => row.reciprocalRank)),
    failureBreakdown
  };
}

function inferLargestK(report: ReplayEvaluationReport): number {
  const ks = report.fixtureStats.ks.length > 0
    ? report.fixtureStats.ks
    : Object.keys(report.summary.recallAtK ?? {}).map(Number);
  return Math.max(1, ...ks.filter((k) => Number.isFinite(k) && k > 0));
}

function metricAtK(metric: ReplayEvaluationQueryMetrics, k: number) {
  return metric.at[k] ?? metric.at[nearestAvailableK(metric, k)];
}

function nearestAvailableK(metric: ReplayEvaluationQueryMetrics, k: number): number {
  const ks = Object.keys(metric.at).map(Number).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  const atOrBelow = ks.filter((value) => value <= k).at(-1);
  return atOrBelow ?? ks[0] ?? k;
}

function getExpectedIds(metric: ReplayEvaluationQueryMetrics): string[] {
  const value = (metric as ReplayEvaluationQueryMetrics & { expectedIds?: unknown }).expectedIds;
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function findFirstRelevantRank(ids: string[], expectedIds: string[]): number | undefined {
  const expected = new Set(expectedIds);
  const index = ids.findIndex((id) => expected.has(id));
  return index === -1 ? undefined : index + 1;
}

function groupByCategory(rows: LongMemEvalQueryAnalysis[]): Map<string, LongMemEvalQueryAnalysis[]> {
  const groups = new Map<string, LongMemEvalQueryAnalysis[]>();
  for (const row of rows) {
    const values = groups.get(row.category) ?? [];
    values.push(row);
    groups.set(row.category, values);
  }
  return groups;
}

function normalizeCategory(category: string | undefined): string {
  const normalized = category?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : 'uncategorized';
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sortedBreakdownEntries(
  breakdown: Partial<Record<LongMemEvalFailureType, number>>
): Array<[LongMemEvalFailureType, number]> {
  return Object.entries(breakdown)
    .filter((entry): entry is [LongMemEvalFailureType, number] => typeof entry[1] === 'number' && entry[1] > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function formatMetric(value: number): string {
  return value.toFixed(4).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
