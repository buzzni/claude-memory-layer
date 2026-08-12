# Retrieval Benchmark Expansion Context

> **Status**: Ready
> **Parent**: [`../spec.md`](../spec.md)

## Problem

The existing anonymized replay fixture has 4 queries and 7 memories. LongMemEval retrieval smoke has 1 query and 2 memories. Current replay metrics—Precision@1 about 0.667, Recall@1 about 0.333, MRR about 0.833, no-match accuracy 1.0, forbidden hits 0—are useful smoke signals but too small to approve ranking or retrieval-phase refactors.

One hook-policy case misses the expected top result. More importantly, the fixture lacks enough categories and negatives to reveal whether aggregate gains hide regressions.

## Existing infrastructure

- `scripts/replay-retrieval-benchmark.ts`
- `scripts/generate-session-qrels.ts`
- `scripts/promote-retrieval-review-queue.ts`
- `scripts/validate-replay-promotion-candidates.ts`
- `benchmarks/replay/`
- `scripts/longmemeval-*.ts`
- `benchmarks/longmemeval/`

## Data boundary

Only reviewed anonymized fixtures are committed. Generation input may use local sessions, but committed data and reports must not contain secrets, personal identity, private absolute paths, or raw transcripts not explicitly approved for the fixture.
