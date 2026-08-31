# Memory Usage Improvements — 2026-08-31 Audit Specification Set

Status: Proposed

Baseline date: 2026-08-31

Target release: post-2.3.2 incremental releases

## Purpose

This specification set turns the local project-memory audit into six implementation-ready workstreams. The ordering is intentional: restore trustworthy read behavior first, then improve routing and retrieval, then reduce storage growth and calibrate the measurements used to judge the system.

## Audit baseline

The specifications use the following read-only observations as their baseline:

| Signal | Baseline |
|---|---:|
| Project SQLite stores checked | 147; all passed `PRAGMA quick_check` |
| Stores scanned by project-scope audit, including global | 148 |
| Workspace-scoped stores | 37 |
| Workspace events | 110,579 |
| Retrieval traces / traces selecting memory | 8,441 / 7,525 (89.1%) |
| Context-pack traces / traces selecting memory | 271 / 222 (81.9%) |
| Workspace stores with context-pack traces | 6 / 37 |
| Seven-day correctly scoped sessions | 216 / 221 |
| Seven-day mismatched sessions / events | 3 / 1,818 |
| Total memory-root disk usage | about 5.9 GiB |
| Per-project vector directories | about 3.76 GiB |
| Stale runtime resource snapshots | 55 / 55 |
| Adherence state files older than seven days | 1,255 / 1,506 |

Two failures were reproducible through the active MCP runtime while the same 2.3.2 local CLI and the canonical SQLite files remained healthy:

- `mem-context-pack` with `refreshLatest: false` returned `attempt to write a readonly database`.
- `mem-stats` reported healthy project stores as `corrupt`.

These are treated as runtime/read-path defects, not evidence of canonical-store corruption.

## Specifications

| ID | Specification | Priority | Depends on |
|---|---|---|---|
| MU-01 | [MCP read-only reliability](01-mcp-read-only-reliability.md) | P0 | none |
| MU-02 | [Project scope and bootstrap convergence](02-project-scope-and-bootstrap.md) | P1 | MU-01 for MCP validation |
| MU-03 | [Retrieval-quality recovery](03-retrieval-quality-recovery.md) | P1 | MU-01, MU-02 |
| MU-04 | [Vector storage maintenance](04-vector-storage-maintenance.md) | P1 | MU-01 |
| MU-05 | [Retention and ephemeral-state cleanup](05-retention-and-state-cleanup.md) | P2 | MU-04 telemetry shape |
| MU-06 | [Usefulness telemetry calibration](06-usefulness-telemetry-calibration.md) | P2 | MU-01, MU-03 evaluation corpus |

## Cross-cutting invariants

Every implementation in this set MUST preserve these invariants:

1. SQLite events and their source references remain the canonical evidence layer.
2. A read-only operation MUST NOT create, migrate, checkpoint, or otherwise modify canonical project storage.
3. Project-scoped reads MUST fail closed on ambiguous or foreign scope.
4. Aggregate diagnostics MUST NOT expose raw prompts, responses, credentials, or unsanitized absolute paths.
5. Cleanup and repair are dry-run by default. State-changing execution requires an explicit apply flag and an exact project or resource scope.
6. Vector data is rebuildable acceleration; deletion or compaction MUST NOT delete its canonical SQLite evidence.
7. New telemetry MUST have bounded cardinality and MUST NOT persist raw query content unless the existing privacy sanitizer is applied.

## Delivery gates

### Gate A — Read trust

- MU-01 acceptance tests pass in CLI and MCP environments.
- MCP and CLI report the same store status and aggregate event counts.

### Gate B — Scope and retrieval

- Seven-day correctly scoped sessions are at least 99% with zero new mismatch events in the last 24 hours.
- The targeted weak project replay meets the MU-03 thresholds without a cross-project hit.

### Gate C — Storage safety

- Compaction preview and apply are observable and lock-safe.
- Retention remains preview-only until vector and source-reference protection tests pass.

### Gate D — Measurement quality

- Usefulness fixtures demonstrate that positive, neutral, negative, and unknown outcomes are separable.
- Dashboards do not display an unmeasured value as zero or as a measured neutral score.

## Validation commands

The exact focused test files are listed in each specification. Every workstream also runs:

```bash
npm run build
npm run eval:retrieval-replay
```

Changes affecting import boundaries additionally run:

```bash
node scripts/check-import-boundaries.mjs
```

## Rollout order

1. Ship MU-01 independently and verify the MCP runtime.
2. Ship MU-02 diagnostics and bootstrap checks before applying any historical repair.
3. Build the MU-03 replay corpus, then tune retrieval behind project-scoped configuration.
4. Ship MU-04 preview and observability first; enable bounded compaction in a later release.
5. Ship MU-05 preview and ephemeral cleanup separately from canonical retention apply.
6. Dual-write MU-06 telemetry, compare old and new metrics, then switch dashboards.

No historical store merge, vector deletion, retention mutation, or state-file deletion is authorized merely by these specifications.
