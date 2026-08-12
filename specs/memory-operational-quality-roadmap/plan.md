# Memory Operational Quality Roadmap Plan

> **Version**: 0.2.0
> **Status**: Draft roadmap
> **Created**: 2026-08-12

## 1. How to use this plan

This file tracks ordering and status only. Execute work from the selected child `context.md`, `spec.md`, and `plan.md`. Do not implement a whole phase directly from this parent document.

Before every work packet:

- read repository `AGENTS.md` and the parent context/spec,
- recover recent CML project context when available,
- fetch and inspect `origin/main`,
- confirm the branch is based on current `origin/main`,
- record baseline tests and use temporary HOME/storage,
- preserve unrelated changes and update the child progress section after work.

## 2. Dependency graph

```text
read-only-diagnostics ──┬──> recoverable-project-gc
                       └──> derived-layer-recovery

retrieval-telemetry ───────────────┐
retrieval-benchmark-expansion ─────┴──> session-start-experiment

mcp-tool-profiles

runtime-resource-efficiency ──> broker ADR/spec only if evidence gate passes

architecture closure: cross-cutting; retrieval extraction waits for benchmark gate
```

The two root lanes—storage operations and retrieval measurement—may proceed independently. SessionStart behavior cannot precede both of its gates.

## 3. Workstream status

| Order | Workstream | State | Next action |
|---:|---|---|---|
| 1 | [`read-only-diagnostics`](read-only-diagnostics/plan.md) | Ready | refresh reproduction and implement filesystem invariance harness |
| 2 | [`recoverable-project-gc`](recoverable-project-gc/plan.md) | Ready after 1 | settle quarantine retention/restore UX |
| 2 | [`derived-layer-recovery`](derived-layer-recovery/plan.md) | Ready after 1 | implement read-only descriptor/audit before rebuild |
| 1 | [`retrieval-telemetry`](retrieval-telemetry/plan.md) | Ready | finalize attribution window and migration shape |
| 1 | [`retrieval-benchmark-expansion`](retrieval-benchmark-expansion/plan.md) | Ready | curate and privacy-scan 50+ labeled queries |
| 3 | [`session-start-experiment`](session-start-experiment/plan.md) | Blocked by evidence gates | begin only after telemetry + benchmark acceptance |
| 2 | [`mcp-tool-profiles`](mcp-tool-profiles/plan.md) | Incubating | capture exact tool/schema parity baseline |
| 2 | [`runtime-resource-efficiency`](runtime-resource-efficiency/plan.md) | Incubating | collect process/model lifecycle measurements |

## 4. Suggested release sequence

1. Patch: read-only diagnostics.
2. Separate patch/minor: recoverable project GC without automatic purge.
3. Minor: derived-layer audit/rebuild and state-specific health guidance.
4. Patch/minor: retrieval telemetry and expanded benchmark gate.
5. Patch after evidence: winning SessionStart behavior.
6. Minor: MCP registry/profiles with `all` as compatibility default.
7. Patch: resource telemetry and fast-path improvements.
8. Later minor only if an ADR approves: shared embedding broker.

Do not combine storage repair, retrieval ranking, and MCP default changes in one release.

## 5. Cross-cutting verification

Run proportionate focused tests during a work packet and, before merge:

```bash
npm run typecheck
npm run lint
npm run check:architecture
npm run check:public-output-privacy
npm run benchmark:replay
npm run eval:longmemeval:retrieval-smoke
npm run test:run
npm run build
```

Also verify that self-dependency is absent, real user settings/stores were not changed by tests, and Node 20.19+ remains supported.

## 6. Progress handoff

Record progress in the selected child `plan.md` using:

```markdown
## YYYY-MM-DD — Work packet X

- Baseline commit:
- Branch/PR:
- Completed:
- Files changed:
- Tests and exact results:
- Runtime/disk/store mutations:
- Known failures or flakes:
- Decisions:
- Remaining:
- Safe next command:
- Rollback notes:
```

Update this parent only when dependency, readiness, or overall completion state changes.
