# SessionStart Experiment Specification

> **Status**: Incubating; implementation blocked by telemetry and benchmark gates

## Requirements

### SSE-001 — Deterministic assignment

Eligible sessions receive a stable variant assignment. Assignment must not expose session ids and must support environment/config override for testing.

### SSE-002 — Safe default and rollback

Current behavior remains the default/control until promotion. A kill switch restores control without schema rollback.

### SSE-003 — Comparable delivery

Each variant records version, presentation mode, delivered item/character/token estimates, and trace linkage using the accepted telemetry model.

### SSE-004 — Outcome measures

Compare reference opens, first-question relevance, continuation, re-ask, prompt-lane usefulness, latency, and delivery cost. Do not select a winner from overlap alone.

### SSE-005 — Promotion

Promotion requires enough sessions/time for stable comparison, no benchmark regression, user-prompt unhelpful at or below the accepted threshold, material startup reduction, and no meaningful continuation regression.

## Acceptance

- Assignment is deterministic and tested across supported runtimes.
- Control output remains byte/semantically compatible as defined at implementation time.
- Kill switch and forced-variant paths work.
- Reports separate variants and presentation modes.
- Promotion decision and rollback criteria are recorded.

## Non-goals

- changing question-time retrieval ranking,
- deleting SessionStart context based only on current helpfulness,
- uncontrolled online learning of prompt format.
