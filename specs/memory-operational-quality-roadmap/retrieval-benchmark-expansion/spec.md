# Retrieval Benchmark Expansion Specification

> **Status**: Ready

## Requirements

### RBE-001 — Corpus breadth

Create at least 50 reviewed labeled queries spanning continuation, incident diagnosis, architectural decision recall, file/symbol recall, and negative/no-match. Aim for 50-100 before approving ranking changes.

### RBE-002 — Judgments

Each case declares positive ids, forbidden ids, explicit no-match expectation where applicable, category, and review provenance. Multiple relevant memories and graded relevance are supported where useful.

### RBE-003 — Privacy gate

Fixture generation and promotion run credential/path/identity/privacy validation. Failure blocks commit/promotion. Reports default to identifiers and aggregates.

### RBE-004 — Metrics

Report Precision@k, Recall@k, nDCG@k, Hit@k, MRR, no-match accuracy, forbidden hits, failed queries, query yield, and category breakdown. Token/injection cost may be added without weakening quality gates.

### RBE-005 — CI tiers

- every PR: deterministic smoke,
- retrieval/injection change: full anonymized replay,
- scheduled/manual: larger LongMemEval or provider-assisted evaluation.

### RBE-006 — Promotion gate

Initial hard gates are no-match accuracy 100%, forbidden hits 0, failed queries 0, and no accepted-baseline MRR/Hit@3 regression. Category failures cannot be hidden by aggregate averages; baseline changes require reviewed rationale.

## Acceptance

- At least 50 privacy-approved labeled queries exist.
- All required categories include positive and negative coverage where applicable.
- A deliberately leaked credential/path fixture is rejected by tests.
- CI selects the correct tier for retrieval-affecting changes.
- Accepted baseline and update procedure are documented.

## Non-goals

- claiming broad LongMemEval quality from the smoke fixture,
- automatically accepting generated labels,
- optimizing rankings as part of dataset construction.
