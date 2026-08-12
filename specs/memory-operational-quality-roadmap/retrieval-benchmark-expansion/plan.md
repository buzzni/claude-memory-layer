# Retrieval Benchmark Expansion Plan

> **State**: Ready
> **Suggested release**: Test/CI change before retrieval behavior work

## Packet 1 — Schema and privacy

1. Confirm category, qrel, forbidden, no-match, and provenance schema.
2. Strengthen promotion privacy validation with positive and negative tests.
3. Preserve deterministic evaluator behavior.

## Packet 2 — Curate corpus

1. Sample diverse local session shapes without committing raw source material.
2. Generate candidates, anonymize, and manually review labels.
3. Reach at least 50 accepted queries with category balance.
4. Record rejected candidates/reasons outside public fixture content where necessary.

## Packet 3 — Baseline and CI

1. Run repeated deterministic baselines.
2. Record category metrics and accepted thresholds.
3. Wire smoke/full/scheduled tiers.
4. Test that a regression fails the appropriate gate.

## Suggested commits

- `test(retrieval): harden replay fixture privacy gate`
- `test(retrieval): expand anonymized session replay corpus`
- `ci(retrieval): enforce category-aware replay gates`

## Progress

No implementation started.
