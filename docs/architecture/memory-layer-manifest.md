# CML Memory Layer Manifest

This manifest is the source-of-truth contract for how `claude-memory-layer` talks about its memory layers during the thin-core refactor. It makes the current stack legible without requiring premature table or API renames.

## Source-of-truth contract

1. SQLite event store is authoritative for raw events and governance records.
   - Raw conversation/tool/import events live in `events` and related session metadata.
   - Governance/audit state for memory operations lives in SQLite tables such as `memory_governance_audit`, `memory_actions`, `memory_checkpoints`, and related operation projections.
   - If a derived layer disagrees with SQLite, SQLite wins.
2. Markdown mirror is a human-readable projection, not independent truth.
   - Journal/export files may help humans inspect continuity, but they are rendered from stored state and should not be treated as a second canonical database.
3. LanceDB/vector rows are derived and rebuildable.
   - Vector indexes accelerate retrieval. They should be rebuildable from SQLite-backed events, entries, summaries, and outbox jobs.
   - `embedding_outbox` and `vector_outbox` are durable coordination queues for rebuilding or retrying derived vectors; they are not the semantic source of the underlying memory.
4. Shared/endless/Mongo-style stores are extension and replication layers.
   - Shared memory, endless/continuity working sets, consolidated memories, and Mongo sync may replicate, cache, or promote memory for product workflows.
   - They must not silently become canonical sources for raw private events or governance decisions.
5. MCP tools must disclose which layer they query or mutate.
   - Read tools should name whether they are reading raw events, derived projections, retrieval traces, vector-backed search results, or extension replicas.
   - State-changing tools should name the SQLite projection/audit records they mutate and should retain bounded evidence references rather than raw private content.

## Layer map

| Layer | Role | Canonical? | Rebuildable? | Current implementation anchors |
| --- | --- | --- | --- | --- |
| L0 raw event store | Append-only event/session substrate and source references. | Yes for raw events. | No; preserve, do not regenerate from projections. | `events`, `sessions`, `event_dedup`; `src/core/sqlite-event-store.ts`; `src/core/engine/memory-ingest-service.ts` |
| L1 extracted/governed units | Structured memory units and governance projections derived from or attached to L0 evidence. | Authoritative for explicit governed operations; derived for extracted facts. | Usually rebuildable from L0 plus governance audit events. | `entries`, `entities`, `entity_aliases`, `edges`, `insights`, `memory_facets`, `memory_lessons`, `memory_actions`, `memory_action_edges`, `memory_checkpoints`, `memory_retention_scores`, `memory_governance_audit`; `src/core/operations/*` |
| L2 continuity and perspective | Human/agent continuity views: summaries, actor cards, perspective observations, working sets, consolidated memories/rules. | Authoritative only for explicit governed perspective/card writes; otherwise derived. | Partly; actor cards and manual observations preserve governed writes, summaries/working sets can be recomputed. | `sessions.summary`, `actor_cards`, `perspective_observations`, `memory_actors`, `session_actors`, `working_set`, `consolidated_memories`, `continuity_log`, `consolidated_rules` |
| L3 retrieval and disclosure | Query-time search, context-pack assembly, source drill-down, helpfulness, and trace telemetry. | No; it explains retrieval behavior over lower layers. | Yes, except feedback/audit observations that are explicit governance records. | `retrieval_traces`, `memory_helpfulness`; `src/core/retriever.ts`; `src/core/engine/retrieval-orchestrator.ts`; `src/core/engine/retrieval-disclosure-service.ts`; `src/extensions/mcp/handlers.ts` |
| L4 acceleration and outbox | Embedding/vector acceleration and rebuild coordination. | No for vectors; outboxes are durable operational queues. | Yes for vector rows; outbox state is replay/retry coordination. | `embedding_outbox`, `vector_outbox`; `src/core/vector-store.ts`; `src/core/vector-outbox.ts`; `src/core/vector-worker.ts`; `src/extensions/vector/*` |
| L5 extension/replication surfaces | Shared memory, endless/continuity modes, Mongo sync, app/API/MCP surfaces. | No unless a tool explicitly writes governed SQLite records. | Extension-dependent; replicas must be recoverable or resyncable from canonical SQLite plus declared external contracts. | `src/extensions/shared-memory/*`; `src/extensions/endless-memory/*`; `src/core/shared-event-store.ts`; `src/core/shared-vector-store.ts`; `src/core/mongo-sync-worker.ts`; `src/apps/cli/mongo-sync-command.ts`; `src/extensions/mcp/*` |

## Exposed memory families

### Events

- Tables/records: `events`, `sessions`, `event_dedup`.
- Layer: L0.
- Contract: raw user/assistant/tool/import/session-summary events are canonical in SQLite. Source refs should point back to event ids or bounded source-reference handles instead of exposing raw transcript paths or private content.
- MCP/API disclosure: `mem-search`, `mem-timeline`, `mem-details`, `mem-stats`, `mem-project-timeline`, and `mem-source-ref` should be clear when they are reading event rows or event-derived previews.

### Entries, entities, and edges

- Tables/records: `entries`, `entities`, `entity_aliases`, `edges`, `insights`.
- Layer: L1.
- Contract: structured units and graph relationships are extracted or governed projections over L0 evidence. Their ids may be used as stable handles, but raw evidence remains in L0.
- Rebuild rule: extraction logic may rebuild or supersede these records; never treat vector hits or markdown output as the canonical entity graph.
- MCP/API disclosure: `mem-graph-query` should disclose that it queries bounded entity/edge projections and returns sanitized graph paths.

### Facets

- Tables/records: `memory_facets`.
- Layer: L1.
- Contract: facets are scoped tags on events, entities, edges, consolidated memories, lessons, or actions. Manual/governed facet writes are authoritative as governance records; automated facets are rebuildable projections with confidence and evidence pointers.
- MCP/API disclosure: `mem-facet-query` reads facet projections. `mem-facet-tag` mutates `memory_facets` and should audit actor, target, dimension, value, confidence, and bounded source event ids.

### Lessons

- Tables/records: `memory_lessons`.
- Layer: L1.
- Contract: lessons are procedural/runbook candidates derived from successful workflows or explicitly curated. They are not raw transcript content.
- Rebuild rule: automated lesson mining can be rerun, but manual skill-candidate decisions should remain governed writes.
- MCP/API disclosure: `mem-lesson-list` reads compact lesson projections and should avoid returning raw private sources.

### Actions

- Tables/records: `memory_actions`, `memory_action_edges`, `memory_leases`.
- Layer: L1.
- Contract: actions are project-scoped execution-frontier records. Status changes are governed operational writes, not inferred truth from chat snippets.
- MCP/API disclosure: `mem-action-list`, `mem-action-update`, and `mem-frontier` should state that they query or mutate action/frontier projections in SQLite and include audit metadata for state changes.

### Checkpoints

- Tables/records: `memory_checkpoints`.
- Layer: L1.
- Contract: checkpoints are resumable operation snapshots linked to actions or sessions. They may include bounded state, but should avoid secrets, raw transcript payloads, and private local paths in user-facing output.
- MCP/API disclosure: `mem-checkpoint-create` mutates checkpoint projections with audit context. `mem-checkpoint-list` reads compact checkpoint metadata.

### Actor cards

- Tables/records: `memory_actors`, `session_actors`, `actor_cards`.
- Layer: L2.
- Contract: actor cards are compact observer-to-observed perspective summaries. They are governed perspective records, not raw conversation mirrors.
- Rebuild rule: an automatic maintenance job may suggest updates, but replacing card entries is a state-changing write that should be audited and evidence-bounded.
- MCP/API disclosure: `mem-actor-list`, `mem-actor-card-get`, and `mem-actor-card-upsert` should distinguish actor identity metadata from actor-card content and should identify card upsert as a SQLite/governance mutation.

### Perspective observations

- Tables/records: `perspective_observations`, `perspective_observations_fts`.
- Layer: L2.
- Contract: observations are observer-to-observed claims with level, confidence, and evidence references. Soft deletion is the exposed deletion model; hard deletion is not part of normal MCP operation tooling.
- Rebuild rule: derived observations can be regenerated from evidence and policy, but explicit/manual observations remain governed writes.
- MCP/API disclosure: `mem-perspective-query`, `mem-perspective-context`, `mem-perspective-observation-create`, and `mem-perspective-observation-delete` should disclose that they query/mutate perspective SQLite projections and FTS search indexes, not raw transcript stores.

### Summaries and context packs

- Tables/records: `sessions.summary`, `insights`, `consolidated_memories`, `consolidated_rules`, plus rendered context-pack output.
- Layer: L2 for stored continuity summaries; L3 for assembled context-pack output.
- Contract: summaries and context packs are compressed projections over L0/L1/L2 data. They improve continuity and token efficiency, but are not independent truth.
- Rebuild rule: summaries/context packs can be refreshed when source events or compression policy changes. If a summary conflicts with source refs, source refs and L0 evidence win.
- MCP/API disclosure: `mem-context-pack` and `mem-project-timeline` should disclose relevant source lanes, compression/trimming, refresh behavior, and whether they imported/processed fresh local history before retrieval.

### Retrieval traces and source refs

- Tables/records: `retrieval_traces`, `memory_helpfulness`, source-ref/citation handles.
- Layer: L3.
- Contract: retrieval traces explain query planning, candidate generation, selected events, fallback behavior, and confidence. Source refs resolve ids into bounded, privacy-filtered previews; they are evidence pointers, not unbounded transcript disclosure.
- Rebuild rule: traces are operational telemetry and should not be replayed as memory content. They may be retained or audited separately from canonical event storage.
- MCP/API disclosure: `mem-source-ref` should prefer redacted previews and safe metadata. `mem-details` should be used only when full content is intentionally requested and privacy policy permits it.

### Vectors and vector outbox

- Tables/records: LanceDB/vector rows, `embedding_outbox`, `vector_outbox`.
- Layer: L4.
- Contract: vector rows are derived accelerators. The durable source for what should be embedded is SQLite-backed event/entry/summary state plus outbox coordination.
- Rebuild rule: vector stores can be dropped and rebuilt from canonical rows and outbox jobs. Failed/stuck vector jobs should be recovered by outbox maintenance, not by treating stale vectors as truth.
- MCP/API disclosure: search tools using semantic/vector lanes should disclose that vector candidates are derived and selected against lower-layer source refs.

### Shared, endless, and Mongo-style extension layers

- Tables/records: shared stores/vector stores, `working_set`, `consolidated_memories`, `continuity_log`, `consolidated_rules`, Mongo sync positions/replicas.
- Layer: L5, with some continuity tables also surfaced as L2 projections.
- Contract: these layers are extension or replication surfaces. They may promote memories, maintain active working sets, provide cross-project/shared retrieval, or replicate SQLite events into another backend; they do not replace SQLite as the authoritative event/governance store.
- Rebuild/resync rule: extension layers should define whether they are rebuildable, resyncable, or manually governed. Packet B/C/D/E work should turn those implicit rules into explicit ports, conformance tests, and recovery jobs.
- MCP/API disclosure: any MCP tool or CLI command that reads shared/endless/Mongo-style data should label that lane separately from project-local canonical SQLite data.

## MCP disclosure checklist

Every new or refactored MCP tool should answer these questions in its schema, result envelope, or docs:

1. Which memory family does the tool query or mutate?
2. Which layer is involved: L0 raw events, L1 projections/governance, L2 continuity/perspective, L3 retrieval/disclosure, L4 vector acceleration, or L5 extension/replication?
3. Is the returned content canonical, derived, rebuilt on demand, or a replica?
4. For mutations, which SQLite table/projection is changed and what audit/evidence fields are recorded?
5. For reads, are source refs bounded and privacy-filtered? If compression/trimming happened, is that disclosed?
6. If a vector/shared/endless/Mongo lane contributed results, is that lane labeled separately from canonical SQLite evidence?

## Packet work implications

- Packet B source adapter work should make source identity, privacy class, transformations, incremental ingest, and evidence handles explicit before adding more import sources.
- Packet C retrieval work should keep context-pack/retrieval output anchored to source refs and trace records, not to markdown mirrors or vector rows.
- Packet D vector/outbox work should preserve the rule that vectors are rebuildable accelerators and outboxes are operational coordination.
- Packet E MCP/API work should enforce the disclosure checklist above and prevent new tools from hiding which layer they touch.

## Non-goals

- Do not rename existing SQLite tables just to match this manifest.
- Do not make canonical storage pluggable before the thin-core boundary is enforceable.
- Do not expose transcript database paths, credentials, raw private content, or hidden local storage details in architecture docs or MCP result envelopes.
- Do not treat markdown mirrors, vector indexes, shared memory replicas, endless working sets, or Mongo replicas as independent truth.
