# MU-04: Vector Storage Maintenance

Status: Proposed — audit-based

Priority: P1

Primary surfaces: LanceDB, vector status, maintenance runner

## Problem

Per-project vector directories occupy about 3.76 GiB. The largest project directories are measured in gigabytes even when their logical vector counts are much smaller. The write path calls Lance optimization periodically, but optimization is best effort and failures are swallowed. The periodic maintenance runner currently skips a healthy store when no outbox work exists, so it cannot reclaim historical fragments or superseded versions in an otherwise idle store.

## Goals

- Make logical vector count, physical size, fragments, versions, and last compaction observable.
- Reclaim superseded Lance versions with bounded, lock-safe maintenance.
- Detect compaction failures without failing the write that triggered them.
- Preserve vector/search correctness and canonical SQLite evidence.

## Non-goals

- Deleting canonical events.
- Rebuilding every vector table on every maintenance run.
- Running unbounded compaction inside an interactive hook.
- Treating raw directory size alone as proof that data may be deleted.

## Requirements

### Inventory and health

- **VS-001** `vector-status` MUST report logical vector count and outbox health as it does today.
- **VS-002** It SHOULD additionally report aggregate physical bytes, table count, fragment count, version count, and last optimize result when the installed Lance API exposes them.
- **VS-003** Missing provider metrics MUST be represented as `null`/`unsupported`, not zero.
- **VS-004** Health MUST flag abnormal physical amplification using a configurable policy, not a hard-coded project name.
- **VS-005** Reports MUST remain aggregate-only and hide vector content, IDs, queries, and local storage paths.

Proposed additive report:

```ts
interface VectorPhysicalHealth {
  physicalBytes: number | null;
  tableCount: number | null;
  fragmentCount: number | null;
  versionCount: number | null;
  bytesPerLogicalVector: number | null;
  lastOptimizedAt: string | null;
  lastOptimizeOutcome: 'success' | 'failed' | 'unsupported' | 'never';
  amplificationState: 'normal' | 'elevated' | 'critical' | 'unknown';
}
```

### Optimize operation

- **VS-006** `VectorStore.optimizeAll()` MUST return a structured per-table result rather than `void`.
- **VS-007** A write-path optimize failure remains non-fatal to the triggering write but MUST increment a bounded failure counter.
- **VS-008** An explicit maintenance optimize failure MUST be visible as a maintenance error or needs-attention result.
- **VS-009** Optimize MUST use a bounded older-version retention interval and MUST never delete the latest readable version.
- **VS-010** The operation MUST acquire the same project/vector maintenance lock used by outbox work.
- **VS-011** Compaction MUST run out of process from interactive hooks.
- **VS-012** A time or work budget MUST stop the cycle between tables, not in the middle of an unsafe mutation.

Proposed result:

```ts
interface VectorOptimizeResult {
  startedAt: string;
  finishedAt: string;
  supported: boolean;
  tablesScanned: number;
  tablesOptimized: number;
  failures: number;
  beforeBytes: number | null;
  afterBytes: number | null;
  reclaimedBytes: number | null;
  tableResults: Array<{
    tableKind: string;
    outcome: 'optimized' | 'skipped' | 'failed' | 'unsupported';
    safeErrorCode?: string;
  }>;
}
```

Table names MUST be normalized to a bounded kind/version label before public output.

### Preview and apply

- **VS-013** Add `vector compact` or an equivalent maintenance subcommand with dry-run preview by default.
- **VS-014** Preview MUST NOT call Lance optimize or modify version metadata.
- **VS-015** Apply MUST require `--apply` and one explicit project unless invoked by bounded scheduled maintenance.
- **VS-016** Preview SHOULD report eligibility reasons: age, amplification, fragment/version count, prior failure, and last optimized time.
- **VS-017** Apply MUST capture pre/post logical counts and perform a read/search smoke check.
- **VS-018** If the post-check fails, the command MUST report failure and preserve canonical SQLite/outbox data for rebuild. It MUST NOT delete SQLite evidence.

### Scheduled maintenance

- **VS-019** The runner MUST inspect vector-compaction eligibility even when pending/retryable/stuck outbox counts are zero.
- **VS-020** Compaction eligibility MUST be separately configurable from embedding processing.
- **VS-021** A cycle MUST cap projects, tables, elapsed time, and minimum free disk.
- **VS-022** Recent high-traffic stores MAY be deferred when a live worker lock is held.
- **VS-023** Maintenance status version 2 MUST include compacted, reclaimed bytes, compaction failures, and skipped-busy counts.
- **VS-024** Version 1 status remains readable.

Suggested defaults:

| Setting | Default |
|---|---:|
| minimum time between project compactions | 24 hours |
| minimum physical size | 256 MiB |
| elevated bytes/logical-vector | determined from benchmark; no initial hard-coded gate |
| version retention passed to Lance | 1 hour, existing behavior |
| max projects per scheduled cycle | existing maintenance bound |
| max compaction duration per cycle | 10 minutes |

### Tool-observation migration

- **VS-025** The existing one-time tool-observation vector prune flag remains authoritative.
- **VS-026** Status MUST distinguish migration completed from physical space reclaimed.
- **VS-027** The dry-run command MUST not claim a vector will be deleted merely because a canonical tool-observation event exists; it SHOULD estimate actual matching vector rows when supported.
- **VS-028** Re-running a completed migration MUST be idempotent.

## Data and compatibility

- No canonical SQLite event schema change is required.
- Optimize status MAY be stored in `endless_config` or a dedicated bounded maintenance-state file/table.
- The record stores aggregates and safe error codes only.
- Existing `vector-status` JSON fields remain unchanged; physical health is additive.

## Test specification

Required cases:

- optimize supported and reclaims old versions;
- optimize API unsupported;
- one table fails while later tables remain safely processable;
- write-triggered optimize failure does not fail the vector write;
- explicit maintenance failure is visible;
- healthy outbox plus eligible physical store triggers compaction;
- active lock results in busy/skip, not concurrent mutation;
- disk-pressure gate blocks compaction;
- preview performs zero writes;
- logical count and a known search result remain stable after apply;
- legacy maintenance status v1 is readable;
- tool-observation migration status distinguishes completion/reclamation.

Primary files:

- `src/core/vector-store.ts`
- `src/apps/cli/maintenance-runner.ts`
- `src/apps/cli/vector-command.ts`
- `src/core/operations/tool-observation-vector-auto-heal.ts`
- `tests/core/vector-store.test.ts`
- `tests/apps/maintenance-runner.test.ts`
- `tests/apps/vector-command.test.ts`
- `tests/apps/auto-heal-tool-observation-vectors-command.test.ts`

## Observability

Aggregate metrics:

- `vector_physical_bytes{project_bucket}` only where project labels are already authorized;
- `vector_optimize_total{outcome,trigger}`;
- `vector_optimize_duration_ms{outcome}`;
- `vector_reclaimed_bytes_total`;
- `vector_amplification_state{state}`.

Public surfaces SHOULD prefer per-current-project values and machine-wide totals over high-cardinality project labels.

## Rollout

1. Ship physical inventory and structured optimize results.
2. Run preview against representative large and small stores.
3. Run explicit apply on a disposable copied fixture.
4. Apply to one approved real project and compare search/replay results.
5. Enable scheduled compaction with conservative eligibility.

## Rollback

- Disable scheduled eligibility while retaining status collection.
- Vector data can be rebuilt from SQLite/outbox if Lance maintenance fails.
- Do not roll back by restoring stale vector versions over a newer canonical SQLite state.

## Acceptance criteria

- Large stores expose why their physical size is elevated.
- A completed compaction records before/after bytes and preserves logical count/search behavior.
- Scheduled maintenance no longer ignores eligible idle stores.
- Compaction errors are observable without breaking interactive writes.
- No raw vector content or canonical evidence is deleted.
