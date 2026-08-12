# Recoverable Project GC Specification

> **Status**: Ready after read-only diagnostics

## Requirements

### PGC-001 — Classification

Classify stores as skeleton, empty, tiny, meaningful, busy, unreadable, or ineligible. Empty and tiny are distinct; tiny is retained by default.

### PGC-002 — Candidate proof

A candidate must pass exact-root, symlink, minimum-age, registry, lock/process, canonical rows, governance rows, and outbox checks. Unknown or failed checks retain the store.

### PGC-003 — Dry-run report

Report opaque identity, classification/reason, age bucket, aggregate row counts, and reclaimable bytes without transcript or private path disclosure. Dry-run performs zero mutations.

### PGC-004 — Recoverable apply

Explicit apply atomically moves the exact candidate to a dedicated same-filesystem quarantine and writes a durable manifest containing original/quarantine identity, timestamp, integrity metadata, and state.

### PGC-005 — Restore and recovery

Restore is idempotent, rejects occupied/conflicting destinations, and validates the manifest. Interrupted move/manifest sequences must be detectable and recoverable.

### PGC-006 — Purge separation

Permanent purge requires a retention interval, explicit target/confirmation, audit output, and a separate command or mode. It cannot be automatic maintenance behavior.

## Acceptance

- Governance-only, referenced, busy, symlinked, unreadable, and tiny stores are retained.
- Apply moves only exact eligible candidates inside temporary HOME.
- Restore reproduces identity/content and unrelated stores remain unchanged.
- Interrupted quarantine is recoverable.
- Purge cannot run before its policy/confirmation gate.
- Public-output privacy and filesystem-boundary tests pass.

## Non-goals

- deduplicating or merging stores,
- deleting canonical events,
- automatic scheduled cleanup,
- deciding project identity semantics beyond the shared resolver.
