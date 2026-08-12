# Memory Operational Quality Roadmap Specification

> **Version**: 0.2.0
> **Status**: Draft roadmap
> **Created**: 2026-08-12
> **Baseline**: `v2.2.10`

## 1. Purpose

This is the parent contract for post-`2.2.10` operational quality work. It defines rules shared by every child feature spec and tracks the product-level outcome. Feature behavior and implementation details belong in child directories.

## 2. Product outcome

The completed roadmap provides:

1. side-effect-free read operations,
2. recoverable project-store cleanup,
3. explicit recovery for derived layers,
4. presentation-aware usefulness telemetry,
5. representative retrieval regression gates,
6. evidence-based SessionStart behavior,
7. a smaller selectable MCP surface,
8. measured and bounded model/runtime resource use,
9. stronger core/adapter/extension boundaries.

## 3. Global invariants

Every child specification inherits these requirements.

### INV-001 — Canonical data safety

Raw events and governed SQLite records must not be deleted, rewritten, or inferred away by GC or derived-layer repair.

### INV-002 — Read means no write

A surface advertised as status, stats, audit, list, preview, health, or dry-run must not create storage, migrate schemas, enqueue work, change registry state, or start background workers. Telemetry writes are permitted only when explicitly documented by that surface.

### INV-003 — Dry-run and recovery first

Cleanup and rebuild operations default to dry-run. Mutation requires explicit authorization. Destructive cleanup must first use recoverable quarantine with a restore manifest; permanent purge is a separate retention-gated action.

### INV-004 — Derived layers are replaceable

Vectors and other declared projections are built from canonical inputs into a separate location, verified, and atomically activated. Failed verification leaves the active layer untouched.

### INV-005 — Privacy-safe output

Operational output contains aggregate counts, opaque identifiers, categories, and bounded redacted previews only. It must not expose raw transcripts, credentials, or private source paths.

### INV-006 — Backward compatibility

Existing public CLI, MCP, hook, and compatibility-entrypoint behavior remains compatible unless a release explicitly documents a migration period and rollback.

### INV-007 — Evidence before behavior

Telemetry and benchmark gates must exist before retrieval ranking, SessionStart defaults, MCP defaults, or resource architecture changes are promoted.

### INV-008 — Explicit mutation classification

MCP and CLI operations must distinguish `read_only`, `conditional`, and `mutating`. Conditional operations declare the inputs and defaults that trigger writes.

## 4. Feature specifications

| Feature | Status | Depends on | Specification |
|---|---|---|---|
| Read-only diagnostics | Ready | none | [`read-only-diagnostics/spec.md`](read-only-diagnostics/spec.md) |
| Recoverable project GC | Ready | read-only diagnostics | [`recoverable-project-gc/spec.md`](recoverable-project-gc/spec.md) |
| Derived-layer recovery | Ready | read-only diagnostics | [`derived-layer-recovery/spec.md`](derived-layer-recovery/spec.md) |
| Retrieval telemetry | Ready | none | [`retrieval-telemetry/spec.md`](retrieval-telemetry/spec.md) |
| Retrieval benchmark expansion | Ready | none; required before behavior changes | [`retrieval-benchmark-expansion/spec.md`](retrieval-benchmark-expansion/spec.md) |
| SessionStart experiment | Incubating | telemetry + benchmark | [`session-start-experiment/spec.md`](session-start-experiment/spec.md) |
| MCP tool profiles | Incubating | registry parity baseline | [`mcp-tool-profiles/spec.md`](mcp-tool-profiles/spec.md) |
| Runtime resource efficiency | Incubating | post-2.2.10 measurements | [`runtime-resource-efficiency/spec.md`](runtime-resource-efficiency/spec.md) |

`Ready` means the feature is sufficiently bounded to begin implementation after refreshing its dated evidence. `Incubating` means implementation must not start until its listed entry gate is met.

## 5. Architecture closure

Architecture closure remains cross-cutting rather than a standalone feature:

- remove the four current architecture-guard baseline violations without adding replacements,
- split retrieval phases only after the expanded benchmark is enforced,
- distinguish compatibility shims under `src/hooks`, `src/mcp`, and `src/server` from canonical implementations,
- keep low-adoption advanced features behind explicit profiles/extensions rather than expanding defaults.

Each child PR must avoid new boundary violations. Larger boundary cleanup should be a dedicated, behavior-preserving PR tied to the relevant child spec.

## 6. Roadmap completion criteria

The roadmap is complete only when:

1. all eight child specs meet their acceptance criteria,
2. read diagnostics create zero filesystem/database changes,
3. applied GC can be restored before retention-gated purge,
4. a damaged derived vector layer can be audited, rebuilt, verified, activated, and rolled back without canonical mutation,
5. reference navigation and evidence delivery are evaluated separately,
6. the accepted replay corpus contains at least 50 labeled queries and blocks privacy/no-match regressions,
7. SessionStart promotion is supported by telemetry and benchmark evidence,
8. MCP `core` meets its schema budget while `all` remains compatible,
9. resource telemetry supports a recorded broker/no-broker decision,
10. architecture-guard baseline violations reach zero.

## 7. Non-goals

- replacing SQLite as canonical storage,
- rewriting retrieval in one change,
- automatically deleting stores or rebuilding corrupted vectors during maintenance,
- retrying quarantined work forever,
- shipping a shared embedding broker without its evidence gate,
- adding HTTP/SSE, a full code graph, autonomous learning platform, or multi-agent mesh,
- removing compatibility entrypoints or advanced tools without a migration period.

## 8. Change control

- A child spec may tighten its own requirements but cannot weaken parent invariants.
- If implementation reveals a cross-feature decision, update this parent before diverging child specs.
- Do not mark a feature complete merely because code merged; required tests, rollout evidence, and rollback documentation must also be complete.
