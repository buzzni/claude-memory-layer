# Runtime Resource Efficiency Plan

> **State**: Incubating
> **Suggested release**: Patch for telemetry/fast path; later minor only if broker approved

## Packet 1 — Instrumentation

1. Define privacy-safe lifecycle counters/timings.
2. Instrument load, use, idle release, disposal, and failure paths.
3. Add deterministic fake-clock/resource tests.
4. Expose aggregate CLI/dashboard status where supported.

## Packet 2 — Fast-path audit

1. Inventory stats/status/fast retrieval compositions.
2. Add tests that fail if an embedder loads.
3. Remove accidental initialization without changing semantic behavior.

## Packet 3 — Field measurement

1. Collect representative multi-client process/RSS/model lifecycle samples.
2. Separate current-version clients, legacy clients, daemon, and actual orphans.
3. Quantify duplicate-model RSS and cold-load cost.

## Packet 4 — Decision

- If the gate is not met, record a no-broker ADR and continue idle-release tuning.
- If met, write a separate broker ADR/spec and prototype the smallest local-only design. Do not merge the prototype solely because it runs.

## Suggested commits

- `feat(runtime): expose embedding resource telemetry`
- `perf(runtime): keep non-semantic paths model-free`

## Progress

No implementation started; measurement schema is the next action.
