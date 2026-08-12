# Recoverable Project GC Plan

> **State**: Ready after read-only diagnostics
> **Suggested release**: Separate patch/minor

## Entry gate

- Read-only diagnostics is merged and empty-store growth from reads is stopped.
- Candidate rules and quarantine retention are approved.

## Packet 1 — Classification and dry-run

1. Define typed classifications and fail-closed eligibility rules.
2. Reuse the non-creating existing-store resolver.
3. Implement privacy-safe dry-run report and JSON shape.
4. Test every retention reason.

## Packet 2 — Quarantine and restore

1. Define versioned manifest and lifecycle states.
2. Implement exact-target same-filesystem move with lock checks.
3. Implement idempotent restore and conflict handling.
4. Add fault-injection tests around move/manifest ordering.

## Packet 3 — Optional purge

Proceed only after policy review. Add retention eligibility, explicit confirmation, exact-target deletion, and audit records. Do not couple purge to maintenance.

## Likely files

- create `src/apps/cli/project-gc.ts`,
- modify `src/apps/cli/index.ts`,
- reuse registry/path/lock helpers,
- add tests under `tests/apps/` and focused operations docs.

## Suggested commits

- `feat(project): add project gc dry-run classification`
- `feat(project): add recoverable store quarantine and restore`
- optional later: `feat(project): add retention-gated quarantine purge`

## Progress

No implementation started.
