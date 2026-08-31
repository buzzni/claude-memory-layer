# MU-01: MCP Read-Only Reliability

Status: Proposed — audit-based

Priority: P0

Primary surfaces: MCP, read-only diagnostics, SQLite snapshots

## Problem

The active MCP runtime can classify healthy stores as corrupt and can surface a write failure from an explicitly read-only context-pack request. The same stores pass SQLite integrity checks and are readable by the 2.3.2 CLI. The current resolver maps most snapshot exceptions to `corrupt`, while read flows can still call best-effort telemetry methods on a read-only service.

This makes the most important recovery interface untrustworthy: an agent cannot distinguish canonical corruption from a connector/runtime restriction.

## Goals

- Make `mem-stats`, `mem-context-pack`, project timeline, and other declared reads succeed without canonical writes.
- Distinguish corruption, permission, snapshot, compatibility, and optional-telemetry failures.
- Keep an active WAL-consistent view without creating sidecars in the canonical memory root.
- Keep CLI, dashboard, and MCP store-resolution semantics aligned.

## Non-goals

- Changing `refreshLatest: true` into a read-only operation.
- Removing best-effort telemetry from writable services.
- Automatically repairing a corrupt SQLite file.
- Falling back to raw transcript disclosure when a context pack fails.

## Requirements

### Store resolution

- **RO-001** `resolveExistingStore` MUST return a typed diagnostic reason in addition to its public status.
- **RO-002** Only a failed SQLite header/integrity probe MAY produce `corrupt`.
- **RO-003** Failure to create or clean a temporary snapshot MUST produce `snapshot_unavailable`, not `corrupt`.
- **RO-004** `EACCES`, `EPERM`, and SQLite read-only codes MUST produce `unreadable` or `readonly_runtime`, as appropriate.
- **RO-005** The public response MUST sanitize local paths and exception details.
- **RO-006** Snapshot probing MUST retry at most once for a torn-copy race and MUST NOT loop.

Proposed internal types:

```ts
type ExistingStoreFailureReason =
  | 'invalid_input'
  | 'invalid_store_shape'
  | 'source_unreadable'
  | 'snapshot_unavailable'
  | 'snapshot_inconsistent'
  | 'integrity_check_failed'
  | 'schema_incompatible'
  | 'readonly_runtime';

interface ExistingStoreResolution {
  status: 'existing' | 'missing' | 'invalid' | 'unreadable' | 'corrupt';
  reason?: ExistingStoreFailureReason;
  // Internal paths remain non-public.
}
```

### Snapshot behavior

- **RO-007** Snapshot creation MUST copy the database and any local regular WAL file into one private temporary directory.
- **RO-008** Symlinked database, WAL, or snapshot targets MUST be rejected.
- **RO-009** A caller MAY supply an internal snapshot directory override for constrained runtimes; it MUST resolve outside the canonical memory root.
- **RO-010** Snapshot cleanup MUST be idempotent and best effort.
- **RO-011** If snapshot creation is unavailable, an explicitly allowed direct immutable/read-only probe MAY be used only when it cannot create canonical sidecars. Otherwise the call fails with a typed reason.

### Read-only service behavior

- **RO-012** `MemoryService` and retrieval orchestration MUST expose whether writes are permitted.
- **RO-013** A read-only retrieval MUST skip access counters, helpfulness rows, retrieval traces, navigation events, migrations, and outbox work.
- **RO-014** Failure of optional telemetry MUST never fail the requested read.
- **RO-015** `mem-context-pack` with `refreshLatest: false` MUST select an explicitly read-only service.
- **RO-016** `mem-context-pack` with `refreshLatest: true` remains conditionally mutating and MUST require writable project storage.
- **RO-017** A generic continuation query with omitted `refreshLatest` MUST preserve the documented auto-refresh behavior; clients requiring read-only behavior must continue passing `false`.

### MCP error contract

- **RO-018** MCP errors MUST include a stable safe code and one remediation category without raw paths.
- **RO-019** `mem-stats` and context reads MUST report the same store status for the same request.
- **RO-020** Connector/runtime failures MUST be described as runtime/configuration failures rather than unsupported integration or data corruption.

Example safe error payload:

```json
{
  "code": "snapshot_unavailable",
  "storeStatus": "unreadable",
  "retryable": false,
  "message": "The MCP runtime could not create a read snapshot; canonical storage was not modified."
}
```

## Design

1. Introduce an error classifier around `createSQLiteReadSnapshot` and SQLite open/probe errors.
2. Preserve the existing compact public status while retaining a richer internal `reason`.
3. Add a read capability object to the service composition:

```ts
interface MemoryServiceCapabilities {
  canonicalWrites: boolean;
  telemetryWrites: boolean;
  freshnessImports: boolean;
}
```

4. Route MCP read-only tools through `ReadOnlyDiagnosticsService` or an equivalent uncached read composition.
5. Guard telemetry at the orchestration boundary instead of relying only on downstream `try/catch` blocks.
6. Emit bounded process-local counters for resolution failures by reason. Do not store raw database paths.

## Compatibility and migration

- No schema migration is required.
- Existing callers checking only `status` remain compatible.
- CLI human output may add one safe reason line after the existing error.
- MCP tool definitions remain unchanged except for documented structured error codes.

## Test specification

Add or extend tests covering:

| Case | Expected result |
|---|---|
| Healthy database, no WAL | `existing`; read succeeds |
| Healthy database, active WAL | snapshot includes committed WAL rows |
| Temporary directory not writable | `snapshot_unavailable`, never `corrupt` |
| Canonical database read-only | stats/context read succeeds without writes |
| Optional trace writer throws | context pack still succeeds |
| `refreshLatest: false` | no import, migration, trace, or access-count write |
| `refreshLatest: true` on read-only runtime | safe writable-storage error |
| Invalid SQLite header | `corrupt` or invalid shape according to contract |
| `PRAGMA quick_check` failure | `corrupt` with `integrity_check_failed` |
| Symlinked store/snapshot component | rejected without traversal |

Primary test files:

- `tests/services/read-only-diagnostics-service.test.ts`
- `tests/apps/read-only-diagnostics-cli.test.ts`
- `tests/apps/read-only-diagnostics-api.test.ts`
- `tests/extensions/mcp-context-tools.test.ts`
- new `tests/core/sqlite-read-snapshot.test.ts`
- new `tests/core/existing-store-resolution.test.ts`

## Observability

Add aggregate counters:

- `read_store_resolution_total{status,reason,client}`
- `read_snapshot_total{outcome}`
- `optional_telemetry_skip_total{operation,reason}`

Cardinality is bounded to enums. Project paths, session IDs, queries, and exception stacks are excluded.

## Rollout

1. Ship reason classification and tests without changing public status.
2. Route `mem-stats` through the corrected resolver.
3. Route `mem-context-pack(refreshLatest=false)` through the write-disabled composition.
4. Verify representative stores through both CLI and MCP.
5. Enable aggregate counters in dashboard/runtime status.

## Rollback

- Revert MCP routing to the previous service while keeping the new error classifier.
- Never fall back to a writable service merely to make a read succeed.
- Temporary snapshots are disposable; rollback requires no canonical data migration.

## Acceptance criteria

- All 147 audited healthy project DBs are no longer mislabeled corrupt.
- Representative MCP and CLI event counts match.
- `mem-context-pack(refreshLatest=false)` succeeds with zero canonical file mutations.
- A deliberately corrupt fixture is still rejected.
- Error responses contain no raw path, prompt, credential, or transcript content.
