# MemPalace-informed targeted improvement plan for claude-memory-layer

> Date: 2026-06-07
> Scope: architectural comparison and concrete next-step plan for `claude-memory-layer`, using the local MemPalace reference checkout as the comparison architecture.
> Non-secret policy: no credentials, connection strings, API keys, or private source content are included here.

## Executive summary

`claude-memory-layer` is already ahead of MemPalace in several product-critical areas: project-scoped memory operations, retrieval traces, action/frontier/checkpoint tooling, perspective memory, vector outbox recovery, and Claude/Hermes/Codex import surfaces. Its main architectural risk is not missing functionality; it is that feature growth has left several boundaries implicit.

MemPalace is most useful as a reference for boundary discipline:

1. storage and source integration are expressed as explicit contracts (`backends/base.py`, `sources/base.py`, RFC 002),
2. user-facing memory is presented as a small layered stack (`layers.py`),
3. search is a standalone orchestrator (`searcher.py`) rather than a side-effect of a broad service facade,
4. MCP exposes many capabilities, but its current monolithic shape is a cautionary example rather than something to copy directly.

The recommended direction is not to port MemPalace wholesale. Keep CML's SQLite-authoritative event store, project-scoped MCP operation model, and thin-core refactor trajectory. Add MemPalace-style contracts where CML currently has implicit adapters/importers and implicit derived layers.

## Evidence reviewed

### claude-memory-layer baseline

Reviewed files:

- `AGENTS.md`
- `package.json`
- `README.md`
- `docs/PROJECT_STRUCTURE_ANALYSIS.md`
- `docs/ARCHITECTURE_COMPARISON_AND_RECOMMENDATIONS.md`
- `docs/REFACTORING_MILESTONES_AND_ISSUES.md`
- `docs/TARGET_ARCHITECTURE_AND_FOLDER_STRUCTURE.md`
- `docs/REFACTORING_PLAN_THIN_CORE.md`
- `docs/architecture/comparison-index.md`
- `specs/thin-core-refactor/spec.md`
- `specs/thin-core-refactor/context.md`
- `specs/thin-core-refactor/plan.md`
- `src/services/memory-service.ts`
- `src/core/engine/memory-service-composition.ts`
- `src/core/engine/memory-engine-services.ts`
- `src/core/engine/memory-ingest-service.ts`
- `src/core/engine/memory-query-service.ts`
- `src/core/engine/retrieval-orchestrator.ts`
- `src/core/retriever.ts`
- `src/core/event-store.ts`
- `src/core/sqlite-event-store.ts`
- `src/core/vector-store.ts`
- `src/core/vector-outbox.ts`
- `src/core/operations/index.ts`
- `src/core/operations/graph-path-service.ts`
- `src/core/operations/frontier-service.ts`
- `src/extensions/mcp/handlers.ts`

Observed current state:

- `MemoryService` has become more of a compatibility facade, but it still imports and exposes many subsystem concepts.
- `createMemoryServiceComposition` and `createMemoryEngineServices` are good seams, but still construct concrete extension concerns from the core engine path.
- `MemoryIngestService` provides a useful ingest-side boundary and interceptor hooks.
- `RetrievalOrchestrator` and `Retriever` are powerful but still combine candidate generation, quality guards, fallback policy, ranking, graph hop, source context, shared memory, and output formatting in a relatively wide surface.
- `src/extensions/mcp/handlers.ts` centralizes a very large MCP handler surface, mixing tool routing, argument validation, memory operation dispatch, import refresh, market context, compression, and rendering.
- A quick import-boundary scan found these notable cross-layer couplings:
  - `core -> extensions`: `core/embedder.ts`, `core/engine/endless-memory-services.ts`, `core/engine/shared-memory-services.ts`
  - `services -> extensions`: `services/memory-service.ts` imports shared-memory and endless-memory extension indexes
  - `extensions -> services`: MCP handlers import `MemoryService` plus session-history importers
  - `adapters -> services`: Claude hooks call `MemoryService` directly

### MemPalace reference

Reviewed files:

- `README.md`
- `CLAUDE.md`
- `pyproject.toml`
- `mempalace/backends/base.py`
- `mempalace/sources/base.py`
- `docs/rfcs/002-source-adapter-plugin-spec.md`
- `mempalace/layers.py`
- `mempalace/searcher.py`
- `mempalace/dialect.py`
- `mempalace/palace.py`
- `mempalace/mcp_server.py`
- `mempalace/knowledge_graph.py`
- `mempalace/convo_miner.py`
- `mempalace/sweeper.py`
- `mempalace/diary_ingest.py`

Reference patterns worth borrowing:

- `BaseBackend` and `BaseCollection` make backend capabilities explicit with clear result types and exceptions.
- `BaseSourceAdapter` makes source ingest explicit through `SourceRef`, `SourceItemMetadata`, `DrawerRecord`, `AdapterSchema`, capabilities, privacy class, lifecycle, and close semantics.
- RFC 002 requires adapters to declare transformations, schemas, capabilities, incremental ingest behavior, privacy class, and conformance tests. This is the strongest MemPalace lesson for CML.
- `Layer0` to `Layer3` and `MemoryStack` make user-facing memory modes legible: identity, compressed index, recall, and search.
- `searcher.py` separates search orchestration from the storage/backend contract, including hybrid ranking, neighbor expansion, fallback modes, and result rendering.
- `knowledge_graph.py` records temporal graph triples with provenance-oriented fields; useful as a reference for CML graph operation maturity.

Reference patterns not worth copying directly:

- Full pluggable canonical storage backend. CML should keep SQLite as authoritative storage for now; making canonical storage pluggable would add risk without solving the current boundary problem.
- Monolithic MCP server shape. MemPalace's `mcp_server.py` exposes a broad surface in one file; CML should avoid letting `extensions/mcp/handlers.ts` keep growing in the same style.
- Chroma/AAAK-specific concepts as product goals. Their lesson is layered disclosure and compact indexes, not the exact storage/index format.

## Architectural comparison

### 1. Canonical storage and backend contracts

CML currently has a clear operational answer: SQLite is authoritative, LanceDB is derived acceleration, markdown is a human-readable projection, and shared/Mongo-style stores are optional replication/extension layers. The docs already describe this target. The remaining issue is that source-of-truth rules are more obvious in docs than in contracts.

MemPalace uses explicit backend interfaces with capability errors and typed result objects. CML does not need the same pluggable storage backend abstraction for canonical SQLite. It does need smaller ports around derived stores and extension-owned capabilities:

- `VectorIndexPort` for LanceDB/vector acceleration,
- `DerivedLayerPort` for rebuildable facts/summaries/graph/indexes,
- `MemoryExtensionPort` for shared/endless/MCP/analytics capabilities,
- a single core-facing composition interface that receives these ports instead of importing concrete extension indexes.

Target rule: core can define ports; extensions implement them. Core must not import extension modules.

### 2. Source ingest and importers

CML currently has several source/import paths: Claude hooks, Claude/Codex/Hermes session importers, MCP `mem-import-latest`, and tool-observation capture. These paths mostly converge on `MemoryIngestService`, which is good. But the source-side contract is implicit.

MemPalace's strongest contribution is RFC 002: each source adapter declares identity, version, schema, transformations, privacy class, capabilities, and test requirements. CML should adopt this pattern for import/capture sources.

Recommended CML concept:

```ts
interface MemorySourceAdapter {
  readonly name: string;
  readonly adapterVersion: string;
  readonly capabilities: readonly string[];
  readonly defaultPrivacyClass: PrivacyClass;
  describeSchema(): SourceAdapterSchema;
  ingest(source: SourceRef, context: SourceIngestContext): AsyncIterable<SourceRecord>;
  isCurrent?(item: SourceItemMetadata, existing?: ExistingSourceRecord): Promise<boolean>;
  close?(): Promise<void>;
}
```

This does not replace `MemoryIngestService`. It feeds it. `MemoryIngestService` remains the normalizer/appender/outbox coordinator.

Priority first-party adapters:

1. `claude-hook` for live hook capture,
2. `claude-history` for Claude transcript/session import,
3. `codex-history`,
4. `hermes-history`,
5. `tool-observation` if tool capture needs separate policy controls.

Adapter metadata should include at least:

- adapter name/version,
- source id and source version,
- source project hash or redacted project identifier (never raw absolute paths in exposed metadata),
- privacy class,
- declared transformations,
- capture mode (`live_hook`, `history_import`, `tool_observation`, `summary_backfill`, etc.),
- stable source references for source drill-down.

### 3. Memory layers and product mental model

CML already has raw events, session summaries, entries/entities/edges, lessons, actions, checkpoints, facets, actor cards, perspective observations, retrieval traces, and vector rows. The architecture is rich but not compactly explainable.

MemPalace's `Layer0` to `Layer3` model makes memory easier to reason about. CML should not copy the exact names, but should introduce a documented and testable layer manifest.

Recommended CML layer manifest:

| Layer | CML concept | Authoritative? | Rebuildable? | Main interfaces |
| --- | --- | --- | --- | --- |
| L0 Raw events | session/user/assistant/tool/import events | yes | no | `MemoryIngestService`, SQLite event store |
| L1 Extracted units | entries, entities, facets, lessons, actor observations | partly derived | yes from L0 + governance events | operation repositories, derivation services |
| L2 Summaries and continuity | session/project summaries, actor cards, context packs | derived/governed | partly | summary/perspective/context-pack services |
| L3 Retrieval surface | search results, expanded context, source refs, traces | no | yes | `Retriever`, `RetrievalOrchestrator`, disclosure services |
| L4 Optional accelerators | LanceDB rows, shared memory replicas, vector/index workers | no | yes | vector outbox, extension ports |

This would let docs, tests, MCP tool names, and recovery workflows all use the same language.

### 4. Retrieval orchestration

CML's retrieval is more advanced than MemPalace's in project scoping, graph expansion, debug lanes, fallback traces, context compression, and disclosure. But the code surface is broad.

MemPalace's useful pattern is not algorithmic superiority; it is that search is a clear subsystem with distinct phases.

Recommended CML split:

1. `QueryPlanBuilder`: classify query, scope mode, facets, graph-hop eligibility, source lanes.
2. `CandidateGenerator`: semantic, keyword, recent, summary, graph, perspective, shared lanes.
3. `CandidateRanker`: semantic/lexical/recency/facet/graph scoring and quality guards.
4. `ResultExpander`: session/turn/source expansion and progressive disclosure.
5. `ContextAssembler`: token budgeting, compression, citation rendering.
6. `RetrievalTraceRecorder`: trace persistence and helpfulness feedback.

This preserves the current behavior while making each phase easier to test and swap.

### 5. MCP surface and operation tooling

CML's MCP operation model is a differentiator: project-scoped memory actions, checkpoints, frontiers, facets, actor cards, perspective observations, graph query, retention audit, import refresh, and context packs are more governance-oriented than MemPalace's surface.

The risk is file-level concentration: `src/extensions/mcp/handlers.ts` is already a multi-thousand-line dispatcher. MemPalace's `mcp_server.py` shows what happens when MCP routing grows without bounded modules.

Recommended CML MCP refactor:

```text
src/extensions/mcp/
  index.ts
  router.ts
  schemas/
    common.ts
    context-pack.ts
    operations.ts
    import.ts
    market-context.ts
  handlers/
    context-pack-handler.ts
    import-handler.ts
    operation-handlers/
      facet.ts
      action.ts
      frontier.ts
      graph.ts
      perspective.ts
      actor.ts
      retention.ts
    external-market-context-handler.ts
  presenters/
    json-result.ts
    source-ref-presenter.ts
    context-pack-presenter.ts
```

Acceptance rule: no new MCP tool should be added directly to the root dispatcher after the split.

### 6. Maintenance and recovery workflows

CML already has stronger outbox machinery than MemPalace. `VectorOutbox` provides idempotent enqueue, claim, retries, stuck recovery, and metrics. The gap is that maintenance concepts are distributed across event store, query service, runtime service, importers, and extension handlers.

Borrow MemPalace's explicit workflow separation from `sweeper.py`, `convo_miner.py`, and `diary_ingest.py`, but implement it as typed CML jobs rather than scripts.

Recommended CML maintenance jobs:

- `ProcessEmbeddingOutboxJob`
- `ProcessVectorOutboxJob`
- `BackfillSessionSummariesJob`
- `ImportLatestSourceJob` using source adapters
- `RepairProjectScopeJob`
- `RebuildDerivedLayerJob`
- `VerifySourceAdapterConformanceJob`

Each job should expose:

- input schema,
- dry-run support where relevant,
- idempotency key,
- progress metrics,
- failure/retry policy,
- audit event / operation log linkage.

## Targeted implementation plan

### P0 — make boundaries enforceable before adding more capability

#### P0.1 Add an import-boundary guard

Goal: convert the current thin-core intent into an automated check.

Files to add or modify:

- Add `scripts/check-import-boundaries.mjs`
- Add a package script such as `check:architecture`
- Add CI invocation if CI config exists

Rules:

- `src/core/**` may not import `src/extensions/**`, `src/adapters/**`, `src/apps/**`, or `src/services/**`.
- `src/extensions/**` may import core ports/types, but should not import `src/services/memory-service.ts` after the MCP split.
- `src/adapters/**` may use a public app/service facade, but Claude hooks should progressively depend on adapter-facing ports rather than the full `MemoryService` class.
- legacy compatibility wrappers (`src/hooks`, `src/mcp`) may re-export but not grow new logic.

Current known violations to drive the first fix:

- `src/core/embedder.ts -> src/extensions/vector/index.ts`
- `src/core/engine/endless-memory-services.ts -> src/extensions/endless-memory/index.ts`
- `src/core/engine/shared-memory-services.ts -> src/extensions/shared-memory/index.ts`
- `src/extensions/mcp/handlers.ts -> src/services/memory-service.ts`

Verification:

- `npm run check:architecture`
- `npm test -- --run`

#### P0.2 Define CML source adapter contracts

Goal: standardize Claude/Codex/Hermes import and hook capture before more source types are added.

Files to add:

- `src/core/source/source-ref.ts`
- `src/core/source/source-adapter.ts`
- `src/core/source/source-schema.ts`
- `src/core/source/source-transformations.ts`
- `src/core/source/source-adapter-contract-suite.ts` or test helpers under `tests/`
- `docs/architecture/source-adapter-contract.md`

Initial adapters to wrap existing code:

- `src/adapters/claude/source/claude-hook-adapter.ts`
- `src/adapters/claude/source/claude-history-adapter.ts`
- `src/adapters/codex/source/codex-history-adapter.ts`
- `src/adapters/hermes/source/hermes-history-adapter.ts`

Contract requirements borrowed from MemPalace, adapted for CML:

- stable source id and source version,
- declared transformations,
- privacy class,
- schema declaration,
- incremental ingest/currentness check,
- close semantics,
- source-ref options must not contain secrets,
- conformance tests for stable identity, schema conformance, and declared transformations.

Verification:

- New contract tests for one adapter first, likely `claude-history` or `hermes-history` because they are import-like and easier to fixture.
- Existing import tests must still pass.

#### P0.3 Document the layer manifest and source-of-truth contract

Goal: make CML's memory layers as legible as MemPalace's stack without renaming existing tables prematurely.

Files to add or update:

- Add `docs/architecture/memory-layer-manifest.md`
- Update `docs/TARGET_ARCHITECTURE_AND_FOLDER_STRUCTURE.md`
- Update `specs/thin-core-refactor/context.md`

Must state:

- SQLite event store is authoritative for raw events and governance records.
- Markdown mirror is human-readable projection, not independent truth.
- LanceDB/vector rows are derived and rebuildable.
- Shared/endless/Mongo-style stores are extension/replication layers.
- MCP tools should disclose which layer they query or mutate.

Verification:

- Docs mention every currently exposed memory family: events, entries/entities/edges, facets, lessons, actions, checkpoints, actor cards, perspective observations, summaries, retrieval traces, vectors, shared memory.

### P1 — reduce core/service coupling while preserving behavior

#### P1.1 Invert extension construction

Goal: `core` defines extension ports; composition wires implementations from `services` or `extensions` without core importing extension implementations.

Files likely involved:

- `src/core/engine/memory-engine-services.ts`
- `src/core/engine/memory-service-composition.ts`
- `src/core/engine/shared-memory-services.ts`
- `src/core/engine/endless-memory-services.ts`
- `src/extensions/shared-memory/index.ts`
- `src/extensions/endless-memory/index.ts`
- `src/extensions/vector/index.ts`

Plan:

1. Introduce `src/core/ports/vector-index-port.ts`.
2. Introduce `src/core/ports/extension-runtime-port.ts` or narrow named ports.
3. Move extension factory calls to `src/services/memory-service-composition.ts` or `src/extensions/*/factory.ts` invoked by service layer.
4. Keep existing public `MemoryService` API stable.

Verification:

- Architecture guard passes.
- Existing public imports continue to compile.
- Tests around shared/endless/vector behavior pass.

#### P1.2 Split retrieval into phase modules

Goal: preserve current retrieval output while making each decision independently testable.

Files likely involved:

- `src/core/retriever.ts`
- `src/core/engine/retrieval-orchestrator.ts`
- `src/core/engine/retrieval-services.ts`
- new `src/core/retrieval/*`

Suggested sequence:

1. Extract pure `QueryPlanBuilder` from option normalization, quality query, command-artifact guard, scope mode, and graph-hop policy.
2. Extract `CandidateRanker` from semantic/lexical/recency/facet/graph weighting.
3. Extract `ResultExpander` from session/source/context expansion.
4. Move formatting/token budgeting into `ContextAssembler`.
5. Keep `Retriever.retrieve()` as the compatibility entry point.

Verification:

- Golden retrieval tests for representative queries before extraction.
- Candidate debug and selected debug traces remain stable enough for dashboard consumers.

#### P1.3 MCP handler modularization

Goal: prevent CML's MCP server from becoming MemPalace-style monolithic routing.

Files likely involved:

- `src/extensions/mcp/handlers.ts`
- new `src/extensions/mcp/handlers/*`
- new `src/extensions/mcp/schemas/*`
- new `src/extensions/mcp/presenters/*`

Plan:

1. Extract common argument helpers and JSON result helpers.
2. Move memory operation tools into bounded handlers.
3. Move import refresh/context pack handling into dedicated handlers.
4. Add a registry table mapping tool name to schema and handler.
5. Keep `handleToolCall(name, args)` as compatibility entry point.

Verification:

- MCP handler tests cover every tool name in the registry.
- Typecheck catches missing handlers.

### P2 — improve source-aware retrieval and graph quality

#### P2.1 Add source-aware retrieval lanes

Goal: let context packs and search output distinguish live hooks, history imports, summaries, tool observations, and governed facts.

Files likely involved:

- source adapter metadata from P0.2
- `src/core/retriever.ts`
- `src/core/engine/retrieval-orchestrator.ts`
- `src/core/context-compressor.ts`
- source-ref presenter in MCP

Capabilities:

- Filter by source adapter/source type.
- Prefer governed facts/summaries for broad continuation queries.
- Prefer raw/tool/source refs for debugging and provenance queries.
- Surface declared transformations in source refs when output is not raw/verbatim.

Verification:

- Tests for source-filtered retrieval.
- Context pack output includes source lane labels without leaking raw private data.

Implemented first slice (2026-06-07):

- `mem-source-ref` now accepts `includeNeighbors` and `neighborWindow` so an agent can expand a cited hit to bounded before/after events from the same session.
- Neighbor previews use the existing MCP privacy filter and content budget clamps; they expose citation/source-ref metadata rather than raw transcript dumps.
- Covered by `tests/extensions/mcp-context-tools.test.ts` for schema exposure, neighbor-window bounds, and secret redaction.

#### P2.2 Introduce rebuildable derived-layer jobs

Goal: make facts, summaries, vectors, graph edges, actor cards, and retrieval indexes visibly rebuildable when their derivation logic changes.

Files likely involved:

- `src/core/engine/*maintenance*`
- `src/core/operations/*`
- `src/core/vector-outbox.ts`
- new `src/core/layers/*`

Plan:

1. Define `DerivedLayerDescriptor` with `name`, `version`, `inputs`, `outputs`, `rebuild`, `verify`.
2. Register descriptors for vectors, summaries, lessons, perspective observations, graph paths/edges where appropriate.
3. Add dry-run layer audit: what is stale, missing, or failed.
4. Expose through CLI and MCP only after internal tests exist.

Verification:

- Rebuild jobs are idempotent.
- Dry-run reports no mutation.
- Vector outbox and derived-layer rebuild do not fight over the same rows.

#### P2.3 Upgrade graph provenance and temporal semantics

Goal: borrow MemPalace KG's temporal/provenance discipline without replacing CML's current entity-edge model.

Files likely involved:

- `src/core/operations/graph-path-service.ts`
- entity/edge repositories and schema migrations
- MCP graph query handler

Plan:

- Add optional `valid_from`, `valid_to`, `source_event_ids`, `source_adapter`, `source_record_id`, and `confidence` fields to graph edges or edge metadata.
- Teach graph query/presentation to show provenance and active/inactive status.
- Keep `maxHops <= 2` safety clamp unless a separate performance review approves more.

Verification:

- Existing graph path tests pass.
- New tests cover expired/invalidated edges and provenance rendering.

## Work packet sequencing

### Packet A: Architecture guard + layer manifest

Why first: lowest risk, immediately prevents future boundary drift.

Deliverables:

- import-boundary checker,
- `memory-layer-manifest.md`,
- docs update linking this plan into the architecture index.

Expected verification:

- `npm run check:architecture`
- `npm run typecheck`

### Packet B: Source adapter contract + one pilot adapter

Why second: highest MemPalace-derived leverage.

Deliverables:

- source adapter types,
- source contract doc,
- one pilot adapter wrapping an existing importer,
- contract tests.

Expected verification:

- adapter contract tests,
- existing import tests,
- no public MCP behavior change.

### Packet C: Extension port inversion

Why third: core boundary cleanup after contracts are explicit.

Deliverables:

- ports under `src/core/ports` or equivalent,
- no `core -> extensions` imports,
- service-layer composition still constructs extension implementations.

Expected verification:

- architecture guard passes with stricter rules,
- typecheck and existing unit tests.

### Packet D: MCP modularization

Why fourth: reduces future maintenance cost and enables safer tool additions.

Deliverables:

- handler registry,
- bounded handler modules,
- schema/presenter split,
- compatibility wrapper.

Expected verification:

- MCP tool registry tests,
- no missing tool names,
- manual smoke for `mem-context-pack`, `mem-import-latest`, `mem-frontier`, and `mem-graph-query`.

### Packet E: Retrieval phase split

Why fifth: high-value but riskier; do after boundary and test scaffolding.

Deliverables:

- query plan, candidate generation, ranker, expander, assembler modules,
- golden retrieval tests,
- trace compatibility review.

Expected verification:

- retrieval tests,
- dashboard smoke for trace/debug data,
- real project `mem-context-pack` smoke.

## Non-goals

- Do not replace SQLite as CML's canonical store.
- Do not port MemPalace's Chroma backend, AAAK dialect, or palace terminology wholesale.
- Do not make canonical storage pluggable until CML has a concrete user/business reason and a full migration story.
- Do not add new source types before the source adapter contract exists.
- Do not grow `src/extensions/mcp/handlers.ts` with more direct tool branches after modularization starts.

## Success criteria

The MemPalace comparison should be considered acted on when CML has:

1. an enforced import-boundary check,
2. a documented memory-layer manifest,
3. a source adapter contract with conformance tests,
4. at least one existing importer migrated behind that contract,
5. no direct `core -> extensions` imports,
6. MCP tools routed through bounded handler modules,
7. retrieval behavior preserved while the retrieval implementation is split into phase-level modules.

## Recommended immediate next task

Start with Packet A. It is small, reversible, and creates guardrails for every later packet:

1. add `scripts/check-import-boundaries.mjs`,
2. add `npm run check:architecture`,
3. write `docs/architecture/memory-layer-manifest.md`,
4. link this plan and the manifest from `docs/architecture/comparison-index.md`,
5. run typecheck/tests.

This sequence keeps CML's current thin-core momentum and uses MemPalace where it is strongest: contracts, layer clarity, and adapter conformance.
