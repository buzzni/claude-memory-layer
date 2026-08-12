# SessionStart Experiment Plan

> **State**: Blocked by entry gates
> **Suggested release**: Patch after evidence

## Entry gates

- Retrieval telemetry acceptance is complete and field-tested.
- Expanded replay benchmark is enforced.
- Required sample size/duration and promotion thresholds are approved.

## Packet 1 — Experiment design

1. Refresh current Claude/Codex SessionStart output and constraints.
2. Freeze control and variant format/version definitions.
3. Define deterministic cohort and analysis plan.

## Packet 2 — Flagged implementation

1. Add assignment, override, and kill switch.
2. Implement variants without changing default.
3. Record delivery/trace metadata and add formatting tests.

## Packet 3 — Field evaluation

1. Run for the approved duration/sample.
2. Compare quality, navigation, cost, latency, and continuation metrics.
3. Record promote/retain/redesign decision.
4. Promote separately with rollback monitoring if approved.

## Suggested commits

- `feat(hooks): add measured session-start variants`
- after evidence: `feat(hooks): promote measured session-start format`

## Progress

Blocked; do not implement variants yet.
