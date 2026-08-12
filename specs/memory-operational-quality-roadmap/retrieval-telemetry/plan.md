# Retrieval Telemetry Plan

> **State**: Implemented; review and rollout evidence pending
> **Suggested release**: Patch/minor behind compatible schema

## Packet 1 — Event model and migration

1. Inventory current source/helpfulness/trace columns and API consumers.
2. Define presentation, trigger, navigation event, and attribution identifiers.
3. Add forward-compatible migration and legacy mapping tests.

## Packet 2 — Navigation instrumentation

1. Instrument source-ref/details/expand paths.
2. Implement fail-closed deterministic attribution.
3. Add duplicate/repeat/ambiguous/session-boundary tests.
4. Verify no new raw content is persisted.

## Packet 3 — Analytics and UI

1. Split evidence grounding from reference navigation.
2. Update aggregate API and dashboard labels/denominators.
3. Add privacy and historical-row regression tests.

## Entry decisions

- Attribution uses a 15-minute lookback. An explicit delivery session, when supplied, is a hard boundary; otherwise the target must match exactly one recent reference trace. Multiple candidates remain `ambiguous`, and no candidate remains `unattributed`.
- Client labels are diagnostic only. Cross-client opens may link to the unique trace, but the client label is never used to guess between traces.
- Repeated opens of the same target/action/client/outcome within the window increment `open_count`; navigation-rate numerators remain distinct attributed traces.
- Citation use is not inferred because it is not directly observable. Only source-ref, details, expand, and source opens are recorded.
- Presentation, trigger, and client use additive typed columns. Navigation uses a separate additive table containing identifiers, timestamps, counts, and classifications only.

## Suggested commit

`feat(telemetry): measure reference navigation separately`

## Progress

- Packet 1: implemented with additive migration and legacy `unknown` mapping.
- Packet 2: implemented for MCP source-ref/details and public CLI/dashboard expand/source paths with fail-closed attribution.
- Packet 3: implemented with separate evidence-grounding and reference-navigation aggregates plus dashboard/API presentation.
- Automated tests cover migration, privacy-safe columns, deterministic/ambiguous/expired/session-bounded attribution, repeat opens, denominators, and legacy rows.
- Remaining before roadmap-level completion: merge, release rollout evidence, and post-rollout measurement. The SessionStart default is unchanged.
