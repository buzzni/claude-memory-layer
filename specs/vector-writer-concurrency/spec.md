# Vector Writer Concurrency Specification

> **Status**: Implemented
> **Created**: 2026-07-15

## 1. Problem

Writable `MemoryService` initialization starts the legacy and V2 vector polling
workers immediately. One-shot commands such as `import` then call
`processPendingEmbeddings()`, which drains the same workers through
`processAll()`. The polling call and the explicit drain can therefore enter
`processBatch()` concurrently.

Legacy LanceDB upserts are implemented as `delete(id)` followed by `add(rows)`.
Concurrent batches can read adjacent table versions and produce an
unresolvable Lance commit conflict (`Delete` versus `Append`). An immediate
`process.exit(1)` can then tear down the native Lance runtime while another
batch is still active, producing a secondary libc++ mutex abort.

## 2. Required invariants

1. A `VectorWorker` instance executes at most one batch at a time.
2. A `VectorWorkerV2` instance executes at most one batch at a time.
3. Runtime shutdown stops polling and waits for the active batch before closing
   SQLite/shared services.
4. Project-scoped one-shot import processing uses the same worker lock as the
   `process` and Mongo sync commands.
5. A recognized Lance commit conflict is retried from a newly opened table
   handle with bounded backoff; unrelated errors fail immediately.
6. CLI failures set a non-zero exit status only after service shutdown and lock
   release have completed.

## 3. Non-goals

- Replacing LanceDB or changing the vector schema.
- Making arbitrary user code that writes directly to LanceDB participate in
  the project worker lock.
- Retrying schema, permission, embedding, or general I/O failures.

## 4. Acceptance criteria

- Two overlapping `processBatch()` calls share one physical batch execution.
- `processAll()` can overlap the background poll without concurrent vector
  writes or duplicate outbox claims.
- Shutdown does not close backing stores while a batch is active.
- Concurrent import/process commands for the same storage scope do not both
  become vector writers.
- A synthetic Lance commit conflict succeeds after reopening/retrying, while a
  non-conflict exception is returned without retry.
- Focused tests, typecheck, and build pass.
