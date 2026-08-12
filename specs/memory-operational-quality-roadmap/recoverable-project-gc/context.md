# Recoverable Project GC Context

> **Status**: Ready after read-only diagnostics
> **Parent**: [`../spec.md`](../spec.md)

## Problem

The dated scan found 28 empty project stores and 20 stores with 1-9 events. Some may be diagnostic artifacts, but low row count does not prove disposability: registry references, locks, governance rows, outbox work, lessons, checkpoints, or other canonical data may still make a store meaningful.

Cleanup has higher risk than preventing new empty stores. It therefore ships separately from [`../read-only-diagnostics/`](../read-only-diagnostics/) and must be recoverable before any permanent purge is considered.

## Safety model

- Dry-run is the default.
- `--apply` means move an exact candidate into quarantine on the same filesystem, not delete.
- A durable manifest supports idempotent restore and interrupted-operation recovery.
- Purge is a separate retention-gated action and may be omitted from the first release.
- No command may traverse symlinks or operate outside the exact managed project-store root.

## Open decisions

- minimum candidate age,
- tables/rows that make a tiny store non-disposable,
- quarantine location and retention interval per supported platform,
- registry tombstone/audit representation,
- interaction with active maintenance and MCP processes.
