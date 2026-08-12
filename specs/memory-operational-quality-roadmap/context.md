# Memory Operational Quality Roadmap Context

> **Version**: 0.1.1
> **Status**: Draft
> **Created**: 2026-08-12
> **Implementation baseline**: `origin/main` at `v2.2.10` (`3d6a47f`)
> **Scope**: post-2.2.10 reliability, retrieval quality, MCP surface, and runtime efficiency

## 1. Why this spec exists

`claude-memory-layer` is already actively used across Claude Code, Codex, Hermes, MCP clients, the local dashboard, and many project-scoped SQLite stores. The main product problem is no longer “does memory work?” The remaining problems are operational invariants, recoverability of derived data, trustworthy usefulness measurement, benchmark depth, and the cost of a broad MCP/runtime surface.

This package records enough context for a later AI agent to continue implementation without relying on the original conversation. It intentionally separates:

- source-of-truth safety from cleanup,
- audit from repair,
- telemetry from behavior changes,
- behavior-preserving MCP modularization from profile/default changes,
- resource measurement from a possible shared embedding broker.

The intended direction is incremental. Do not rewrite the product or add new memory subsystems while these foundations are unfinished.

## 2. Required bootstrap for a future agent

Before changing code:

1. Read the repository `AGENTS.md`.
2. Fetch the latest remote state and inspect `origin/main`.
3. Start implementation from the current `origin/main`, not from the worktree revision that originally created this spec. At creation time this worktree was at `v2.2.9`, while `origin/main` and the installed package were already `v2.2.10`.
4. If Claude Memory Layer MCP tools are available, call `mem-context-pack` with the current task and absolute project path. Do not pass the live agent session id as a CML `sessionId`.
5. Confirm the global installed version, source version, hook paths, and maintenance scheduler path before drawing runtime conclusions.
6. Run tests with a temporary HOME/storage root. Do not let diagnostics or tests mutate `~/.claude-code/memory`.
7. Treat the measurements below as a dated baseline, not as permanent truth. Re-measure before implementation and after each rollout.

## 3. Current product state

### 3.1 What is working

As of 2026-08-12:

- Global CLI, Codex hooks, MCP, Claude hooks, and periodic maintenance were aligned to `2.2.10`.
- Claude lifecycle hooks were installed for SessionStart, UserPromptSubmit, PostToolUse, Stop, and SessionEnd.
- Codex automatic SessionStart, UserPromptSubmit, and SessionEnd hooks were installed and importing completed sessions.
- The macOS maintenance scheduler was active at a 300-second interval.
- The most recent maintenance runs had zero errors, zero pending work, and zero retryable failures.
- The current repository store had 1,832 events and 1,832 vectors, with no pending, failed, stuck, or quarantined work.
- Three legacy orphan MCP processes were terminated; later measurements showed zero orphan MCP processes.
- npm/Yarn cache cleanup increased available disk from roughly 9.5 GiB to roughly 12 GiB. Maintenance records a 5 GiB minimum.
- Compact memory delivery remains effective: approximately 87% character savings for SessionStart and 93% for question-time injection.
- Project scoping, strict prompt injection gates, source references, and Codex compact reference indexes are being exercised in real sessions.

### 3.2 Dated machine-wide usage baseline

The most recent 24-hour aggregate used for this roadmap showed approximately:

- 13 active project stores,
- 1,630 events,
- 78 project/session pairs,
- 286 retrieval traces,
- 79.4% of queries selecting at least one memory,
- 14.7 candidates and 2.4 selected memories per query on average,
- 1,050 helpfulness rows, 96% measured,
- 526 SessionStart injections,
- 522-524 question-time injections depending on the exact snapshot.

These numbers demonstrate active use. They do not by themselves prove that every injection was useful.

### 3.3 Store population and read-side mutation finding

The machine had 67 project directories plus the global store in the maintenance scan. Project-store population was approximately:

- 28 empty stores,
- 20 stores with 1-9 events,
- 8 stores with 10-99 events,
- 4 stores with 100-999 events,
- 7 stores with at least 1,000 events.

A read-oriented `vector-status` invocation against an unresolved/nonexistent project argument was observed creating an empty project store. The current command path uses a lightweight writable project service rather than an existing-store read-only path. This makes “read commands do not mutate” the first invariant to fix.

Do not delete the existing empty/tiny stores as part of the read-only fix. Cleanup must be a separate, dry-run-first feature with registry and lock checks. Its first mutating step should be a recoverable quarantine/move with a manifest; irreversible purge requires a separate retention policy and explicit action.

### 3.4 Derived-vector damage baseline

One large project store (`6ab6d837`, kept as an opaque privacy-safe identifier) had:

- 26,552 canonical events,
- 24,879 vectors,
- 1,440 quarantined embedding jobs,
- zero pending and zero retryable jobs.

The 1,440 failures were created on 2026-08-10. Their error families referred to missing Lance deletion/data objects, not transient provider errors. Maintenance correctly avoids retrying them forever, but there is no general derived-layer audit/rebuild workflow that can reconstruct and verify a fresh vector index from canonical SQLite events.

The productivity health report also recommended generic pending-work recovery for this quarantined-only state. Health remediation should distinguish retryable backlog, quarantine, corruption, and disk pressure.

### 3.5 Retrieval usefulness baseline and caveat

The latest 24-hour helpfulness aggregation showed:

| Delivery source | Rows | Average score | Helpful | Unhelpful | Average content overlap |
|---|---:|---:|---:|---:|---:|
| SessionStart | 526 | 0.412 | 12.0% | 60.1% | 0.285 |
| UserPromptSubmit | ~522 | 0.559 | 20.9% | 2.8% | 0.353 |

This does not justify immediately deleting SessionStart context. The current helpfulness formula is dominated by response/content overlap and behavioral continuation. A reference index is designed to be opened only when needed, so its success signal should include source-open and citation use rather than only copied/reused text.

Telemetry semantics must be corrected before selecting a new SessionStart variant.

### 3.6 Benchmark depth

The repository already contains replay and LongMemEval infrastructure. At the time of this spec:

- the primary anonymized replay fixture had 4 queries and 7 memories,
- the LongMemEval retrieval smoke fixture had 1 query and 2 memories,
- replay Precision@1 was about 0.667,
- Recall@1 was about 0.333,
- MRR was about 0.833,
- no-match accuracy was 1.0,
- forbidden hits and failed queries were zero,
- one hook-policy query did not rank the expected memory first.

This is enough for a smoke test but not enough to approve risky retrieval refactors. A larger anonymized real-session corpus and category-specific qrels are required before splitting/reranking retrieval behavior.

### 3.7 MCP/runtime footprint

The installed MCP server exposed 44 tools. The JSON tool schema was approximately:

- 47,622 bytes,
- roughly 11,900 tokens using a simple four-characters-per-token estimate.

The source had a multi-thousand-line MCP handler and a large tool definition file. Runtime snapshots showed roughly 18-20 MCP processes using about 2 GiB combined, plus a semantic daemon that could use roughly 700 MiB while active. `2.2.10` added process shutdown and ten-minute idle resource release, but process-level model-load/release telemetry is not yet sufficient to decide whether a shared embedding broker is warranted.

### 3.8 Advanced-feature adoption

Some benchmark-inspired features have real data:

- 1,312 `source_file` entities across 11 stores,
- 3,843 `touched_in` edges and matching temporal history across 11 stores,
- 30 lessons across 6 stores,
- 7 checkpoints across 3 stores.

Several advanced surfaces had no rows in the inspected stores:

- core memory blocks,
- actions,
- facets,
- actor cards,
- perspective observations,
- assets and bindings,
- superseded entities.

Zero rows do not prove a feature is useless, but they do argue against expanding its default MCP surface before there is demonstrated adoption. Prefer profiles/extensions over deletion.

## 4. Lessons from prior comparisons

### 4.1 Already adopted

From memU and `mcp-memory-service`:

- fast/deep/auto retrieval,
- scoped retrieval filters,
- hybrid reranking,
- strict project scope,
- tag taxonomy,
- health/outbox visibility.

From memsearch:

- progressive Search -> Expand -> Source disclosure,
- source-ref navigation,
- clearer core/adapter/extension direction.

From SuperLocalMemory, Cognee, Letta, Mem0, and Zep/Graphiti:

- raw/derived memory separation concepts,
- code/file anchors,
- core memory blocks,
- entity supersession,
- temporal graph history,
- behavioral helpfulness signals.

From MemPalace:

- import-boundary guard,
- memory-layer manifest,
- source adapter contract,
- one Hermes source-adapter pilot,
- bounded source-neighbor expansion.

### 4.2 Still incomplete

- A reusable, typed derived-layer audit/rebuild contract.
- Read-only commands that provably never create/migrate storage.
- Source/presentation-aware usefulness measurement.
- A representative real-session benchmark suite.
- MCP handler modularization and tool profiles.
- Zero architecture-boundary baseline exceptions.
- Retrieval phase modules protected by large golden replay fixtures.
- Runtime evidence for or against a shared embedding broker.

## 5. Architecture and code map

Future agents should inspect these areas before editing:

- CLI composition: `src/apps/cli/index.ts`
- Vector status formatting/options: `src/apps/cli/vector-command.ts`
- Maintenance: `src/apps/cli/maintenance-runner.ts`, `src/apps/cli/maintenance-scheduler.ts`
- Project paths/identity: `src/core/registry/project-path.ts`, `src/core/registry/repo-identity.ts`
- Service creation/cache: `src/services/memory-service-registry.ts`
- Compatibility facade: `src/services/memory-service.ts`
- SQLite canonical store: `src/core/sqlite-event-store.ts`
- Vector/outbox: `src/core/vector-worker.ts`, `src/core/vector-outbox.ts`, `src/extensions/vector/`
- Claude SessionStart: `src/adapters/claude/hooks/session-start.ts`
- Prompt injection policy: `src/adapters/claude/hooks/prompt-injection-policy.ts`
- Semantic daemon: `src/adapters/claude/hooks/semantic-daemon.ts`
- Retrieval: `src/core/retriever.ts`, `src/core/engine/retrieval-orchestrator.ts`
- Helpfulness/analytics: `src/core/engine/retrieval-analytics-service.ts`, `src/core/sqlite-event-store.ts`
- MCP: `src/extensions/mcp/tools.ts`, `src/extensions/mcp/handlers.ts`, `src/extensions/mcp/index.ts`
- Architecture guard: `scripts/check-import-boundaries.mjs`
- Replay benchmark: `scripts/replay-retrieval-benchmark.ts`, `benchmarks/replay/`
- LongMemEval: `scripts/longmemeval-*.ts`, `benchmarks/longmemeval/`

At the time of this spec, `origin/main` also contains `src/extensions/mcp/idle-resources.ts` and process-lifecycle hardening that are absent from the older local worktree HEAD. Always inspect the latest branch.

## 6. Decisions that should not be reopened casually

1. SQLite events and governance records are canonical.
2. Lance/vector data is derived and must be rebuildable.
3. Maintenance may recover bounded retryable work but must not automatically rebuild or delete a whole derived layer.
4. Empty-store cleanup is separate from read-only correctness.
5. Automatic prompt injection must be stricter than exploratory CLI/dashboard search.
6. Reference indexes are navigation hints, not evidence.
7. MCP profile rollout must preserve existing clients before changing defaults.
8. A shared embedding broker is conditional on measured benefit; it is not an assumed destination.
9. Advanced features with little adoption should move behind profiles/extensions, not be expanded by default.
10. Tool mutation metadata needs three states: read-only, conditional, and mutating. `mem-context-pack` auto-refresh and preview/apply tools are conditional, not safely described by a binary flag.
11. `src/hooks`, `src/mcp`, and `src/server` contain compatibility entrypoints. Documentation should identify their canonical implementations, not remove the shims without a separate compatibility decision.
12. Do not add HTTP/SSE, a full code graph, a full learning platform, or a multi-agent mesh as part of this roadmap.

## 7. Safety boundaries

- Never run plugin `install`/`uninstall` in tests against the user's real settings.
- Never delete or reset `~/.claude-code/memory` as part of development.
- Never automatically clear quarantine.
- Never rebuild vectors in place; build separately, verify, then atomically swap.
- All cleanup/rebuild commands must default to dry-run and require explicit `--apply`.
- Project GC apply must stage candidates into a recoverable quarantine/trash location and write a restore manifest. Permanent purge is a separate, explicitly requested operation after a retention interval.
- Use a project lock and reject busy stores.
- Disk preflight must account for the existing layer, temporary rebuild, backup/rollback reserve, and the global minimum-free threshold.
- Public output must contain aggregate counts and opaque ids, not raw transcripts, secrets, or private filesystem paths.
- Production canaries require explicit user approval after code has shipped and fresh installation smoke has passed.

## 8. Related documents

- `docs/architecture/memory-layer-manifest.md`
- `docs/architecture/source-adapter-contract.md`
- `docs/architecture/mempalace-targeted-improvement-plan.md`
- `docs/ARCHITECTURE_COMPARISON_AND_RECOMMENDATIONS.md`
- `docs/MCP_MEMORY_SERVICE_COMPARATIVE_REVIEW.md`
- `docs/MEMORY_USEFULNESS_AUDIT.md`
- `specs/thin-core-refactor/`
- `specs/memory-utilization-improvements/`
- `specs/vector-outbox-v2/`
- `specs/memory-grounding-remediation/`

## 9. Open questions for implementation-time validation

- Should CLI commands accept both a filesystem project path and an opaque eight-character hash consistently, or should hash input use a separate option?
- Which tables/rows count as evidence that a tiny store is not disposable?
- What quarantine retention interval and restore/purge UX should project GC use on each supported platform?
- Should vector rebuild preserve current embedding version only, or support an explicit target version?
- How should a source-ref open be attributed when multiple previous injections reference the same event?
- Can MCP profiles be negotiated per client, or is environment/config selection sufficient for the first release?
- Does idle resource release materially reduce resident memory in real clients after ten minutes, or are most large processes continuously active?

Resolve these with tests and current code evidence; do not infer them solely from this document.
