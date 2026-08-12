# SessionStart Experiment Context

> **Status**: Incubating
> **Parent**: [`../spec.md`](../spec.md)

## Why this is gated

SessionStart currently delivers compact context with substantial character savings, but its overlap-oriented helpfulness score looks materially worse than question-time injection. That score is not aligned with reference-index behavior, so changing the default now would be guesswork.

This feature begins only after:

- [`../retrieval-telemetry/`](../retrieval-telemetry/) can measure reference navigation separately,
- [`../retrieval-benchmark-expansion/`](../retrieval-benchmark-expansion/) provides the accepted regression gate.

## Candidate variants

- control: current three-item behavior,
- concise: one summary plus one recent outcome,
- reference: compact reference-only index resolved at question time.

Exact formatting must be refreshed against current Claude and Codex hook implementations before coding.
