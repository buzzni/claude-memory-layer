# Memory Operational Quality Roadmap Implementation Plan

> **Version**: 0.1.1
> **Status**: Draft
> **Created**: 2026-08-12
> **For future AI agents**: execute as small, reviewable work packets; do not skip the safety and benchmark gates.

**Goal:** Improve operational safety, derived-data recovery, retrieval measurement, benchmark coverage, MCP ergonomics, and runtime efficiency after `v2.2.10`.

**Strategy:** Establish invariants and measurements first. Add explicit audit/rebuild primitives next. Change retrieval behavior only after source-aware telemetry and a representative replay suite exist. Modularize MCP without changing behavior, then add opt-in profiles. Instrument resource use before considering a shared broker.

## 0. Agent handoff checklist

At the beginning of every work packet:

- [ ] Read repository `AGENTS.md` and this package's `context.md`/`spec.md`.
- [ ] Recover recent project context with CML MCP tools when available.
- [ ] `git fetch` and inspect `origin/main`.
- [ ] Confirm the current branch/worktree is based on current `origin/main`; create or rebase an isolated branch only when needed.
- [ ] Confirm self-dependency is absent: `npm list claude-memory-layer` should be empty for the repo install.
- [ ] Record current test/build baseline before edits.
- [ ] Use temporary HOME/storage for tests.
- [ ] Preserve unrelated dirty-worktree changes.
- [ ] Update this plan's progress notes or add a dated progress document after merge.

At creation time, do not implement from the local `v2.2.9` HEAD. The required baseline is `v2.2.10` or newer because runtime lifecycle/disk hardening landed there.

## Phase 0 — Baseline and test harness

### Task 0.1 — Refresh dated field evidence

**Objective:** Verify which baseline findings still reproduce.

**Read-only checks:**

- installed/source versions,
- hook and maintenance paths,
- store population histogram,
- vector/outbox health,
- MCP process/resource totals,
- helpfulness split by delivery source,
- current replay/LongMemEval metrics.

**Output:** Add a privacy-safe dated baseline under this spec directory only if values materially changed. Never include transcript content or private absolute project paths.

### Task 0.2 — Add filesystem invariance test utility

**Likely files:**

- Create: `tests/helpers/memory-root-snapshot.ts`
- Modify: relevant CLI/API tests

**Behavior:** Snapshot directory entries, sizes, mtimes or hashes as appropriate before/after a read operation. Use a temporary home directory.

**Verification:** Prove that the helper itself detects a deliberately created file in its unit test.

## Phase 1 — Read-only invariant and project GC

### Work packet 1A — Existing-store read composition

**Objective:** Stop status/audit commands from creating stores.

**Likely files:**

- `src/core/registry/project-path.ts`
- `src/services/memory-service-registry.ts`
- `src/services/memory-service.ts`
- `src/apps/cli/index.ts`
- `src/apps/cli/vector-command.ts`
- dashboard/health read-service helpers
- CLI and registry tests

**Steps:**

1. Inventory every read-oriented command/API and the service factory it uses.
2. Define path/hash argument semantics once.
3. Add an existing-store resolver that does not call mkdir or initialize migrations.
4. Add an uncached read-only service/store path.
5. Return a structured no-store result instead of constructing an empty service.
6. Migrate `vector-status`, `stats`, `health`, scope audit, and dashboard reads.
7. Add before/after filesystem invariance tests for each migrated surface.

**Acceptance:**

- nonexistent project read creates no directory,
- hash and path behavior is documented and tested,
- existing store output remains compatible,
- no worker/embedder starts for pure stats/status.

**Suggested commit:** `fix(storage): make read diagnostics side-effect free`

### Work packet 1B — Empty/tiny store GC

**Objective:** Provide recoverable, explicit cleanup without coupling it to the read fix.

**Likely files:**

- Create: `src/apps/cli/project-gc.ts`
- Modify: `src/apps/cli/index.ts`
- Create tests under `tests/apps/`
- Update README/operations docs

**Steps:**

1. Define empty versus tiny store classification.
2. Inspect registry references, locks, canonical rows, outbox rows, and governance tables.
3. Implement dry-run report with candidate reason and reclaimable bytes.
4. Require `--apply` to move candidates into a dedicated quarantine/trash area on the same filesystem.
5. Reject symlinks and paths outside the exact project-store root.
6. Write a durable manifest with original location, quarantined location, identity, timestamp, and integrity metadata.
7. Add an idempotent restore path and test interrupted-move recovery.
8. Keep permanent purge separate, retention-gated, and explicitly requested; it may be deferred from the first release.
9. Teach maintenance discovery to report/skip skeleton stores without migration.

**Tests:**

- empty unreferenced store candidate,
- empty referenced store retained,
- one-event/tiny store retained by default,
- governance-only store retained,
- lock-busy store retained,
- symlink rejected,
- apply quarantines only exact candidates inside temp HOME,
- restore returns the exact candidate and preserves its identity,
- interrupted quarantine can be recovered without selecting unrelated stores,
- purge cannot run before its retention/confirmation gate.

**Suggested commit:** `feat(project): add dry-run-first empty store gc`

**Release gate:** Ship Work Packet 1A independently before any production cleanup. Review and release Work Packet 1B separately, then re-run diagnostics after fresh install. Do not automatically run `--apply` or purge on the user's machine.

## Phase 2 — Derived-layer audit and rebuild

### Work packet 2A — Layer descriptor and audit

**Objective:** Establish a common model before implementing repair.

**Likely files:**

- Create: `src/core/layers/derived-layer.ts`
- Create: `src/core/layers/derived-layer-registry.ts`
- Create: `src/core/layers/vector-layer.ts`
- Create: `src/apps/cli/layer-command.ts`
- Modify: `src/apps/cli/index.ts`
- Tests under `tests/core/` and `tests/apps/`

**Steps:**

1. Define descriptor, audit states, verification result, and privacy-safe output types.
2. Register a read-only vector-layer auditor first.
3. Report canonical input count, expected/indexed count, embedding version, outbox state, and corruption/quarantine category.
4. Ensure audit opens existing stores only and performs no migration.
5. Add JSON and human-readable output.

**Suggested commit:** `feat(layers): add derived layer audit contract`

### Work packet 2B — Vector rebuild engine

**Objective:** Reconstruct vectors safely from canonical SQLite events.

**Likely files:**

- `src/core/layers/vector-layer.ts`
- `src/extensions/vector/`
- `src/core/vector-worker.ts`
- lock/disk helpers reused from maintenance
- CLI tests with small temporary Lance fixtures

**Steps:**

1. Add dry-run plan: inputs, exclusions, target version, estimated work/space.
2. Acquire a project-specific rebuild lock and reject active conflicting workers.
3. Calculate required disk reserve conservatively.
4. Build into a unique temporary sibling directory.
5. Verify counts and deterministic sample queries.
6. Preserve the active index as rollback state.
7. Atomically activate the verified index.
8. Only then reconcile corresponding quarantine rows.
9. On any failure, retain canonical SQLite and the previous active index.

**Tests:**

- success and atomic activation,
- verification failure leaves old index active,
- disk-pressure block,
- lock contention,
- interrupted rebuild cleanup/recovery,
- embedding version mismatch,
- excluded event types remain intentionally absent,
- quarantine reconciliation only after verification.

**Suggested commit:** `feat(vectors): add verified derived index rebuild`

### Work packet 2C — State-specific health guidance

**Objective:** Make operational recommendations actionable.

**Likely files:**

- health report builder/API
- `src/apps/cli/vector-command.ts`
- maintenance report types
- health/vector tests

**Cases:** pending, stuck, retryable failed, quarantined-only, corruption, disk block, healthy.

**Suggested commit:** `fix(health): distinguish quarantine and rebuild guidance`

**Production canary:** After release and fresh-install smoke, run audit/dry-run on opaque store `6ab6d837`. Actual apply is a separate explicitly approved operation. Capture only aggregate before/after results.

## Phase 3 — Telemetry semantics and benchmark gate

### Work packet 3A — Presentation-aware retrieval telemetry

**Objective:** Stop treating reference navigation like directly injected evidence.

**Likely files:**

- `src/core/sqlite-event-store.ts`
- `src/core/engine/retrieval-analytics-service.ts`
- `src/core/engine/retrieval-orchestrator.ts`
- `src/extensions/mcp/handlers.ts` or later source handler
- source/details/expand paths
- dashboard stats/usefulness API and UI

**Steps:**

1. Add forward-compatible columns/metadata for delivery/presentation mode.
2. Record source-ref/expand/details opens without storing new raw content.
3. Attribute opens to an injection trace only when deterministic.
4. Split evidence-grounding and reference-navigation reporting.
5. Preserve legacy rows and label their mode unknown/legacy.
6. Add privacy scan tests.

**Suggested commit:** `feat(telemetry): measure reference navigation separately`

### Work packet 3B — Expand anonymized replay corpus

**Objective:** Create the behavior gate required for later retrieval changes.

**Likely files:**

- `benchmarks/replay/`
- `scripts/generate-session-qrels.ts`
- `scripts/replay-retrieval-benchmark.ts`
- benchmark docs and tests

**Steps:**

1. Select 50-100 anonymized query/memory cases across required categories.
2. Add positive ids, forbidden ids, and explicit no-match cases.
3. Run credential/path/privacy validation before committing fixtures.
4. Record accepted baseline metrics by category.
5. Add CI tiers: smoke, retrieval-change gate, scheduled larger eval.
6. Keep promotion/review workflow human-reviewable.

**Acceptance:** no-match 100%, forbidden hits 0, failed queries 0, no accepted-baseline MRR/Hit@3 regression.

**Suggested commit:** `test(retrieval): expand anonymized real-session replay gate`

## Phase 4 — SessionStart experiment

### Work packet 4A — Deterministic variants

**Objective:** Reduce unnecessary startup context without guessing from a misaligned metric.

**Likely files:**

- `src/adapters/claude/hooks/session-start.ts`
- Codex SessionStart wrapper
- hook configuration/options
- helpfulness/retrieval trace schema
- tests for deterministic assignment and formatting

**Variants:** current three items; one summary plus one recent outcome; reference-only index.

**Steps:**

1. Implement deterministic session-id cohort assignment.
2. Keep current behavior as default/control.
3. Add env/config override and kill switch.
4. Record variant and delivery token/character counts.
5. Compare source opens, first-question relevance, continuation, re-ask, and prompt-lane quality.
6. Run for enough sessions/time before selecting a winner.

**Promotion rule:** user-prompt unhelpful stays at or below 5%; startup tokens fall materially; continuation metrics do not regress.

**Suggested commit:** `feat(hooks): add measured session-start context variants`

## Phase 5 — MCP modularization and profiles

### Work packet 5A — Behavior-preserving registry split

**Objective:** Split implementation before changing the visible tool list.

**Likely files:**

- Create: `src/extensions/mcp/registry.ts`
- Create handler modules under `src/extensions/mcp/handlers/`
- Create presenter/schema modules as needed
- Modify compatibility `handlers.ts`, `tools.ts`, `index.ts`
- Update MCP tests

**Steps:**

1. Build a registry mapping tool name to schema, handler, profile, and mutation kind (`read_only`, `conditional`, or `mutating`). Conditional entries must describe the input/default predicate that triggers writes.
2. Generate/list tools from the registry.
3. Add parity tests for duplicate/missing tools.
4. Extract handlers by bounded domain without output changes.
5. Smoke critical tools: context pack, import latest, source ref, frontier, graph query.

**Acceptance:** `all` tool count/schema and behavior remain compatible; no handler module grows into a new monolith.

**Suggested commit:** `refactor(mcp): route tools through bounded registry modules`

### Work packet 5B — Opt-in profiles

**Objective:** Reduce default context cost for clients that choose a smaller surface.

**Steps:**

1. Add `core`, `operations`, `governance`, `experimental`, `all` metadata.
2. Add environment/config selection with `all` compatibility default.
3. Add schema byte/token report tests.
4. Keep always-mutating tools, including explicit import, out of `core`; expose context-pack auto-refresh as conditional and retain its explicit read-only opt-out.
5. Test preview/apply and auto-refresh tools against their machine-readable mutation predicates.
6. Document client migration and troubleshooting.

**Acceptance:** core <=10 tools and <=20 KB schema; all retains the prior list.

**Suggested commit:** `feat(mcp): add backward-compatible tool profiles`

## Phase 6 — Runtime resource decision

### Work packet 6A — Instrument idle/model resources

**Objective:** Determine why process count/RSS remains high without prematurely adding IPC.

**Likely files:**

- `src/extensions/mcp/idle-resources.ts`
- `src/extensions/mcp/index.ts`
- `src/extensions/vector/embedder.ts`
- semantic daemon/runtime health models
- CLI/dashboard aggregate reporting

**Steps:**

1. Add model-load and release counters/timing.
2. Add last-activity and cold/hot retrieval timing.
3. Add aggregate privacy-safe status output.
4. Verify RSS/model release after the configured idle period.
5. Collect a representative multi-client sample.

**Suggested commit:** `feat(runtime): expose embedding resource telemetry`

### Work packet 6B — Broker ADR/spike, only if gate is met

**Objective:** Compare alternatives and prototype the smallest safe shared broker.

**Gate:** sustained duplicate-model RSS >=1 GiB or repeated model-load latency after idle release, with enough samples to exclude legacy clients.

**Deliverable:** ADR comparing in-process idle release, shared broker, and provider backends. Do not merge a broker solely because the spike works.

If approved, require local-only transport, bounded timeouts, one model instance, lazy lifecycle, fallback, and no canonical-store ownership.

## Phase 7 — Architecture closure and docs

### Work packet 7A — Boundary baseline zero

1. Inspect current four baseline entries on latest main.
2. Replace core-to-extension re-export/import boundaries with ports/composition roots.
3. Remove baseline entries as violations disappear.
4. Reject new violations in CI.

### Work packet 7B — Retrieval phase extraction

Start only after the expanded benchmark is an enforced gate.

Extract query plan, candidate generation, ranking, expansion, and context assembly one at a time. Preserve trace/debug shapes or version them explicitly.

### Work packet 7C — Documentation drift

Update removed `src/ui` references. For `src/server`, `src/hooks`, and `src/mcp`, document that the remaining files are compatibility entrypoints and link their canonical `src/apps`, `src/adapters`, or `src/extensions` implementations. Link this spec from architecture indexes and progress documents.

## Cross-cutting verification

Run proportionate focused tests during development, then before merge:

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

Also verify:

- `npm list claude-memory-layer` is empty in the repo,
- no real user settings were modified,
- no live memory store was changed by tests,
- generated `dist` behavior is smoke-tested when packaging changes,
- Node 20.19+ compatibility remains intact.

## Suggested release sequence

1. Patch: Work Packet 1A read-only invariant.
2. Separate patch/minor: Work Packet 1B recoverable project GC; defer purge until policy review.
3. Minor: Phase 2 layer audit/rebuild and state-specific health guidance.
4. Patch/minor: Phase 3 telemetry and benchmark gate.
5. Patch after evidence: Phase 4 winning SessionStart behavior.
6. Minor: Phase 5 MCP registry/profiles with `all` default.
7. Patch: Phase 6 telemetry.
8. Later minor only if ADR approves: shared embedding broker.

Do not combine storage rebuild, retrieval ranking behavior, and MCP default-profile changes in one release.

## Progress handoff template

When stopping or handing off, append a dated progress note or update a dedicated progress file with:

```markdown
## YYYY-MM-DD — Work packet X

- Baseline commit:
- Branch/PR:
- Completed:
- Files changed:
- Tests run and exact results:
- Runtime/disk/store mutations performed:
- Known failures or flakes:
- Decisions made:
- Remaining tasks:
- Safe next command:
- Rollback notes:
```

Never describe a work packet as complete when required tests, rollout verification, or safety checks remain.
