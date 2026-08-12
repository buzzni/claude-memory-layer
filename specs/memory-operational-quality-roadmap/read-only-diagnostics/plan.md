# Read-only Diagnostics Plan

> **State**: Ready
> **Suggested release**: Patch

## Packet 1 — Reproduce and inventory

1. Reproduce `vector-status` against missing path/hash in temporary HOME.
2. Inventory every read command/API and its service factory.
3. Record current output/exit behavior and filesystem diff.

## Packet 2 — Invariance harness

1. Add `tests/helpers/memory-root-snapshot.ts` or equivalent.
2. Unit-test that the helper detects a deliberate mutation.
3. Include SQLite WAL/SHM and vector artifacts in comparison.

## Packet 3 — Resolver and composition

1. Add non-creating existing-store resolution.
2. Add uncached read-only composition.
3. Migrate `vector-status`, stats, health, scope audit, and dashboard reads.
4. Preserve public response shapes and avoid model initialization.

## Verification

- focused resolver, registry, CLI, server, and MCP tests,
- filesystem invariance tests for every migrated surface,
- parent cross-cutting verification.

## Suggested commits

- `test(storage): add read filesystem invariance harness`
- `fix(storage): make diagnostics side-effect free`

## Progress

No implementation started.
