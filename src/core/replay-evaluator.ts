import {
  computePrecisionRecallAtK,
  summarizeReplayMetrics,
  type ReplayMetricsSummary,
  type ReplayQueryMetrics
} from './retrieval-benchmark.js';

export interface ReplayEvaluationQuery {
  queryId: string;
  query: string;
  expectedIds: string[];
  expectedRelevance?: Record<string, number>;
}

export interface ReplayEvaluationMemory {
  id: string;
  content: string;
}

export interface ReplayEvaluationFixtureMetadata {
  sourceFileCount?: number;
  rawContentIncluded?: boolean;
  generatedAt?: string;
}

export interface ReplayEvaluationFixture {
  name: string;
  description?: string;
  ks: number[];
  queries: ReplayEvaluationQuery[];
  memories: ReplayEvaluationMemory[];
  metadata?: ReplayEvaluationFixtureMetadata;
}

export interface ReplayEvaluationOptions {
  generatedAt?: string;
  includePerQuery?: boolean;
  evaluator?: string;
}

export interface ReplayFixtureStats {
  queryCount: number;
  memoryCount: number;
  ks: number[];
  sourceFileCount?: number;
  rawContentIncluded?: boolean;
}

export interface ReplayEvaluationReport {
  name: string;
  description?: string;
  evaluator: string;
  generatedAt: string;
  fixtureStats: ReplayFixtureStats;
  summary: ReplayMetricsSummary;
  perQuery: ReplayQueryMetrics[];
}

export interface ReplayEvaluationMarkdownOptions {
  qrelsPath?: string;
}

export function evaluateReplayFixture(
  fixture: ReplayEvaluationFixture,
  options: ReplayEvaluationOptions = {}
): ReplayEvaluationReport {
  const perQuery = computePrecisionRecallAtK(
    fixture.queries.map((query) => ({
      queryId: query.queryId,
      expectedIds: query.expectedIds,
      expectedRelevance: query.expectedRelevance,
      retrievedIds: rankByTokenOverlap(query.query, fixture.memories).map((memory) => memory.id)
    })),
    fixture.ks
  );

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
    evaluator: options.evaluator ?? 'token-overlap-v1',
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    fixtureStats,
    summary: summarizeReplayMetrics(perQuery, fixture.ks),
    perQuery: options.includePerQuery === false ? [] : perQuery
  };

  if (fixture.description !== undefined) {
    report.description = fixture.description;
  }

  return report;
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
  lines.push('| k | Precision@k | Recall@k | nDCG@k |');
  lines.push('|---:|---:|---:|---:|');

  for (const k of sortedKValues(report.summary)) {
    lines.push(
      `| ${k} | ${formatMetric(report.summary.precisionAtK[k] ?? 0)} | ${formatMetric(report.summary.recallAtK[k] ?? 0)} | ${formatMetric(report.summary.ndcgAtK[k] ?? 0)} |`
    );
  }

  lines.push('');
  lines.push('## Key metrics');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---:|');
  for (const k of sortedKValues(report.summary)) {
    lines.push(`| Precision@${k} | ${formatMetric(report.summary.precisionAtK[k] ?? 0)} |`);
    lines.push(`| Recall@${k} | ${formatMetric(report.summary.recallAtK[k] ?? 0)} |`);
    lines.push(`| nDCG@${k} | ${formatMetric(report.summary.ndcgAtK[k] ?? 0)} |`);
  }

  if (report.perQuery.length > 0) {
    lines.push('');
    lines.push('## Per-query metrics');
    lines.push('');
    lines.push('| queryId | k | hits | Precision@k | Recall@k | nDCG@k |');
    lines.push('|---|---:|---:|---:|---:|---:|');

    for (const query of report.perQuery) {
      const ks = Object.keys(query.at).map(Number).sort((a, b) => a - b);
      for (const k of ks) {
        const metric = query.at[k];
        if (!metric) continue;
        lines.push(
          `| ${escapeMarkdownCell(query.queryId)} | ${k} | ${metric.hits} | ${formatMetric(metric.precision)} | ${formatMetric(metric.recall)} | ${formatMetric(metric.ndcg)} |`
        );
      }
    }
  }

  lines.push('');
  lines.push('> Report intentionally omits raw query and memory text.');
  lines.push('');
  return lines.join('\n');
}

export function rankByTokenOverlap(
  query: string,
  memories: ReplayEvaluationMemory[]
): ReplayEvaluationMemory[] {
  const queryTokens = tokenize(query);
  return [...memories]
    .map((memory) => ({ memory, score: overlap(queryTokens, tokenize(memory.content)) }))
    .sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id))
    .map((row) => row.memory);
}

function sortedKValues(summary: ReplayMetricsSummary): number[] {
  return Object.keys(summary.precisionAtK).map(Number).sort((a, b) => a - b);
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9가-힣\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 2)
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let hits = 0;
  for (const token of Array.from(a)) if (b.has(token)) hits += 1;
  return hits;
}

function formatMetric(value: number): string {
  return value.toFixed(4).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
