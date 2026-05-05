export interface ReplayMetricInput {
  queryId: string;
  expectedIds: string[];
  retrievedIds: string[];
  /** Optional graded qrels labels. Missing expected ids default to relevance 1. */
  expectedRelevance?: Record<string, number>;
}

export interface PrecisionRecallAtK {
  precision: number;
  recall: number;
  hits: number;
  ndcg: number;
}

export interface ReplayQueryMetrics {
  queryId: string;
  at: Record<number, PrecisionRecallAtK>;
}

export interface ReplayMetricsSummary {
  queryCount: number;
  precisionAtK: Record<number, number>;
  recallAtK: Record<number, number>;
  ndcgAtK: Record<number, number>;
}

export function computePrecisionRecallAtK(
  inputs: ReplayMetricInput[],
  ks: number[]
): ReplayQueryMetrics[] {
  const normalizedKs = normalizeKs(ks);
  return inputs.map((input) => {
    const expected = new Set(input.expectedIds);
    const relevance = normalizeRelevance(input.expectedIds, input.expectedRelevance);
    const at: Record<number, PrecisionRecallAtK> = {};

    for (const k of normalizedKs) {
      const retrieved = input.retrievedIds.slice(0, k);
      const hits = new Set(retrieved.filter((id) => expected.has(id))).size;
      at[k] = {
        precision: k === 0 ? 0 : hits / k,
        recall: expected.size === 0 ? 0 : hits / expected.size,
        hits,
        ndcg: computeNdcgAtK(retrieved, relevance, k)
      };
    }

    return { queryId: input.queryId, at };
  });
}

export function summarizeReplayMetrics(
  metrics: ReplayQueryMetrics[],
  ks: number[]
): ReplayMetricsSummary {
  const normalizedKs = normalizeKs(ks);
  const precisionAtK: Record<number, number> = {};
  const recallAtK: Record<number, number> = {};
  const ndcgAtK: Record<number, number> = {};

  for (const k of normalizedKs) {
    precisionAtK[k] = average(metrics.map((metric) => metric.at[k]?.precision ?? 0));
    recallAtK[k] = average(metrics.map((metric) => metric.at[k]?.recall ?? 0));
    ndcgAtK[k] = average(metrics.map((metric) => metric.at[k]?.ndcg ?? 0));
  }

  return { queryCount: metrics.length, precisionAtK, recallAtK, ndcgAtK };
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

function normalizeRelevance(expectedIds: string[], expectedRelevance?: Record<string, number>): Record<string, number> {
  const relevance: Record<string, number> = {};
  for (const id of expectedIds) {
    const raw = expectedRelevance?.[id] ?? 1;
    relevance[id] = Number.isFinite(raw) ? Math.max(0, raw) : 0;
  }
  return relevance;
}

function computeNdcgAtK(retrieved: string[], relevance: Record<string, number>, k: number): number {
  if (k <= 0) return 0;

  const seen = new Set<string>();
  const dcg = retrieved.reduce((sum, id, index) => {
    if (seen.has(id)) return sum;
    seen.add(id);
    return sum + discountedGain(relevance[id] ?? 0, index);
  }, 0);

  const idealRelevance = Object.values(relevance).sort((a, b) => b - a).slice(0, k);
  const idealDcg = idealRelevance.reduce((sum, rel, index) => sum + discountedGain(rel, index), 0);
  return idealDcg === 0 ? 0 : dcg / idealDcg;
}

function discountedGain(relevance: number, zeroBasedRank: number): number {
  if (relevance <= 0) return 0;
  return (2 ** relevance - 1) / Math.log2(zeroBasedRank + 2);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
