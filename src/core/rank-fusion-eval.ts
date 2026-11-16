/**
 * Aggregates for the offline ranking-arm comparison (scripts/evaluate-rank-fusion.ts):
 * per-arm qrels metrics, the paired difference against a baseline arm, and
 * latency percentiles. Inputs are ranked fixture ids, so reports carry no text.
 */
import { computePrecisionRecallAtK } from './retrieval-benchmark.js';

export interface RankArmQuery {
  queryId: string;
  expectedIds: string[];
  expectedRelevance?: Record<string, number>;
}

/** Ranked fixture ids per arm, for one query. */
export type RankArmRun = Record<string, string[]>;

export interface PairedDifference {
  mean: number;
  /** 95% percentile bootstrap interval over queries. */
  ci: [number, number];
}

export interface RankArmMetrics {
  recallAtK: Record<number, number>;
  ndcgAtK: Record<number, number>;
  hitAtK: Record<number, number>;
  mrr: number;
  vsBaseline?: {
    recallAtK: Record<number, PairedDifference>;
    ndcgAtK: Record<number, PairedDifference>;
  };
}

export interface RankArmSummary {
  queryCount: number;
  baseline: string;
  arms: Record<string, RankArmMetrics>;
}

export interface LatencySummary {
  n: number;
  p50: number | null;
  p90: number | null;
  max: number | null;
  mean: number | null;
}

const DEFAULT_BOOTSTRAP_SAMPLES = 2000;
const BOOTSTRAP_SEED = 141;

interface QueryScores {
  recall: Record<number, number>;
  ndcg: Record<number, number>;
  hit: Record<number, number>;
  reciprocalRank: number;
}

export function summarizeRankArms(
  queries: RankArmQuery[],
  runs: RankArmRun[],
  options: { ks: number[]; baseline: string; bootstrapSamples?: number }
): RankArmSummary {
  if (runs.length !== queries.length) throw new Error(`${queries.length} queries but ${runs.length} runs`);
  if (runs.some((run) => !run[options.baseline])) throw new Error(`every run needs the baseline arm ${options.baseline}`);
  const armNames = [...new Set(runs.flatMap((run) => Object.keys(run)))];
  const perArm = new Map(armNames.map((arm) => [arm, scoreArm(queries, runs.map((run) => run[arm] ?? []), options.ks)]));
  const baseline = perArm.get(options.baseline)!;

  const arms: Record<string, RankArmMetrics> = {};
  for (const arm of armNames) {
    const scores = perArm.get(arm)!;
    const metrics: RankArmMetrics = {
      recallAtK: averageAtK(scores, options.ks, (row) => row.recall),
      ndcgAtK: averageAtK(scores, options.ks, (row) => row.ndcg),
      hitAtK: averageAtK(scores, options.ks, (row) => row.hit),
      mrr: average(scores.map((row) => row.reciprocalRank))
    };
    if (arm !== options.baseline) {
      const samples = options.bootstrapSamples ?? DEFAULT_BOOTSTRAP_SAMPLES;
      const paired = (pick: (row: QueryScores) => Record<number, number>) => Object.fromEntries(options.ks.map((k) => [
        k,
        pairedBootstrap(scores.map((row, i) => pick(row)[k] - pick(baseline[i])[k]), samples)
      ]));
      metrics.vsBaseline = { recallAtK: paired((row) => row.recall), ndcgAtK: paired((row) => row.ndcg) };
    }
    arms[arm] = metrics;
  }
  return { queryCount: queries.length, baseline: options.baseline, arms };
}

/**
 * Every arm cut to the length of the baseline's list for the same query. The
 * production retriever filters and abstains, so its lists are short; at equal
 * length the arms differ only in which candidates they put first.
 */
export function truncateToBaseline(runs: RankArmRun[], baseline: string): RankArmRun[] {
  return runs.map((run) => {
    const budget = run[baseline]?.length ?? 0;
    return Object.fromEntries(Object.entries(run).map(([arm, ids]) => [arm, ids.slice(0, budget)]));
  });
}

/** Nearest-rank percentiles, in the unit of the samples. */
export function latencySummary(values: number[]): LatencySummary {
  if (values.length === 0) return { n: 0, p50: null, p90: null, max: null, mean: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  return { n: sorted.length, p50: at(0.5), p90: at(0.9), max: sorted.at(-1)!, mean: average(sorted) };
}

function scoreArm(queries: RankArmQuery[], rankings: string[][], ks: number[]): QueryScores[] {
  const metrics = computePrecisionRecallAtK(queries.map((query, i) => ({
    queryId: query.queryId,
    expectedIds: query.expectedIds,
    expectedRelevance: query.expectedRelevance,
    retrievedIds: rankings[i]
  })), ks);
  return metrics.map((metric, i) => {
    const expected = new Set(queries[i].expectedIds);
    const firstHit = rankings[i].findIndex((id) => expected.has(id));
    return {
      recall: Object.fromEntries(ks.map((k) => [k, metric.at[k].recall])),
      ndcg: Object.fromEntries(ks.map((k) => [k, metric.at[k].ndcg])),
      hit: Object.fromEntries(ks.map((k) => [k, metric.at[k].hits > 0 ? 1 : 0])),
      reciprocalRank: firstHit < 0 ? 0 : 1 / (firstHit + 1)
    };
  });
}

function averageAtK(rows: QueryScores[], ks: number[], pick: (row: QueryScores) => Record<number, number>): Record<number, number> {
  return Object.fromEntries(ks.map((k) => [k, average(rows.map((row) => pick(row)[k]))]));
}

/** Mean of paired per-query differences with a seeded 95% percentile bootstrap interval. */
export function pairedBootstrap(diffs: number[], samples: number = DEFAULT_BOOTSTRAP_SAMPLES): PairedDifference {
  const random = mulberry32(BOOTSTRAP_SEED);
  const means: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    let sum = 0;
    for (let i = 0; i < diffs.length; i++) sum += diffs[Math.floor(random() * diffs.length)];
    means.push(sum / diffs.length);
  }
  means.sort((a, b) => a - b);
  return { mean: average(diffs), ci: [means[Math.floor(samples * 0.025)], means[Math.floor(samples * 0.975)]] };
}

/** Deterministic PRNG so the bootstrap interval is reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
