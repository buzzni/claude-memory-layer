# Retrieval Telemetry Plan

> **State**: Ready
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

- attribution window and trace precedence,
- whether citation use is directly observable or inferred,
- schema columns versus versioned metadata.

## Suggested commit

`feat(telemetry): measure reference navigation separately`

## Progress

No implementation started.
