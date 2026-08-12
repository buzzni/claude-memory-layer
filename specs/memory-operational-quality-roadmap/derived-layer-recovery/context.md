# Derived-layer Recovery Context

> **Status**: Ready after read-only diagnostics
> **Parent**: [`../spec.md`](../spec.md)

## Problem

One large opaque project store (`6ab6d837`) had 26,552 canonical events, 24,879 vectors, and 1,440 quarantined embedding jobs. The failures referred to missing Lance data/deletion objects rather than transient provider errors. Pending and retryable queues were empty, so generic retry guidance was incorrect.

SQLite events and governed records are canonical. Vector/Lance data is derived and must be auditable and reconstructable without changing canonical inputs. Maintenance may handle bounded retryable work, but must not silently rebuild an entire layer.

## Relevant code

- `src/core/vector-worker.ts`
- `src/core/vector-outbox.ts`
- `src/core/vector-store.ts`
- `src/extensions/vector/`
- `src/apps/cli/vector-command.ts`
- `src/apps/cli/maintenance-runner.ts`
- health report types/builders

## Operational boundary

The opaque store is a future production canary only. Audit/dry-run and especially apply require a shipped version, fresh-install smoke, disk preflight, and explicit user approval. Capture aggregate results only.
