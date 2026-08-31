# MU-05: Retention and Ephemeral-State Cleanup

Status: Proposed — audit-based

Priority: P2

Primary surfaces: retention governance, runtime snapshots, adherence state, temporary stores

## Problem

The memory root contains durable canonical evidence, rebuildable indexes, governance projections, and ephemeral process/session files with different lifecycles. The current retention command is intentionally dry-run only, while runtime snapshots and adherence-state files accumulate. Applying one deletion rule to all of these layers would be unsafe; leaving every layer unbounded also creates operational debt.

## Goals

- Define separate lifecycle policies for canonical, rebuildable, governance, and ephemeral data.
- Add safe cleanup for unambiguously stale ephemeral files.
- Keep canonical retention as reviewed lifecycle mutation before any physical deletion.
- Make every cleanup previewable, scoped, auditable, and recoverable where practical.

## Non-goals

- Hard-deleting canonical events in the first implementation.
- Deleting a project store because its path no longer exists.
- Treating low retrieval count as proof that evidence has no value.
- Cleaning files outside the CML-owned memory root.

## Data classes

| Class | Examples | Authority | Initial action ceiling |
|---|---|---|---|
| Canonical evidence | events, source refs, governance audit | SQLite | lifecycle mark only |
| Durable projections | lessons, actions, checkpoints, actor cards | SQLite | review/downgrade/quarantine |
| Rebuildable acceleration | Lance vectors, derived indexes | vectors/SQLite outbox | compact/rebuild |
| Ephemeral runtime | `runtime-resources/process-*.json` | files | delete when process identity is stale |
| Ephemeral adherence | `.adherence-state-*.json` | files | delete after terminal/age checks |
| Temporary project stores | test/e2e/temp identities | project store | quarantine candidate; no automatic delete initially |
| Unattributed stores | no project path/identity | project store | investigation only |

## Requirements

### Policy and preview

- **RT-001** Every cleanup policy MUST declare target class, minimum age, liveness check, protection checks, action, and recovery mode.
- **RT-002** All commands MUST default to dry-run.
- **RT-003** Preview MUST report aggregate counts and bytes plus bounded sanitized samples.
- **RT-004** Canonical events MUST remain governed by the versioned retention policy and source-reference protections.
- **RT-005** A referenced lesson, checkpoint, action, audit event, or source evidence MUST NOT become a physical deletion candidate solely because it is old.
- **RT-006** `last_accessed_at`, retrieval traces, helpfulness, evidence role, facets, memory level, and explicit keep/discard annotations MUST be considered where available.

### Ephemeral runtime cleanup

- **RT-007** A process snapshot is stale only when its recorded PID is not alive and its process identity/start-time evidence cannot match a reused PID.
- **RT-008** Default grace after confirmed process exit is 24 hours.
- **RT-009** Malformed snapshots are quarantined or reported; they are not used to signal/stop a process.
- **RT-010** Cleanup MUST only target regular non-symlink files matching the owned naming convention directly under the runtime-resource directory.
- **RT-011** Apply MAY delete confirmed stale snapshots because they are non-canonical and non-recoverable by design.

### Adherence-state cleanup

- **RT-012** Adherence files MUST carry or resolve a last-updated time, session ID, and terminal/liveness state.
- **RT-013** Default retention is 14 days after terminal state; non-terminal or unknown state is preserved.
- **RT-014** An adherence file for a session still present in the active registry or recent events is protected.
- **RT-015** Cleanup targets only owned regular files at the memory-root top level.
- **RT-016** The policy MUST cap total files as a secondary safeguard but MUST use age/liveness before count-based eviction.

### Temporary and unattributed stores

- **RT-017** Store classification MUST use sanitized identity metadata and MUST not rely only on substring matching of a path.
- **RT-018** Test/temp confidence requires multiple signals such as temp-root containment, explicit metadata/source class, fixture naming, or missing live registry references.
- **RT-019** The first release reports `review` or `quarantine_candidate`; it does not automatically delete project stores.
- **RT-020** Unattributed stores are never auto-deleted.
- **RT-021** A store with recent events, a live lock, shared-memory references, or unresolved source refs is protected.

### Canonical lifecycle apply

- **RT-022** Extend retention beyond dry-run only in a separate, explicit `apply-lifecycle` operation.
- **RT-023** Initial apply MAY write retention scores and lifecycle states (`keep`, `review`, `downgrade`, `quarantine`, `tombstone_candidate`) but MUST NOT hard-delete L0 evidence.
- **RT-024** Apply requires exact project scope, actor, policy version, and expected current lifecycle version.
- **RT-025** Each state change writes a governance audit record with reason codes and bounded source references.
- **RT-026** Reapplying the same policy/result is idempotent.
- **RT-027** A newer keep decision can reverse downgrade/quarantine before any future deletion phase.

### CLI contract

Proposed commands:

```text
claude-memory-layer cleanup ephemeral --dry-run --class runtime|adherence|all
claude-memory-layer cleanup ephemeral --apply --class runtime|adherence|all
claude-memory-layer cleanup stores --dry-run --classification temp|unattributed
claude-memory-layer retention apply-lifecycle --project <path> --policy v1 --actor <id>
```

- **RT-028** `cleanup stores` remains dry-run-only in the first release.
- **RT-029** `--apply` MUST be rejected for an empty, home, root, or broad unresolved scope.
- **RT-030** Human output MUST state exactly what was removed and whether it is recoverable.

## Default policy

| Target | Default | Initial apply allowed |
|---|---|---|
| dead runtime snapshot | 24 hours after confirmed exit | yes |
| terminal adherence state | 14 days | yes |
| unknown/malformed ephemeral file | report/quarantine | no deletion |
| temp/e2e project store | 30 days plus protection checks | preview only |
| unattributed project store | no expiry | no |
| canonical event | retention v1 decision | lifecycle mark only |
| vector versions/fragments | MU-04 policy | compaction only |

## Privacy and safety

- Paths in public JSON are replaced with project hashes/classifications.
- Samples use safe opaque IDs and reason codes.
- Cleanup never follows symlinks.
- Before material store actions in any future phase, create a SQLite backup and verify it.
- Secrets found in content remain governed by credential-redaction tooling, not retention cleanup.

## Test specification

Required cases:

- live PID snapshot preserved;
- dead PID snapshot inside/outside grace;
- PID reuse protected by process identity/start-time mismatch checks;
- malformed/symlinked runtime file rejected;
- active and recent adherence state protected;
- terminal old adherence state preview/apply;
- count cap never evicts a recent active state;
- temp classification needs multiple signals;
- missing project path alone never authorizes deletion;
- retention lifecycle apply writes audit but not event deletion;
- optimistic version conflict fails closed;
- keep reversal restores visibility;
- dry-run leaves filesystem and DB unchanged.

Primary files:

- `src/core/operations/retention-audit.ts`
- `src/core/operations/retention-policy.ts`
- `src/core/runtime-resource-telemetry.ts`
- `src/adapters/claude/hooks/adherence.ts`
- `src/apps/cli/retention-audit-command.ts`
- new `src/core/operations/ephemeral-cleanup.ts`
- new `src/apps/cli/cleanup-command.ts`
- `tests/apps/retention-audit-cli.test.ts`
- `tests/core/retention-policy.test.ts`
- new `tests/core/ephemeral-cleanup.test.ts`

## Observability

Track aggregate:

- candidates, protected, removed, bytes reclaimed by class;
- reason codes for protection/rejection;
- lifecycle decisions by policy version;
- cleanup failure counts by safe error code.

No filename containing a session ID or raw project path is emitted to machine-wide dashboards.

## Rollout

1. Ship classification and preview for all classes.
2. Enable runtime snapshot cleanup only.
3. Observe one retention window, then enable terminal adherence cleanup.
4. Add canonical lifecycle apply without hard deletion.
5. Keep project-store cleanup preview-only until a separate deletion RFC.

## Rollback

- Disable the scheduler/cleanup invocation.
- Ephemeral deletions are intentionally not recoverable; grace and preview are the safeguards.
- Canonical lifecycle states are reversible and audited.
- No canonical hard-delete rollback is needed because this specification does not authorize one.

## Acceptance criteria

- Preview classifies all targeted items and performs no writes.
- Live/unknown resources are protected.
- Stale runtime and terminal adherence files can be safely bounded.
- Canonical lifecycle apply is audited, idempotent, and non-destructive.
- Temp and unattributed project stores are not automatically deleted.
