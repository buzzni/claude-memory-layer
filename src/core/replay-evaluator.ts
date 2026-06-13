import {
  computePrecisionRecallAtK,
  summarizeReplayMetrics,
  type ReplayMetricsSummary,
  type ReplayQueryMetrics
} from './retrieval-benchmark.js';
import { createRetrievalServices, type RetrieveMemoriesOptions } from './engine/retrieval-services.js';
import { Matcher } from './matcher.js';
import type { Embedder } from './embedder.js';
import type { MatchConfidence, MemoryEvent } from './types.js';
import type { SearchResult, VectorStore } from './vector-store.js';

export type ReplayExpectation = 'match' | 'no_match';

export interface ReplayTemporalDateBoost {
  referenceDate: string;
  targetDate?: string;
  toleranceDays?: number;
  entityTerms?: string[];
}

export interface ReplayEvaluationQuery {
  queryId: string;
  query: string;
  expectedIds: string[];
  expectedRelevance?: Record<string, number>;
  expectation?: ReplayExpectation;
  category?: string;
  forbiddenIds?: string[];
  knownAnswer?: string;
  temporalDateBoost?: ReplayTemporalDateBoost;
}

export interface ReplayEvaluationMemory {
  id: string;
  content: string;
  /**
   * Optional private indexing text used by replay retrievers only.
   * Reports and reader contexts continue to use `content` so benchmark output
   * does not expose expanded search keys.
   */
  searchContent?: string;
  sourceSessionId?: string;
  sourceTurnIndex?: number;
  timestamp?: string;
  eventType?: MemoryEvent['eventType'];
  canonicalKey?: string;
  metadata?: Record<string, unknown>;
}

export interface ReplayEvaluationFixtureMetadata {
  sourceFileCount?: number;
  rawContentIncluded?: boolean;
  generatedAt?: string;
  userFactSearchExpansion?: boolean;
  preferenceQueryExpansion?: boolean;
  temporalQueryExpansion?: boolean;
  temporalDateBoost?: boolean;
}

export interface ReplayEvaluationFixture {
  name: string;
  description?: string;
  ks: number[];
  queries: ReplayEvaluationQuery[];
  memories: ReplayEvaluationMemory[];
  metadata?: ReplayEvaluationFixtureMetadata;
}

export interface ReplayRetrievalRunInput {
  fixture: ReplayEvaluationFixture;
  query: ReplayEvaluationQuery;
  topK: number;
  retrievalOptions: Partial<RetrieveMemoriesOptions>;
}

export interface ReplayRetrievalRunResult {
  retrievedIds: string[];
  candidateIds?: string[];
  confidence?: MatchConfidence;
  fallbackTrace?: string[];
}

export type ReplayRetrievalRunner = (
  query: string,
  input: ReplayRetrievalRunInput
) => Promise<ReplayRetrievalRunResult>;

export interface ReplayEvaluationOptions {
  generatedAt?: string;
  includePerQuery?: boolean;
  evaluator?: string;
  topK?: number;
  retrievalOptions?: Partial<RetrieveMemoriesOptions>;
  retrievalRunner?: ReplayRetrievalRunner;
}

export interface ReplayFixtureStats {
  queryCount: number;
  memoryCount: number;
  ks: number[];
  sourceFileCount?: number;
  rawContentIncluded?: boolean;
}

export interface ReplayFailedQuery {
  queryId: string;
  expectedIds: string[];
  retrievedIds: string[];
  expectation?: ReplayExpectation;
  reason?: 'missing_expected' | 'unexpected_match';
}

export interface ReplayEvaluationCategorySummary extends ReplayMetricsSummary {
  positiveQueryCount: number;
  noMatchQueryCount: number;
  noMatchCorrect: number;
  noMatchAccuracy: number;
  forbiddenHitCount: number;
  hitAtK: Record<number, number>;
  mrr: number;
  failedQueryCount: number;
  queryYieldRate: number;
}

export interface ReplayEvaluationSummary extends ReplayMetricsSummary {
  positiveQueryCount: number;
  noMatchQueryCount: number;
  noMatchCorrect: number;
  noMatchAccuracy: number;
  forbiddenHitCount: number;
  hitAtK: Record<number, number>;
  mrr: number;
  failedQueryCount: number;
  failedQueries: ReplayFailedQuery[];
  queryYieldRate: number;
  categoryBreakdown: Record<string, ReplayEvaluationCategorySummary>;
}

export interface ReplayEvaluationQueryMetrics extends ReplayQueryMetrics {
  expectedIds: string[];
  retrievedIds: string[];
  candidateIds: string[];
  confidence: MatchConfidence;
  fallbackTrace: string[];
  reciprocalRank: number;
  expectation?: ReplayExpectation;
  category?: string;
  forbiddenHitIds?: string[];
  noMatchSatisfied?: boolean;
}

export interface ReplayEvaluationReport {
  name: string;
  description?: string;
  evaluator: string;
  generatedAt: string;
  fixtureStats: ReplayFixtureStats;
  summary: ReplayEvaluationSummary;
  perQuery: ReplayEvaluationQueryMetrics[];
}

export interface ReplayEvaluationMarkdownOptions {
  qrelsPath?: string;
}

export async function evaluateReplayFixture(
  fixture: ReplayEvaluationFixture,
  options: ReplayEvaluationOptions = {}
): Promise<ReplayEvaluationReport> {
  const topK = determineTopK(fixture, options.topK);
  const retrievalOptions: Partial<RetrieveMemoriesOptions> = {
    strategy: 'auto',
    minScore: 0.1,
    includeShared: false,
    adaptiveRerank: false,
    ...options.retrievalOptions,
    topK
  };
  const runner = options.retrievalRunner ?? createReplayRetrievalRunner(fixture);
  const memoryById = new Map(fixture.memories.map((memory) => [memory.id, memory]));

  const runs = await Promise.all(
    fixture.queries.map(async (query) => {
      const run = await runner(query.query, {
        fixture,
        query,
        topK,
        retrievalOptions
      });
      const boostedRun = applyTemporalDateBoost(run, query, memoryById, topK);
      return {
        query,
        retrievedIds: uniqueIds(boostedRun.retrievedIds).slice(0, topK),
        candidateIds: uniqueIds(boostedRun.candidateIds ?? boostedRun.retrievedIds),
        confidence: boostedRun.confidence ?? 'none',
        fallbackTrace: boostedRun.fallbackTrace ?? []
      };
    })
  );

  const baseMetrics = computePrecisionRecallAtK(
    runs.map((run) => ({
      queryId: run.query.queryId,
      expectedIds: run.query.expectedIds,
      expectedRelevance: run.query.expectedRelevance,
      retrievedIds: run.retrievedIds
    })),
    fixture.ks
  );

  const perQuery: ReplayEvaluationQueryMetrics[] = baseMetrics.map((metric, index) => {
    const run = runs[index];
    const expectation = getReplayExpectation(run.query);
    const base: ReplayEvaluationQueryMetrics = {
      ...metric,
      expectedIds: [...run.query.expectedIds],
      retrievedIds: run.retrievedIds,
      candidateIds: run.candidateIds,
      confidence: run.confidence,
      fallbackTrace: run.fallbackTrace,
      reciprocalRank: expectation === 'match' ? reciprocalRank(run.retrievedIds, run.query.expectedIds) : 0
    };
    if (run.query.category !== undefined) {
      base.category = normalizeCategory(run.query.category);
    }

    if (expectation === 'no_match') {
      const forbiddenHitIds = findForbiddenHitIds(run.retrievedIds, run.query.forbiddenIds ?? []);
      base.expectation = 'no_match';
      base.forbiddenHitIds = forbiddenHitIds;
      base.noMatchSatisfied = forbiddenHitIds.length === 0 && run.confidence === 'none' && run.retrievedIds.length === 0;
    }

    return base;
  });

  const fixtureStats: ReplayFixtureStats = {
    queryCount: fixture.queries.length,
    memoryCount: fixture.memories.length,
    ks: fixture.ks
  };
  if (fixture.metadata?.sourceFileCount !== undefined) {
    fixtureStats.sourceFileCount = fixture.metadata.sourceFileCount;
  }
  if (fixture.metadata?.rawContentIncluded !== undefined) {
    fixtureStats.rawContentIncluded = fixture.metadata.rawContentIncluded;
  }

  const report: ReplayEvaluationReport = {
    name: fixture.name,
    evaluator: options.evaluator ?? 'retriever-pipeline-v1',
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    fixtureStats,
    summary: summarizeEvaluationMetrics(perQuery, fixture.queries, fixture.ks),
    perQuery: options.includePerQuery === false ? [] : perQuery
  };

  if (fixture.description !== undefined) {
    report.description = fixture.description;
  }

  return report;
}

export function createReplayRetrievalRunner(
  fixture: ReplayEvaluationFixture
): ReplayRetrievalRunner {
  const eventStore = new ReplayEventStore(fixture.memories);
  const vectorStore = new ReplayVectorStore(
    eventStore.events,
    (event) => eventStore.getSearchContent(event.id)
  );
  const embedder = new ReplayEmbedder();
  const services = createRetrievalServices({
    initialize: async () => undefined,
    eventStore: eventStore as unknown as Parameters<typeof createRetrievalServices>[0]['eventStore'],
    vectorStore: vectorStore as unknown as VectorStore,
    embedder: embedder as unknown as Embedder,
    matcher: new Matcher(),
    getProjectHash: () => null,
    hasSharedStore: () => false
  });

  return async (query, input) => {
    const result = await services.retrievalOrchestrator.retrieveMemories(query, {
      ...input.retrievalOptions,
      topK: input.topK,
      includeShared: false
    });

    return {
      retrievedIds: result.memories.map((memory) => memory.event.id),
      candidateIds: (result.candidateDebug ?? result.selectedDebug ?? [])
        .map((detail) => detail.eventId),
      confidence: result.matchResult.confidence,
      fallbackTrace: result.fallbackTrace ?? []
    };
  };
}

export function formatReplayEvaluationMarkdown(
  report: ReplayEvaluationReport,
  options: ReplayEvaluationMarkdownOptions = {}
): string {
  const lines: string[] = [];
  lines.push('# Retrieval Replay Benchmark Report');
  lines.push('');
  lines.push(`- Fixture: ${escapeMarkdownCell(report.name)}`);
  if (report.description) lines.push(`- Description: ${escapeMarkdownCell(report.description)}`);
  if (options.qrelsPath) lines.push(`- Qrels: \`${options.qrelsPath}\``);
  lines.push(`- Evaluator: \`${report.evaluator}\``);
  lines.push(`- Generated at: ${report.generatedAt}`);
  lines.push(`- Queries: ${report.fixtureStats.queryCount}`);
  lines.push(`- Memories: ${report.fixtureStats.memoryCount}`);
  if (report.fixtureStats.sourceFileCount !== undefined) {
    lines.push(`- Source files: ${report.fixtureStats.sourceFileCount}`);
  }
  if (report.fixtureStats.rawContentIncluded !== undefined) {
    lines.push(`- Raw content in evaluated fixture: ${report.fixtureStats.rawContentIncluded ? 'yes' : 'no'}`);
  }
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| k | Precision@k | Recall@k | nDCG@k | Hit@k |');
  lines.push('|---:|---:|---:|---:|---:|');

  for (const k of sortedKValues(report.summary)) {
    lines.push(
      `| ${k} | ${formatMetric(report.summary.precisionAtK[k] ?? 0)} | ${formatMetric(report.summary.recallAtK[k] ?? 0)} | ${formatMetric(report.summary.ndcgAtK[k] ?? 0)} | ${formatMetric(report.summary.hitAtK[k] ?? 0)} |`
    );
  }

  lines.push('');
  lines.push('## Key metrics');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---:|');
  lines.push(`| Positive queries | ${report.summary.positiveQueryCount} |`);
  lines.push(`| No-match queries | ${report.summary.noMatchQueryCount} |`);
  lines.push(`| No-match accuracy | ${formatMetric(report.summary.noMatchAccuracy)} |`);
  lines.push(`| Forbidden hits | ${report.summary.forbiddenHitCount} |`);
  lines.push(`| MRR | ${formatMetric(report.summary.mrr)} |`);
  lines.push(`| Query yield rate | ${formatMetric(report.summary.queryYieldRate)} |`);
  lines.push(`| Failed queries | ${report.summary.failedQueryCount} |`);
  for (const k of sortedKValues(report.summary)) {
    lines.push(`| Precision@${k} | ${formatMetric(report.summary.precisionAtK[k] ?? 0)} |`);
    lines.push(`| Recall@${k} | ${formatMetric(report.summary.recallAtK[k] ?? 0)} |`);
    lines.push(`| nDCG@${k} | ${formatMetric(report.summary.ndcgAtK[k] ?? 0)} |`);
    lines.push(`| Hit@${k} | ${formatMetric(report.summary.hitAtK[k] ?? 0)} |`);
  }

  if (Object.keys(report.summary.categoryBreakdown).length > 0) {
    lines.push('');
    lines.push('## Category breakdown');
    lines.push('');
    lines.push('| category | queries | positive | no-match | yield | Recall@k | Hit@k | failures | forbidden hits |');
    lines.push('|---|---:|---:|---:|---:|---|---|---:|---:|');
    for (const category of Object.keys(report.summary.categoryBreakdown).sort()) {
      const summary = report.summary.categoryBreakdown[category];
      if (!summary) continue;
      const recall = formatMetricMap(summary.recallAtK, 'Recall');
      const hit = formatMetricMap(summary.hitAtK, 'Hit');
      lines.push(
        `| ${escapeMarkdownCell(category)} | ${summary.queryCount} | ${summary.positiveQueryCount} | ${summary.noMatchQueryCount} | ${formatMetric(summary.queryYieldRate)} | ${escapeMarkdownCell(recall)} | ${escapeMarkdownCell(hit)} | ${summary.failedQueryCount} | ${summary.forbiddenHitCount} |`
      );
    }
  }

  if (report.summary.failedQueries.length > 0) {
    lines.push('');
    lines.push('## Failed queries');
    lines.push('');
    lines.push('| queryId | expectedIds | retrievedIds |');
    lines.push('|---|---|---|');
    for (const failed of report.summary.failedQueries) {
      lines.push(
        `| ${escapeMarkdownCell(failed.queryId)} | ${escapeMarkdownCell(failed.expectedIds.join(', '))} | ${escapeMarkdownCell(failed.retrievedIds.join(', '))} |`
      );
    }
  }

  if (report.perQuery.length > 0) {
    lines.push('');
    lines.push('## Per-query metrics');
    lines.push('');
    lines.push('| queryId | k | hits | Precision@k | Recall@k | nDCG@k | RR | confidence |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---|');

    for (const query of report.perQuery) {
      const ks = Object.keys(query.at).map(Number).sort((a, b) => a - b);
      for (const k of ks) {
        const metric = query.at[k];
        if (!metric) continue;
        lines.push(
          `| ${escapeMarkdownCell(query.queryId)} | ${k} | ${metric.hits} | ${formatMetric(metric.precision)} | ${formatMetric(metric.recall)} | ${formatMetric(metric.ndcg)} | ${formatMetric(query.reciprocalRank)} | ${query.confidence} |`
        );
      }
    }
  }

  lines.push('');
  lines.push('> Report intentionally omits raw query and memory text.');
  lines.push('');
  return lines.join('\n');
}

type ReplayMetricPair = {
  metric: ReplayEvaluationQueryMetrics;
  query: ReplayEvaluationQuery;
  expectation: ReplayExpectation;
};

function summarizeEvaluationMetrics(
  perQuery: ReplayEvaluationQueryMetrics[],
  queries: ReplayEvaluationQuery[],
  ks: number[]
): ReplayEvaluationSummary {
  const pairs: ReplayMetricPair[] = perQuery.map((metric, index) => ({
    metric,
    query: queries[index],
    expectation: getReplayExpectation(queries[index])
  }));
  const overall = summarizeMetricPairs(pairs, ks);
  const categoryBreakdown: Record<string, ReplayEvaluationCategorySummary> = {};

  for (const [category, categoryPairs] of groupPairsByCategory(pairs)) {
    const { failedQueries: _failedQueries, ...categorySummary } = summarizeMetricPairs(categoryPairs, ks);
    categoryBreakdown[category] = categorySummary;
  }

  return {
    ...overall,
    categoryBreakdown
  };
}

function summarizeMetricPairs(
  pairs: ReplayMetricPair[],
  ks: number[]
): ReplayEvaluationCategorySummary & { failedQueries: ReplayFailedQuery[] } {
  const positivePairs = pairs.filter((pair) => pair.expectation === 'match');
  const noMatchPairs = pairs.filter((pair) => pair.expectation === 'no_match');
  const positiveMetrics = positivePairs.map((pair) => pair.metric);
  const base = summarizeReplayMetrics(positiveMetrics, ks);
  const normalizedKs = normalizeKs(ks);
  const hitAtK: Record<number, number> = {};
  for (const k of normalizedKs) {
    hitAtK[k] = average(positiveMetrics.map((metric) => (metric.at[k]?.hits ?? 0) > 0 ? 1 : 0));
  }

  const positiveFailures: ReplayFailedQuery[] = positivePairs
    .filter(({ metric, query }) => query.expectedIds.length > 0 && metric.reciprocalRank === 0)
    .map(({ metric, query }) => ({
      queryId: query.queryId,
      expectedIds: [...query.expectedIds],
      retrievedIds: [...metric.retrievedIds],
      expectation: 'match',
      reason: 'missing_expected'
    }));

  const noMatchFailures: ReplayFailedQuery[] = noMatchPairs
    .filter(({ metric }) => metric.noMatchSatisfied !== true)
    .map(({ metric }) => ({
      queryId: metric.queryId,
      expectedIds: [],
      retrievedIds: [...metric.retrievedIds],
      expectation: 'no_match',
      reason: 'unexpected_match'
    }));

  const noMatchCorrect = noMatchPairs.filter(({ metric }) => metric.noMatchSatisfied === true).length;
  const forbiddenHitCount = noMatchPairs.reduce(
    (sum, { metric }) => sum + (metric.forbiddenHitIds?.length ?? 0),
    0
  );
  const failedQueries = [...positiveFailures, ...noMatchFailures];
  const yieldedPositiveQueries = positivePairs.filter(({ metric }) => metric.retrievedIds.length > 0).length;

  return {
    ...base,
    queryCount: pairs.length,
    positiveQueryCount: positivePairs.length,
    noMatchQueryCount: noMatchPairs.length,
    noMatchCorrect,
    noMatchAccuracy: noMatchPairs.length === 0 ? 0 : noMatchCorrect / noMatchPairs.length,
    forbiddenHitCount,
    hitAtK,
    mrr: average(positiveMetrics.map((metric) => metric.reciprocalRank)),
    failedQueryCount: failedQueries.length,
    failedQueries,
    queryYieldRate: positivePairs.length === 0 ? 0 : yieldedPositiveQueries / positivePairs.length
  };
}

function groupPairsByCategory(pairs: ReplayMetricPair[]): Map<string, ReplayMetricPair[]> {
  const groups = new Map<string, ReplayMetricPair[]>();
  for (const pair of pairs) {
    const category = pair.metric.category ?? normalizeCategory(pair.query.category);
    const values = groups.get(category) ?? [];
    values.push(pair);
    groups.set(category, values);
  }
  return groups;
}

function determineTopK(fixture: ReplayEvaluationFixture, optionTopK?: number): number {
  return Math.max(1, optionTopK ?? 0, ...fixture.ks.map((k) => Math.floor(k)).filter((k) => k > 0));
}

function sortedKValues(summary: ReplayMetricsSummary): number[] {
  return Object.keys(summary.precisionAtK).map(Number).sort((a, b) => a - b);
}

function normalizeCategory(category: string | undefined): string {
  const normalized = category?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : 'uncategorized';
}

function formatMetricMap(values: Record<number, number>, label: string): string {
  return Object.keys(values)
    .map(Number)
    .sort((a, b) => a - b)
    .map((k) => `${label}@${k}=${formatMetric(values[k] ?? 0)}`)
    .join(', ');
}

function normalizeKs(ks: number[]): number[] {
  const seen = new Set<number>();
  const normalized: number[] = [];
  for (const rawK of ks) {
    const k = Math.max(0, Math.floor(rawK));
    if (seen.has(k)) continue;
    seen.add(k);
    normalized.push(k);
  }
  return normalized.sort((a, b) => a - b);
}

function uniqueIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  return unique;
}

function reciprocalRank(retrievedIds: string[], expectedIds: string[]): number {
  const expected = new Set(expectedIds);
  if (expected.size === 0) return 0;
  const index = retrievedIds.findIndex((id) => expected.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

function getReplayExpectation(query: ReplayEvaluationQuery | undefined): ReplayExpectation {
  if (!query) return 'match';
  return query.expectation ?? (query.expectedIds.length === 0 ? 'no_match' : 'match');
}

function findForbiddenHitIds(retrievedIds: string[], forbiddenIds: string[]): string[] {
  if (forbiddenIds.length === 0) return [];
  const forbidden = new Set(forbiddenIds);
  return uniqueIds(retrievedIds.filter((id) => forbidden.has(id)));
}

function applyTemporalDateBoost(
  run: ReplayRetrievalRunResult,
  query: ReplayEvaluationQuery,
  memoryById: Map<string, ReplayEvaluationMemory>,
  topK: number
): ReplayRetrievalRunResult {
  const boost = query.temporalDateBoost;
  if (!boost?.targetDate) return run;

  const entityTerms = uniqueIds((boost.entityTerms ?? [])
    .map((term) => term.toLowerCase().trim())
    .filter((term) => term.length >= 3));
  if (entityTerms.length === 0) return run;

  const targetTime = parseDateOnlyUtc(boost.targetDate);
  if (targetTime === undefined) return run;

  const pool = uniqueIds([...(run.retrievedIds ?? []), ...(run.candidateIds ?? [])]);
  if (pool.length === 0) return run;

  const toleranceDays = Math.max(0, Math.floor(boost.toleranceDays ?? 1));
  const scored = pool.map((id, index) => {
    const memory = memoryById.get(id);
    const temporalScore = memory
      ? temporalDateCandidateScore(memory, entityTerms, targetTime, toleranceDays)
      : 0;
    const baseScore = 1 / (index + 1);
    return { id, score: baseScore + temporalScore, temporalScore, index };
  });

  const boostedCount = scored.filter((row) => row.temporalScore > 0).length;
  if (boostedCount === 0) return run;

  const rerankedIds = scored
    .sort((a, b) => b.score - a.score || a.index - b.index || a.id.localeCompare(b.id))
    .map((row) => row.id);
  const retrievedIds = rerankedIds.slice(0, topK);
  const originalRetrieved = uniqueIds(run.retrievedIds ?? []).slice(0, topK);
  const changed = retrievedIds.join(' ') !== originalRetrieved.join(' ');
  if (!changed) return run;

  return {
    ...run,
    retrievedIds,
    candidateIds: uniqueIds([...(run.candidateIds ?? []), ...retrievedIds]),
    fallbackTrace: uniqueIds([...(run.fallbackTrace ?? []), 'temporal-date-boost:applied'])
  };
}

function temporalDateCandidateScore(
  memory: ReplayEvaluationMemory,
  entityTerms: string[],
  targetTime: number,
  toleranceDays: number
): number {
  const memoryTime = parseDateOnlyUtc(memory.timestamp);
  if (memoryTime === undefined) return 0;
  const dayDiff = Math.abs(memoryTime - targetTime) / 86_400_000;
  if (dayDiff > toleranceDays) return 0;

  const contentTokens = new Set(tokenize(memory.content));
  const entityHits = entityTerms.filter((term) => contentTokens.has(term)).length;
  if (entityHits === 0) return 0;

  const entityCoverage = entityHits / entityTerms.length;
  const proximity = toleranceDays === 0 ? 1 : 1 - (dayDiff / (toleranceDays + 1));
  return 2 + entityCoverage + proximity;
}

function parseDateOnlyUtc(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /\b(\d{4})[/-](\d{1,2})[/-](\d{1,2})\b/.exec(value);
  if (!match) return undefined;
  const [, year, month, day] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_.:-]/gu, ' ')
    .split(/\s+/)
    .flatMap((token) => token.split(/(?=[._:-])|(?<=[._:-])/g))
    .map((token) => token.replace(/^[._:-]+|[._:-]+$/g, ''))
    .filter((token) => token.length >= 2)
    .slice(0, 128);
}

function keywordScore(queryTokens: string[], content: string): number {
  if (queryTokens.length === 0) return 0;
  const contentTokens = new Set(tokenize(content));
  const hits = queryTokens.filter((token) => contentTokens.has(token)).length;
  return hits / queryTokens.length;
}

function normalizeSearchContent(memory: ReplayEvaluationMemory): string {
  const searchContent = memory.searchContent?.trim();
  return searchContent && searchContent.length > 0 ? searchContent : memory.content;
}

function vectorize(text: string, dimensions = 64): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const token of tokenize(text)) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    vector[Math.abs(hash) % dimensions] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

function cosine(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < length; i += 1) dot += a[i] * b[i];
  return Math.max(0, Math.min(1, dot));
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

class ReplayEventStore {
  readonly events: MemoryEvent[];
  private readonly byId: Map<string, MemoryEvent>;
  private readonly searchContentById: Map<string, string>;

  constructor(memories: ReplayEvaluationMemory[]) {
    this.events = memories.map((memory, index) => replayMemoryToEvent(memory, index));
    this.byId = new Map(this.events.map((event) => [event.id, event]));
    this.searchContentById = new Map(memories.map((memory) => [
      memory.id,
      normalizeSearchContent(memory)
    ]));
  }

  getSearchContent(eventId: string): string {
    return this.searchContentById.get(eventId) ?? this.byId.get(eventId)?.content ?? '';
  }

  async keywordSearch(query: string, limit = 10): Promise<Array<{ event: MemoryEvent; rank: number }>> {
    const queryTokens = tokenize(query);
    return this.events
      .map((event) => ({ event, score: keywordScore(queryTokens, this.getSearchContent(event.id)) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.event.id.localeCompare(b.event.id))
      .slice(0, limit)
      .map((row, index) => ({
        event: {
          ...row.event,
          content: this.getSearchContent(row.event.id)
        },
        rank: -row.score - index / 1000
      }));
  }

  async getRecentEvents(limit = 100): Promise<MemoryEvent[]> {
    return [...this.events]
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime() || a.id.localeCompare(b.id))
      .slice(0, limit);
  }

  async getEvent(id: string): Promise<MemoryEvent | null> {
    return this.byId.get(id) ?? null;
  }

  async getSessionEvents(sessionId: string): Promise<MemoryEvent[]> {
    return this.events
      .filter((event) => event.sessionId === sessionId)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime() || a.id.localeCompare(b.id));
  }

  async getHelpfulnessStats(): Promise<{ avgScore: number; totalEvaluated: number; totalRetrievals: number; helpful: number; neutral: number; unhelpful: number }> {
    return { avgScore: 0, totalEvaluated: 0, totalRetrievals: 0, helpful: 0, neutral: 0, unhelpful: 0 };
  }

  async recordRetrievalTrace(): Promise<void> {
    return undefined;
  }

  async incrementAccessCount(): Promise<void> {
    return undefined;
  }

  async recordRetrieval(): Promise<void> {
    return undefined;
  }
}

class ReplayVectorStore {
  private readonly rows: Array<SearchResult & { vector: number[] }>;

  constructor(events: MemoryEvent[], getSearchContent: (event: MemoryEvent) => string = (event) => event.content) {
    this.rows = events.map((event) => ({
      id: `replay-vector-${event.id}`,
      eventId: event.id,
      content: getSearchContent(event),
      score: 0,
      sessionId: event.sessionId,
      eventType: event.eventType,
      timestamp: event.timestamp.toISOString(),
      vector: vectorize(getSearchContent(event))
    }));
  }

  async search(queryVector: number[], options: { limit?: number; minScore?: number; sessionId?: string } = {}): Promise<SearchResult[]> {
    const limit = options.limit ?? 5;
    const minScore = options.minScore ?? 0;
    return this.rows
      .filter((row) => !options.sessionId || row.sessionId === options.sessionId)
      .map((row) => ({ ...row, score: cosine(queryVector, row.vector) }))
      .filter((row) => row.score >= minScore)
      .sort((a, b) => b.score - a.score || a.eventId.localeCompare(b.eventId))
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        eventId: row.eventId,
        content: row.content,
        score: row.score,
        sessionId: row.sessionId,
        eventType: row.eventType,
        timestamp: row.timestamp
      }));
  }

  async count(): Promise<number> {
    return this.rows.length;
  }
}

class ReplayEmbedder {
  async embed(text: string): Promise<{ vector: number[]; model: string; dimensions: number }> {
    const vector = vectorize(text);
    return { vector, model: 'deterministic-replay-hash', dimensions: vector.length };
  }
}

function replayMemoryToEvent(memory: ReplayEvaluationMemory, index: number): MemoryEvent {
  const sessionId = memory.sourceSessionId ?? 'replay-fixture';
  const timestamp = memory.timestamp
    ? new Date(memory.timestamp)
    : new Date(Date.UTC(2026, 0, 1, 0, 0, index));

  return {
    id: memory.id,
    sessionId,
    eventType: memory.eventType ?? 'agent_response',
    content: memory.content,
    canonicalKey: memory.canonicalKey ?? `replay/${memory.id}`,
    dedupeKey: `replay:${sessionId}:${memory.id}`,
    timestamp,
    metadata: memory.metadata ?? {}
  };
}
