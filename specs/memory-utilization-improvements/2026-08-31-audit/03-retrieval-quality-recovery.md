# MU-03: Retrieval-Quality Recovery

Status: Proposed — audit-based

Priority: P1

Initial target: `knoi-desktop`

Primary surfaces: import freshness, retriever, context pack, replay evaluation

## Problem

The audit found strong selection rates in the large Aplus projects but a 31.1% retrieval-trace selection rate in `knoi-desktop`; its five recorded context-pack attempts selected no memory. The vector queue is healthy, so tuning must start by distinguishing missing evidence from scope, freshness, ranking, quality-filter, and threshold failures.

## Goals

- Produce a privacy-safe, reproducible weak-project replay corpus.
- Explain every zero-hit query by a bounded reason taxonomy.
- Raise useful retrieval without increasing cross-project leakage or forced irrelevant results.
- Keep abstention correct when the project truly has no relevant evidence.

## Non-goals

- Tuning only for one hard-coded project path.
- Lowering `minScore` globally without replay evidence.
- Returning low-signal tool observations merely to increase hit rate.
- Using raw private transcripts as committed benchmark fixtures.

## Diagnostic taxonomy

Every retrieval trace SHOULD resolve to one terminal diagnostic reason:

```ts
type RetrievalOutcomeReason =
  | 'selected'
  | 'no_project_events'
  | 'freshness_gap'
  | 'scope_filtered'
  | 'no_keyword_candidates'
  | 'no_vector_candidates'
  | 'stale_vector_schema'
  | 'below_score_threshold'
  | 'quality_filtered'
  | 'session_rescue_empty'
  | 'context_pack_policy_filtered'
  | 'runtime_error';
```

## Requirements

### Baseline and corpus

- **RQ-001** Establish immutable baseline metrics before changing retrieval behavior.
- **RQ-002** The corpus MUST include successful, zero-hit, abstention, Korean, English, mixed-language, continuation, and exact-identifier queries.
- **RQ-003** Committed fixtures MUST be anonymized and MUST preserve relevance labels, not raw local paths or secrets.
- **RQ-004** Each positive query MUST identify one or more relevant session/event IDs in the fixture namespace.
- **RQ-005** Negative queries MUST explicitly label the expected abstention.

Baseline metrics:

- query yield and selected-trace rate;
- Recall@k, Precision@k, MRR, and nDCG;
- no-match accuracy;
- forbidden cross-project hits;
- context-pack selected-memory count;
- latency by cold/hot retrieval path.

### Freshness

- **RQ-006** Diagnostics MUST compare the latest source session timestamp with the latest imported project event without exposing the source path.
- **RQ-007** A freshness gap MUST be reported separately from retrieval failure.
- **RQ-008** Explicit import MUST remain bounded by source, session count, message count, and project path.
- **RQ-009** Read-only prefetch MUST NOT auto-import.
- **RQ-010** Duplicate imports MUST remain idempotent.

### Candidate and ranking diagnostics

- **RQ-011** Trace diagnostics MUST record aggregate candidate counts by keyword, vector, summary, graph, session-rescue, and shared lanes.
- **RQ-012** Trace diagnostics MUST record the final exclusion reason without persisting excluded raw content.
- **RQ-013** Score distributions MUST be observable by strategy and event type.
- **RQ-014** Project scope filtering happens before final selection and cannot be relaxed by fallback.
- **RQ-015** Compaction artifacts and other low-signal context remain filtered.

Proposed trace addition:

```ts
interface RetrievalOutcomeDiagnostics {
  outcomeReason: RetrievalOutcomeReason;
  laneCandidateCounts: Record<string, number>;
  filteredCounts: Record<string, number>;
  topScore: number | null;
  threshold: number;
  freshnessState: 'fresh' | 'stale' | 'unknown';
}
```

The object is bounded and sanitized before persistence.

### Tuning

- **RQ-016** Tuning MUST be configuration- or strategy-scoped, not project-name conditionals.
- **RQ-017** Threshold changes require replay improvement with no forbidden-hit regression.
- **RQ-018** Korean/English query rewrite MAY add normalized alternatives but MUST retain the raw sanitized query for trace comparison.
- **RQ-019** Exact identifiers, error codes, file names, and symbols SHOULD preserve keyword weight.
- **RQ-020** Session-event hybrid rescue MUST not exceed the configured top-K and project scope.
- **RQ-021** Context-pack policy filtering MUST expose why candidates were omitted.
- **RQ-022** A context pack MUST return the recent timeline even when semantic retrieval abstains, unless the store is empty or unavailable.

### Evaluation gates

- **RQ-023** The targeted replay query yield MUST reach at least 70%.
- **RQ-024** Target context-pack positive-query yield MUST reach at least 60%.
- **RQ-025** No-match accuracy MUST remain 100% on the committed negative set.
- **RQ-026** Forbidden cross-project hits MUST remain zero.
- **RQ-027** Existing golden replay thresholds MUST not regress.
- **RQ-028** P95 hot-path latency MUST not regress by more than 20% without an explicit decision record.

## Implementation sequence

1. Add outcome-reason diagnostics without changing ranking.
2. Run bounded latest import and re-baseline.
3. Build anonymized replay fixtures from reviewed query skeletons.
4. Test threshold, rewrite, event-quality, and session-rescue changes independently.
5. Select the smallest change satisfying all gates.
6. Validate context-pack selection separately from raw retriever yield.

## Test specification

Required tests:

- freshness gap vs true no-match;
- vector-empty with keyword fallback;
- keyword-empty with vector match;
- stale vector schema fallback;
- score-threshold exclusion reason;
- quality-filter exclusion reason;
- Korean/English paraphrase retrieval;
- exact symbol/file/error retrieval;
- session-event hybrid sibling rescue;
- cross-project candidate exclusion;
- context-pack timeline-only response;
- anonymized replay CLI report.

Primary files:

- `src/core/retriever.ts`
- `src/core/engine/retrieval-orchestrator.ts`
- `src/extensions/mcp/handlers.ts`
- `scripts/replay-retrieval-benchmark.ts`
- `benchmarks/replay/`
- `tests/core/retriever-fallback-chain.test.ts`
- `tests/core/retriever-strategy-scope.test.ts`
- `tests/extensions/mcp-context-tools.test.ts`

## Observability

Dashboard/API aggregate views SHOULD provide:

- outcome reasons by strategy;
- lane candidate counts;
- threshold cliff distribution;
- freshness state;
- positive yield excluding SessionStart traces;
- context-pack yield separately from ordinary hook retrieval.

Raw query text and event content are excluded from aggregate views.

## Rollout and rollback

- Ship diagnostics first.
- Put behavioral tuning behind a configuration flag or strategy version.
- Compare old/new strategy in offline replay; do not dual-inject memories into live prompts.
- Roll back by selecting the prior strategy version. Trace schema additions remain backward compatible.

## Acceptance criteria

- Every reviewed zero-hit query has a terminal reason.
- Targeted replay meets RQ-023 through RQ-028.
- `knoi-desktop` context packs return relevant evidence for known-positive fixtures.
- No raw project path, secret, or transcript content enters committed fixtures or aggregate telemetry.
