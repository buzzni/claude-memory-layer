# Retrieval Telemetry Context

> **Status**: Ready
> **Parent**: [`../spec.md`](../spec.md)

## Problem

The dated 24-hour aggregation showed SessionStart average helpfulness around 0.412 with 60.1% classified unhelpful, versus UserPromptSubmit around 0.559 with roughly 2.8% unhelpful. This cannot directly justify reducing SessionStart because the current score favors response/content overlap and behavioral continuation.

A compact reference index succeeds when it helps an agent locate and open evidence. Its text may never appear in the final response. Reference navigation therefore needs different signals from directly injected evidence.

## Existing surfaces

- `src/core/engine/retrieval-analytics-service.ts`
- `src/core/engine/retrieval-orchestrator.ts`
- `src/core/sqlite-event-store.ts`
- MCP source-ref/details/expand handlers
- dashboard stats/usefulness API and UI

## Boundaries

- This feature measures behavior; it does not change SessionStart variants.
- Benchmark quality belongs to [`../retrieval-benchmark-expansion/`](../retrieval-benchmark-expansion/).
- SessionStart promotion belongs to [`../session-start-experiment/`](../session-start-experiment/).
- Existing rows remain readable and are labeled legacy/unknown rather than rewritten.
