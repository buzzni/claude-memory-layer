export interface ReplayMetricInput {
  queryId: string;
  expectedIds: string[];
  retrievedIds: string[];
}

export interface PrecisionRecallAtK {
  precision: number;
  recall: number;
  hits: number;
}

export interface ReplayQueryMetrics {
  queryId: string;
  at: Record<number, PrecisionRecallAtK>;
}

export interface ReplayMetricsSummary {
  queryCount: number;
  precisionAtK: Record<number, number>;
  recallAtK: Record<number, number>;
}

export function computePrecisionRecallAtK(
  inputs: ReplayMetricInput[],
  ks: number[]
): ReplayQueryMetrics[] {
  const normalizedKs = normalizeKs(ks);
  return inputs.map((input) => {
    const expected = new Set(input.expectedIds);
    const at: Record<number, PrecisionRecallAtK> = {};

    for (const k of normalizedKs) {
      const retrieved = input.retrievedIds.slice(0, k);
      const hits = retrieved.filter((id) => expected.has(id)).length;
      at[k] = {
        precision: k === 0 ? 0 : hits / k,
        recall: expected.size === 0 ? 0 : hits / expected.size,
        hits
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

  for (const k of normalizedKs) {
    precisionAtK[k] = average(metrics.map((metric) => metric.at[k]?.precision ?? 0));
    recallAtK[k] = average(metrics.map((metric) => metric.at[k]?.recall ?? 0));
  }

  return { queryCount: metrics.length, precisionAtK, recallAtK };
}

function normalizeKs(ks: number[]): number[] {
  return [...new Set(ks.map((k) => Math.max(0, Math.floor(k))))].sort((a, b) => a - b);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
