# Context: Honcho-inspired Peer Context Memory

> **Created**: 2026-05-23
> **Reference repo**: `honcho`
> **Target repo**: `claude-memory-layer`

## 1. Summary

Honcho is a memory service built around **peers** and **perspectives**. It stores messages from peers in sessions, derives observations about peers, and retrieves a curated representation of one peer from another peer's perspective.

The strongest ideas to bring into CML are not the HTTP server itself, but these product/architecture primitives:

1. **Peer/actor identity as a first-class object**
2. **Observer → observed perspective collections**
3. **Peer cards** as compact durable identity/instruction markers
4. **Separate raw messages, summaries, explicit observations, and derived observations**
5. **Query-time dialectic agent** that uses tools only when needed
6. **Offline dream/consolidation specialists** for higher-level deductions and patterns
7. **Scoped auth/config/observe policy** to prevent over-collection and cross-scope leakage
8. **Scenario-style tests** that validate memory behavior end-to-end

CML already has strong foundations: SQLite EventStore, project-scoped memory stores, retrieval fallback stages, graph/facet/action/lesson operations, privacy filtering, MCP tools, and session importers. What is missing is the Honcho-like perspective layer.

## 2. Honcho source observations

### 2.1 Data model

Inspected files:

- `honcho/src/models.py`
- `honcho/src/schemas/configuration.py`
- `honcho/src/schemas/api.py`

Relevant model structure:

- `Workspace`: top-level isolation boundary.
- `Peer`: named participant within a workspace.
- `Session`: named conversation/task boundary within a workspace.
- `session_peers`: many-to-many session membership with per-session configuration and join/leave timestamps.
- `Message`: immutable message linked to `(workspace, session, peer)` with token count and sequence number.
- `MessageEmbedding`: separate embedding table for message search.
- `Collection`: unique `(workspace, observer, observed)` tuple.
- `Document`: observation/conclusion inside a collection, with `level`, `source_ids`, optional `session_name`, embedding sync state, and soft delete.

Key takeaway for CML: CML does not need Honcho's Postgres schema, but should adopt the `observer + observed + optional session` axis for derived memory.

### 2.2 Observe policy

Inspected files:

- `honcho/src/schemas/configuration.py`
- `honcho/src/deriver/enqueue.py`
- `honcho/src/exceptions.py`

Honcho has:

- `PeerConfig.observe_me`: whether Honcho forms a representation of this peer.
- `SessionPeerConfig.observe_others`: whether this peer forms session-level theory-of-mind representations of other peers.
- Queue generation that:
  - self-observes the sender when `observe_me` is true/defaulted.
  - adds other observing peers only when their session config has `observe_others`.
  - caps observers per session via `SESSION_OBSERVERS_LIMIT`.

Key takeaway for CML: perspective memory must be opt-in/capped. Without observe policy, group chat or multi-agent runs can create O(N²) derived records and privacy risk.

### 2.3 Representation and peer context APIs

Inspected files:

- `honcho/src/routers/peers.py`
- `honcho/src/routers/sessions.py`
- `honcho/src/schemas/api.py`

Honcho exposes:

- peer representation: curated observation subset for an observed peer from an observer perspective.
- peer card: compact profile list for an observed peer from an observer perspective.
- peer context: representation + peer card in one API.
- session context: messages + summary, optionally augmented with peer representation/card and constrained by token budget.
- perspective parameters: `peer_target`, `peer_perspective`, `limit_to_session`, `search_query`, `search_top_k`, `search_max_distance`, `include_most_frequent`, `max_conclusions`.

Key takeaway for CML: `mem-context-pack` can evolve from project/session memory pack into perspective-aware context pack without breaking current behavior.

### 2.4 Deriver pipeline

Inspected file:

- `honcho/src/deriver/deriver.py`

Honcho's minimal deriver:

- receives a batch of messages and an `observed` peer.
- builds a single prompt with timestamped turns.
- performs one structured LLM call to extract a representation.
- converts output into observations.
- saves the same observations into every configured observer's collection.
- records telemetry and source message ids.
- avoids processing when reasoning is disabled.

Key takeaway for CML: a bounded batch deriver can be added after schema/read APIs, but should be optional and guarded by source-evidence validation.

### 2.5 Dialectic agent

Inspected files:

- `honcho/src/dialectic/core.py`
- `honcho/src/utils/agent_tools.py`

Honcho's dialectic agent:

- initializes with workspace, session, observer, observed, optional peer cards, and reasoning level.
- can inject recent session history.
- prefetches explicit observations separately from higher-level observations to reduce retrieval dilution.
- uses a tool loop with `search_memory`, `search_messages`, and reasoning-chain tools.
- has a minimal tool set for low-cost reasoning.
- emits telemetry for tool calls, token usage, and prefetched observation count.

Key takeaway for CML: query-time agentic retrieval should be optional and layered after deterministic retrieval. Most value can come first from better context pack assembly.

### 2.6 Dreamer specialists

Inspected files:

- `honcho/src/dreamer/orchestrator.py`
- `honcho/src/dreamer/specialists.py`
- `honcho/src/utils/agent_tools.py`

Honcho's dream cycle:

- optionally samples high-surprisal observations as hints.
- runs deduction then induction specialists.
- specialists use tools to search observations/messages and create higher-level observations.
- deduction may update the peer card; induction does not.
- all runs have bounded iterations, telemetry, and failure-path events.

Key takeaway for CML: a dreamer-like consolidator is P2/P3. It should not block the P0 schema/context-pack value.

### 2.7 Tool validation and peer card safeguards

Inspected file:

- `honcho/src/utils/agent_tools.py`

Honcho validates peer card entries structurally:

- allowed prefixes: `IDENTITY:`, `ATTRIBUTE:`, `RELATIONSHIP:`, `INSTRUCTION:`
- max card facts: 40
- max entry length: 200 chars
- full replacement/deduplication pattern

It also validates observation creation inputs by level:

- `deductive` requires source ids and premises.
- `inductive` requires at least two source ids, sources, pattern type, confidence.
- `contradiction` requires at least two sources.

Key takeaway for CML: validation should be strict and schema-level, because LLM-generated durable memory can otherwise become noisy or unsafe.

### 2.8 Scoped keys/auth

Inspected files:

- `honcho/src/security.py`
- `honcho/src/routers/keys.py`

Honcho uses JWT fields scoped to admin/workspace/peer/session. CML is primarily local/MCP, so this exact mechanism is not needed. The lesson is still useful: every mutating operation should be scoped and auditable.

Key takeaway for CML: MCP mutation tools should require `projectPath`, actor/audit metadata, and fail closed when scope is absent.

### 2.9 Unified scenario tests

Inspected file:

- `honcho/tests/unified/README.md`

Honcho supports JSON test cases with steps:

- set workspace/session config
- create sessions with peers/config
- add messages
- wait for queue empty
- query chat/context/representation/card
- assert with substrings, JSON matching, exact match, or LLM-as-judge

Key takeaway for CML: memory quality needs scenario tests, not just unit tests. This is especially true for perspective behavior.

## 3. CML current state relevant to this spec

Inspected files:

- `src/core/types.ts`
- `src/core/sqlite-event-store.ts`
- `src/core/retriever.ts`
- `src/services/memory-service.ts`
- `src/extensions/mcp/tools.ts`
- `src/extensions/mcp/handlers.ts`

Relevant CML capabilities:

- `MemoryEvent` with `eventType`, `sessionId`, `content`, `canonicalKey`, metadata.
- `Session` with `projectPath`, summary, tags.
- project-scoped storage via `projectPath`/`projectHash`.
- `Retriever` with vector/keyword retrieval, fallbacks, project scope modes, graph hop, facets, selected/candidate debug.
- operations layer with facets, actions, checkpoints, frontier, retention audit, graph path, lessons.
- MCP tools for search/context/timeline/source-ref/import and operations.
- privacy filter and source reference utilities.

Current gap:

- no explicit actor registry.
- no session actor membership table.
- no observer/observed perspective collection.
- no actor card abstraction.
- no first-class observation levels (`explicit`, `deductive`, `inductive`, `contradiction`) connected to actor perspectives.
- no scenario runner for multi-actor memory behavior.

## 4. Design mapping for CML

### 4.1 Minimal viable mapping

CML can implement the first useful slice without adding agentic LLM derivation:

1. Project actors from existing events/import metadata.
2. Store actor cards manually or through explicit MCP commands.
3. Store perspective observations manually or through deterministic rules.
4. Extend `mem-context-pack` with perspective options.
5. Return actor card + perspective observations alongside normal project context.

This yields immediate product value for Hermes group-chat and multi-agent sessions while keeping risk low.

### 4.2 Existing specs to reuse

- `entity-edge-model`: use for actor/session/observation relationships once graph substrate is available.
- `agentmemory-inspired-memory-operations`: reuse governance audit, facets, lessons, and MCP operation patterns.
- `memory-utilization-improvements`: reuse retrieval trace/helpfulness evaluation ideas for measuring actor-context impact.
- `progressive-disclosure`: reuse source-ref privacy-safe expansion pattern.

### 4.3 What not to copy from Honcho

- Do not copy FastAPI/Postgres/pgvector as-is. CML is local-first TypeScript/SQLite.
- Do not require a server to answer local MCP calls.
- Do not create all observer/observed combinations by default.
- Do not make LLM-generated observations part of the default ingestion path until P0/P1 validation is green.
- Do not expose raw peer cards or source messages in group contexts.

## 5. Recommended implementation order

1. **P0: Schema + repositories + context pack read path**
   - actor registry
   - session actor membership
   - actor cards
   - perspective observations
   - read-only MCP/query path

2. **P1: Safe mutation + retrieval integration**
   - actor card upsert with validation
   - observation create/delete with source evidence
   - `mem-context-pack` perspective options
   - retrieval lane separation

3. **P2: Deriver**
   - selected event batches → explicit observations
   - idempotent queue/outbox
   - project feature flag

4. **P3: Dialectic and dreamer**
   - tool-using perspective query agent
   - deduction/induction/contradiction specialists
   - actor card update suggestions

## 6. Risks and mitigations

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| O(N²) observation growth | group chats and subagents can multiply records | default self-only observation, max observers, feature flags |
| privacy leakage | actor memory may contain personal facts | privacy filter, source refs, no raw transcript in card metadata |
| retrieval dilution | derived observations can crowd out direct evidence | separate retrieval lanes and debug trace |
| hallucinated durable facts | LLM derivation may overclaim | source evidence required, confidence, validation, manual review path |
| project contamination | global actors can leak project details | projectHash required for project facts, global actor card only for general preferences |
| token bloat | cards/observations can overfill context | hard caps, token budget allocation, progressive disclosure |

## 7. Example target behavior

Given a Discord thread with user `전하`, Hermes, and a `coder` subagent:

1. CML projects actors: `user:전하`, `assistant:hermes`, `subagent:coder`.
2. Session actor membership records all three actors.
3. Actor card stores durable user preference only if validated, e.g. `INSTRUCTION: Prefers concrete Markdown plans with actionable scripts for extraction-accuracy work.`
4. Perspective observations can represent, for example:
   - Hermes about coder: `coder is currently investigating test failures in src/core/retriever.ts`.
   - Hermes about user: `user wants spec docs updated before implementation when evaluating reference OSS.`
5. `mem-context-pack({ observerActorId: 'assistant:hermes', targetActorId: 'user:...', projectPath })` returns normal project context plus relevant actor card and observations with source refs.

## 8. Implementation slice delivered

The implemented P0/P1 slice keeps Honcho as reference-only and adds the following to CML:

- TypeScript/Zod schemas for actors, session actors, actor cards, and perspective observations.
- SQLite tables/indexes plus repositories for actor registry, session membership, actor cards, and observer→observed observations.
- MCP read/mutation tools for actor-card and perspective-observation operations with project scope and audit metadata.
- `mem-context-pack` perspective options that add a separate Perspective Context lane only when requested.
- Focused scenario tests for multi-actor observer-specific memory, session filtering, project isolation, card validation, privacy-safe output, and exact source-event lookup.
- Final validation passed for focused tests, full Vitest, typecheck, build, diff whitespace check, privacy/static scan, and independent review; `npm run lint` remains blocked because the repo script references a missing `eslint` binary.

Deferred items remain in `plan.md`: automatic backfill/repair CLI, vector/FTS integration, background derivation, dialectic query agent, dreamer/consolidation specialists, and dashboard UI.
