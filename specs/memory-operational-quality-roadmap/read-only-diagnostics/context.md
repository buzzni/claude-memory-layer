# Read-only Diagnostics Context

> **Status**: Ready
> **Parent**: [`../spec.md`](../spec.md)

## Problem

A read-oriented `vector-status` invocation against an unresolved/nonexistent project argument was observed creating an empty project store. The current composition can resolve a writable lightweight project service, which may create directories, initialize SQLite, migrate schema, cache services, or own workers even though the caller only requested status.

The dated machine scan found 67 project directories plus the global store, including 28 empty stores and 20 with only 1-9 events. This feature prevents additional diagnostic side effects; it does not decide which existing stores may be removed.

## Relevant code

- `src/apps/cli/index.ts`
- `src/apps/cli/vector-command.ts`
- `src/apps/cli/project-scope-audit.ts`
- `src/core/registry/project-path.ts`
- `src/core/registry/repo-identity.ts`
- `src/services/memory-service-registry.ts`
- `src/services/memory-service.ts`
- dashboard/health read routes under `src/apps/server/`

## Boundaries

- Project GC belongs to [`../recoverable-project-gc/`](../recoverable-project-gc/).
- Derived-layer integrity belongs to [`../derived-layer-recovery/`](../derived-layer-recovery/).
- Re-measure on current `origin/main`; the original reproduction was against the `2.2.10` operating environment.
