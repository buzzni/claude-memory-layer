/**
 * Whether stored vectors came from the embedding model in use now: re-embed
 * their text and compare.
 */

/** How many stored vectors to re-embed for the check. */
export const MODEL_CHECK_SAMPLE = 5;
// Re-embedding the same text with the same model reproduces the vector up to
// float noise; a different model lands far below this.
const SAME_MODEL_MIN_COSINE = 0.999;

export async function producedByCurrentModel(
  embedder: { embed(text: string): Promise<{ vector: number[] }> },
  sample: Array<{ content: string; vector: number[] }>
): Promise<boolean> {
  for (const row of sample) {
    const { vector } = await embedder.embed(row.content);
    if (cosine(vector, row.vector) < SAME_MODEL_MIN_COSINE) return false;
  }
  return true;
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}
