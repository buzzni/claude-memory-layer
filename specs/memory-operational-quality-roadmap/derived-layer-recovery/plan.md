# Derived-layer Recovery Plan

> **State**: Ready after read-only diagnostics
> **Suggested release**: Minor

## Packet 1 — Descriptor and audit

1. Define audit states, descriptor, report, and privacy-safe presenters.
2. Register vector layer first; avoid speculative abstractions for unused layers.
3. Add human/JSON read-only audit and invariance tests.

## Packet 2 — Rebuild engine

1. Add deterministic dry-run planning.
2. Reuse lock and disk helpers from maintenance.
3. Build into a unique sibling, verify, preserve rollback, and atomically activate.
4. Add success, verification failure, interruption, disk, lock, version, and exclusion tests.

## Packet 3 — Quarantine and health

1. Reconcile quarantine only after verified coverage.
2. Add state-specific health remediation.
3. Preserve legacy report fields or version output explicitly.

## Likely files

- create `src/core/layers/derived-layer.ts`, registry, and vector adapter,
- create `src/apps/cli/layer-command.ts`,
- modify vector/outbox/health components and focused tests.

## Rollout

1. Merge and release.
2. Run fresh-install smoke.
3. With explicit approval, audit/dry-run opaque canary `6ab6d837`.
4. Approve apply separately; record aggregate before/after and rollback result.

## Suggested commits

- `feat(layers): add derived layer audit contract`
- `feat(vectors): add verified derived index rebuild`
- `fix(health): distinguish quarantine and rebuild guidance`

## Progress

No implementation started.
