/**
 * Rank fusion and reranking primitives for the offline ranking evaluation
 * (scripts/evaluate-rank-fusion.ts, the hook-path grounding replay). Nothing in
 * the production ranking path calls these.
 */

/** Relevance of each document to the query, higher is better (a cross-encoder's logits). */
export type RerankScorer = (query: string, documents: string[]) => Promise<number[]>;

/** Hindsight and the original RRF paper both use k = 60. */
export const RRF_K = 60;

/**
 * Reciprocal rank fusion: each lane adds 1 / (k + rank) for the ids it ranked,
 * so only ranks matter and lanes on different score scales combine without
 * calibration. Ties keep the order in which ids first appear across the lanes.
 */
export function reciprocalRankFusion(lanes: string[][], k: number = RRF_K): string[] {
  const fused = new Map<string, number>();
  for (const lane of lanes) {
    const seen = new Set<string>();
    let rank = 0;
    for (const id of lane) {
      if (seen.has(id)) continue;
      seen.add(id);
      rank += 1;
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + rank));
    }
  }
  const order = [...fused.keys()];
  return order
    .map((id, index) => ({ id, index, score: fused.get(id)! }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ id }) => id);
}

/**
 * Reorder the first `scores.length` ids by score (highest first); the rest
 * keep their place after them. A reranker scores only the head of a list.
 */
export function rerankHead(ids: string[], scores: number[]): string[] {
  if (scores.length > ids.length) throw new Error(`${scores.length} scores for ${ids.length} ids`);
  const head = ids.slice(0, scores.length)
    .map((id, index) => ({ id, index, score: scores[index] }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ id }) => id);
  return [...head, ...ids.slice(scores.length)];
}
