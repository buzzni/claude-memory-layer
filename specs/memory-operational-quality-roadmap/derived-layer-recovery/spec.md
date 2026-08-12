# Derived-layer Recovery Specification

> **Status**: Ready after read-only diagnostics

## Requirements

### DLR-001 — Descriptor contract

A typed derived-layer descriptor declares name/version, canonical inputs, derived outputs, audit, rebuild, and verification. Exact API is implementation-owned; these concepts are mandatory.

### DLR-002 — Read-only audit

`layer audit` or equivalent reports healthy, missing, stale, corrupt, version-mismatched, quarantined, and unreadable states without creating/migrating storage. Output includes aggregate expected/indexed counts, embedding version, and outbox categories.

### DLR-003 — Rebuild plan

Dry-run reports deterministic inputs/exclusions, target version, estimated work/space, locks, and rollback reserve. It must not initialize a replacement layer.

### DLR-004 — Verified rebuild

Apply acquires a project lock, performs conservative disk preflight, builds into a unique sibling location, verifies counts and deterministic sample queries, preserves rollback state, then atomically activates.

### DLR-005 — Quarantine reconciliation

Quarantine rows are reconciled only after the verified replacement contains their canonical inputs or an audited exclusion policy intentionally omits them.

### DLR-006 — State-specific health

Health distinguishes pending/retryable, stuck, quarantined-only, corruption, version mismatch, disk block, and healthy states, with the correct next safe command for each.

## Acceptance

- Audit is filesystem invariant.
- Verification failure leaves the active layer untouched.
- Interrupted rebuild retains canonical data and a recoverable active/rollback layer.
- Version mismatch, exclusions, disk pressure, and lock contention are tested.
- Quarantine is not cleared before verification.
- Canary audit/rebuild/rollback is documented separately from code completion.

## Non-goals

- automatic whole-layer rebuild during maintenance,
- canonical event repair,
- perpetual retry of quarantined jobs,
- generalized storage plugin framework beyond proven derived layers.
