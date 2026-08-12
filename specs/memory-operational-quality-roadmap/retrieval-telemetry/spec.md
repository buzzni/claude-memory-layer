# Retrieval Telemetry Specification

> **Status**: Ready

## Requirements

### RTT-001 — Presentation model

Retrieval/delivery records identify presentation and trigger concepts without conflating them. Minimum presentation modes are `evidence`, `reference`, and `core`; minimum triggers include `session_start` and `user_prompt`. Normalize existing fields where possible.

### RTT-002 — Reference navigation

When source-ref/details/expand opens a prior reference, record a privacy-safe linkage only when attribution is deterministic. Store identifiers, trace linkage, timestamps/counts, and outcome classification—not newly copied raw content.

### RTT-003 — Attribution rules

Define bounded time/session windows, multi-injection ambiguity behavior, repeat-open handling, and cross-client behavior. Ambiguous attribution remains unattributed rather than guessed.

### RTT-004 — Source-specific evaluation

Evidence delivery may use grounding/content overlap. Reference delivery cannot be marked unhelpful solely because reference text was not repeated. Reports expose separate evidence-grounding and reference-navigation measures.

### RTT-005 — Migration and privacy

Schema changes are additive and backward compatible. Legacy rows use unknown/legacy values. Public APIs remain aggregate and privacy scans cover new metadata.

## Acceptance

- Evidence, reference, and core deliveries can be reported separately.
- Deterministic reference opens link to the originating trace; ambiguous cases do not.
- Legacy rows and clients remain readable.
- Raw transcript/source output is not duplicated for telemetry.
- Dashboard/API tests demonstrate correct denominators and attribution.

## Non-goals

- selecting a SessionStart winner,
- using an LLM judge as the only usefulness signal,
- storing source contents again,
- cross-project attribution.
