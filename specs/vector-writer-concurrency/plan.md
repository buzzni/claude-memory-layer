# Vector Writer Concurrency Implementation Plan

> **Status**: Complete
> **Created**: 2026-07-15

## Phase 1 — Worker serialization

- [x] Add a per-worker active-batch promise to legacy and V2 workers.
- [x] Route polling and explicit drains through the same single-flight gate.
- [x] Expose `waitForIdle()` and await it during runtime shutdown.
- [x] Add deterministic overlap and shutdown-order tests.

## Phase 2 — Lance conflict recovery

- [x] Detect only Lance concurrent commit conflict messages.
- [x] Evict/reopen the affected cached table before retrying the complete
      idempotent delete/add operation.
- [x] Use bounded exponential backoff and preserve immediate failure for other
      errors.
- [x] Add retry and no-retry unit tests with fake table handles.

## Phase 3 — One-shot import lifecycle

- [x] Extract project/global import lock path resolution and busy formatting.
- [x] Acquire the worker lock before starting writable Claude, Codex, and Hermes import services.
- [x] Release the lock and shut services down through `finally` paths.
- [x] Replace immediate exits in import actions with deferred
      `process.exitCode` assignment.
- [x] Cover lock resolution, contention messaging, and cleanup with tests.

## Phase 4 — Verification

- [x] Run focused worker, runtime, import, and process command tests (36 passed after review fixes).
- [x] Run the full test suite (156 files, 900 tests passed after review fixes).
- [x] Run TypeScript typecheck.
- [x] Run lint (0 errors; 41 pre-existing `no-explicit-any` warnings).
- [x] Run the production build.
- [x] Record completed items and follow-up risks below.

## Post-implementation review — 2026-07-15

- [x] Made `processAll()` stop-aware and made `waitForIdle()` re-check active
      batches so shutdown cannot close storage between drain iterations.
- [x] Made semantic daemon retrieval read-only and disabled retrieval tracing so
      it cannot become an uncoordinated background vector writer.

## Follow-up risk

The project worker lock coordinates CML one-shot commands that participate in
the lock protocol. A third-party process writing directly to the Lance path may
still race; bounded commit-conflict retry is the defensive path for that case.
