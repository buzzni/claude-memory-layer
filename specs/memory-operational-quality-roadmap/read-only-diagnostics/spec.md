# Read-only Diagnostics Specification

> **Status**: Ready

## Requirements

### ROD-001 — Existing-store resolver

Resolve filesystem paths and explicitly supported opaque hashes into `existing`, `missing`, `invalid`, or `unreadable/corrupt` without creating directories or opening a migrating store. Path/hash semantics must be documented once and shared by CLI/server/MCP callers.

### ROD-002 — Read-only composition

Stats, health, vector status, scope audit, dashboard reads, and other diagnostic surfaces must use uncached read-only composition that owns no worker or embedder. A missing store returns a structured empty/no-store result.

### ROD-003 — Filesystem invariance

Provide a reusable test helper that snapshots a temporary memory root before and after a read. It must detect added/removed files, relevant metadata/content changes, SQLite sidecars, and Lance artifacts.

### ROD-004 — Compatibility

Existing-store human and JSON output remains compatible. Missing/invalid inputs have explicit exit/error semantics. Pure lexical/status paths must not initialize semantic models.

### ROD-005 — Maintenance discovery

Maintenance discovery may count empty skeletons but must not migrate or initialize them while inspecting.

## Acceptance

- Nonexistent project reads create zero files/directories and perform zero migrations.
- Existing stores are not changed by status/stats/health/audit reads.
- No worker, embedder, or service-cache entry is created for a pure read.
- Resolver tests cover path, hash, missing, invalid, unreadable, and symlink cases.
- Focused CLI/server/MCP tests and parent cross-cutting checks pass.

## Non-goals

- deleting existing stores,
- rebuilding vectors,
- suppressing explicitly documented retrieval/access telemetry.
