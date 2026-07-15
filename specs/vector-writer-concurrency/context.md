# Vector Writer Concurrency Context

## Observed failure

During `claude-memory-layer import`, Lance reported concurrent commits where a
`Delete` transaction conflicted with an `Append` transaction on the
`conversations` table. Both `Vector worker error` and the command-level
`Import failed` message were emitted, followed by a libc++ mutex abort.

## Relevant implementation seams

- `src/core/engine/memory-runtime-service.ts` starts polling workers and also
  exposes explicit draining.
- `src/core/vector-worker.ts` currently allows polling and draining to call the
  same batch method without a mutual-exclusion gate.
- `src/core/vector-store.ts` performs idempotent upsert as delete plus add.
- `src/core/worker-lock.ts` already supplies stale-aware, project-scoped process
  locking used by `process` and Mongo sync.
- `src/apps/cli/index.ts` does not currently apply that lock to the Claude
  import command and exits immediately on failure.
