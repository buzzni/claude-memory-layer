# Runtime Resource Efficiency Plan

> **State**: Implementation complete; rollout evidence pending
> **Suggested release**: Patch for telemetry/fast path; later minor only if broker approved

## Packet 1 — Instrumentation

1. Define privacy-safe lifecycle counters/timings.
2. Instrument load, use, idle release, disposal, and failure paths.
3. Add deterministic fake-clock/resource tests.
4. Expose aggregate CLI/dashboard status where supported.

## Packet 2 — Fast-path audit

1. Inventory stats/status/fast retrieval compositions.
2. Add tests that fail if an embedder loads.
3. Remove accidental initialization without changing semantic behavior.

## Packet 3 — Field measurement

1. Collect representative multi-client process/RSS/model lifecycle samples.
2. Separate current-version clients, legacy clients, daemon, and actual orphans.
3. Quantify duplicate-model RSS and cold-load cost.

## Packet 4 — Decision

- If the gate is not met, record a no-broker ADR and continue idle-release tuning.
- If met, write a separate broker ADR/spec and prototype the smallest local-only design. Do not merge the prototype solely because it runs.

## Suggested commits

- `feat(runtime): expose embedding resource telemetry`
- `perf(runtime): keep non-semantic paths model-free`

## Progress

## 2026-08-13 — Work packets 1, 2, and decision gate

- Baseline commit: `62167e2f3fbf0d4a425c6a25f8a5c7163de3ce5d` (`origin/main`)
- Branch/PR: `feat/runtime-resource-efficiency` / [#73](https://github.com/buzzni/claude-memory-layer/pull/73)
- Completed: privacy-safe process/model lifecycle schema; load/use/release/failure instrumentation; cold/hot semantic retrieval timing; aggregate current/legacy client and RSS reporting; read-only `runtime-status`; concurrent cold-load coalescing; MCP non-semantic fast-path audit and initialization fix; no-broker ADR
- Files changed: runtime telemetry core, vector embedder, retrieval orchestration, MCP/daemon lifecycle, CLI command, tests, README, ADR, and this handoff
- Tests and exact results: focused baseline 87/87; rebased full Vitest 208 files / 1,310 tests; typecheck; lint (0 errors, 44 existing warnings); architecture guard; public-output privacy scan; replay benchmark; LongMemEval retrieval smoke; build; source and built `runtime-status`; built MCP registration/shutdown smoke — all passed
- Runtime/disk/store mutations: dependencies installed and tests executed with temporary `HOME=/tmp/cml-rre-home.Ym6raZ`; no real memory store or user settings mutations; one read-only pre-instrumentation process/RSS sample collected
- Known failures or flakes: none; `npm list claude-memory-layer --depth=0` exits 1 while correctly reporting the root package with `(empty)` dependencies
- Decisions: do not build a broker from one unversioned/unattributed RSS snapshot; retain in-process idle release and collect representative post-release samples
- Remaining: post-release field measurement with current instrumented clients
- Safe next command: `git diff --check`
- Rollback notes: revert telemetry/CLI instrumentation; operators may disable snapshot persistence with `CLAUDE_MEMORY_DISABLE_RUNTIME_TELEMETRY=1`; canonical memory data is unaffected
