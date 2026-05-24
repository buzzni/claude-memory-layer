# Plan: Honcho-inspired Peer Context Memory

> **Status**: Implemented P0/P1 manual perspective-memory slice; validated 2026-05-23 (lint unavailable: eslint binary missing)
> **Created**: 2026-05-23
> **Spec**: `specs/honcho-inspired-peer-context-memory/spec.md`

## Phase 0 — Spec and architecture alignment (done by this document)

- [x] Analyze Honcho's peer/session/representation architecture.
- [x] Compare against CML's EventStore, Retriever, Operations, MCP, and project-scope model.
- [x] Decide whether to update an existing spec or create a new one.
- [x] Create this new feature spec because no existing spec owns actor perspective memory.

Deliverables:

- `context.md`
- `spec.md`
- `plan.md`

## Phase 1 — Schema and repository foundation (P0)

### 1.1 Add TypeScript types

Target file:

- `src/core/types.ts`

Add schemas/types:

- `MemoryActorKindSchema`
- `MemoryActorSchema`
- `SessionActorSchema`
- `PerspectiveObservationLevelSchema`
- `PerspectiveObservationSchema`
- `ActorCardEntrySchema`
- `ActorCardSchema`
- input schemas for create/upsert/query operations

Initial type sketch:

```ts
export const MemoryActorKindSchema = z.enum([
  'user', 'assistant', 'subagent', 'tool', 'system', 'integration', 'unknown'
]);

export const PerspectiveObservationLevelSchema = z.enum([
  'explicit', 'deductive', 'inductive', 'contradiction'
]);

export const ActorCardEntryPrefixSchema = z.enum([
  'IDENTITY', 'ATTRIBUTE', 'RELATIONSHIP', 'INSTRUCTION'
]);
```

Acceptance:

- [x] Zod validation rejects empty ids/names.
- [x] Actor card entries enforce allowed prefixes and max length.
- [x] Observation schemas require source evidence for derived levels.

### 1.2 Add SQLite tables

Target file:

- `src/core/sqlite-event-store.ts`

Add DDL behind normal initialization. Tables should be additive and safe for existing stores.

Proposed tables:

```sql
CREATE TABLE IF NOT EXISTS memory_actors (
  actor_id TEXT PRIMARY KEY,
  project_hash TEXT,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  source TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_actors (
  project_hash TEXT,
  session_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  role_in_session TEXT NOT NULL,
  observe_self INTEGER NOT NULL DEFAULT 1,
  observe_others INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL,
  left_at TEXT,
  metadata_json TEXT,
  PRIMARY KEY (project_hash, session_id, actor_id)
);

CREATE TABLE IF NOT EXISTS actor_cards (
  card_id TEXT PRIMARY KEY,
  project_hash TEXT,
  observer_actor_id TEXT NOT NULL,
  observed_actor_id TEXT NOT NULL,
  entries_json TEXT NOT NULL,
  source_event_ids_json TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_hash, observer_actor_id, observed_actor_id)
);

CREATE TABLE IF NOT EXISTS perspective_observations (
  observation_id TEXT PRIMARY KEY,
  project_hash TEXT,
  observer_actor_id TEXT NOT NULL,
  observed_actor_id TEXT NOT NULL,
  session_id TEXT,
  level TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence REAL NOT NULL,
  source_event_ids_json TEXT,
  source_observation_ids_json TEXT,
  created_by TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
```

Indexes:

- [x] `idx_memory_actors_project_kind`
- [x] `idx_session_actors_session`
- [x] `idx_actor_cards_perspective`
- [x] `idx_perspective_observations_perspective_level`
- [x] `idx_perspective_observations_session`
- [ ] optional FTS table for observation content, or integrate with existing vector outbox later

Acceptance:

- [x] Existing DB initializes without migration failure.
- [ ] Read-only stores skip schema writes as today.
- [x] `git diff --check` passes.

### 1.3 Repository layer

New files:

- `src/core/operations/actor-repository.ts`
- `src/core/operations/actor-card-repository.ts`
- `src/core/operations/perspective-observation-repository.ts`
- `src/core/operations/session-actor-repository.ts`

Export from:

- `src/core/operations/index.ts`

Required methods:

- actor: `upsert`, `get`, `list`, `resolveFromEvent`
- session actor: `upsertMembership`, `listBySession`, `setObservationPolicy`
- actor card: `get`, `upsert`, `validateEntries`
- perspective observation: `create`, `deleteSoft`, `query`, `listByPerspective`, `listBySourceEvent`

Acceptance:

- [x] Unit tests cover validation and repository CRUD.
- [x] Writes record governance/audit metadata where applicable.

## Phase 2 — Actor projection and read-only context pack integration (P0/P1)

### 2.1 Actor projection from existing events

New file:

- `src/core/operations/actor-projector.ts`

Behavior:

- infer actor from `MemoryEvent.eventType` and metadata.
- map `user_prompt` to user actor when metadata/source hints exist, else `user:default` or `user:unknown` per project.
- map `agent_response` to assistant actor using model/source metadata.
- map `tool_observation` to `tool:<toolName>` actor only for tool identity, not durable person memory.
- map imported Hermes/Codex/Claude sources to stable integration/source actors.

Acceptance:

- [x] Projection is deterministic and idempotent.
- [x] No raw platform ids are exposed unless already display-safe.
- [x] Existing ingestion APIs do not break when metadata is missing.

### 2.2 Populate session actor membership

Hook into:

- session importers
- `MemoryIngestService` or ingest interceptors
- optional repair/backfill command

Possible command:

```bash
claude-memory-layer actors repair --project /path/to/project --dry-run
```

Acceptance:

- [ ] Existing sessions can be backfilled into session actor membership.
- [ ] Dry-run reports actor/session counts and samples.

### 2.3 Extend `mem-context-pack`

Target files:

- `src/extensions/mcp/tools.ts`
- `src/extensions/mcp/handlers.ts`
- underlying context-pack service code

New optional args:

- `observerActorId`
- `targetActorId`
- `includeActorCard`
- `includePerspectiveObservations`
- `limitToSession`
- `perspectiveTopK`

Behavior:

- If no perspective args are passed, output remains byte-for-byte compatible enough for existing callers.
- If `targetActorId` exists, include actor card and relevant observations after the existing project summary.
- Use privacy-safe `mem-source-ref` style citations for observation sources.
- Return debug counts: actor card entries, explicit observations, derived observations.

Acceptance:

- [x] Existing `mem-context-pack` tests pass unchanged.
- [x] New test verifies graceful empty perspective output.
- [x] New test verifies actor card + observation inclusion.
- [x] Context-pack output exposes perspective retrieval lane counts and separated actor-card/explicit/derived/contradiction sections for debugging.

## Phase 3 — MCP/CLI operations (P1)

### 3.1 Read tools

Add MCP tools:

- `mem-actor-list`
- `mem-actor-card-get`
- `mem-perspective-query`
- `mem-perspective-context`

Read output rules:

- compact JSON or Markdown
- no raw unfiltered metadata
- includes source ref ids, not raw transcripts
- requires `projectPath` for project-scoped perspective reads unless explicitly global

### 3.2 Mutating tools

Add MCP tools:

- `mem-actor-card-upsert`
- `mem-perspective-observation-create`
- `mem-perspective-observation-delete`

Mutation guardrails:

- `actor` audit field required.
- `projectPath` required for project-scoped stores.
- actor card entries pass strict prefix/length validation.
- observation creation requires source evidence except manual global notes.
- all content passes privacy filter.

Acceptance:

- [x] MCP handler rejects unscoped mutating requests.
- [x] MCP handler rejects invalid card prefixes and overlong entries.
- [x] Governance audit rows include actor and operation metadata.

## Phase 4 — Retrieval lane separation (P1)

Target files:

- `src/core/retriever.ts`
- context pack assembly code

Implement separate retrieval lanes:

1. raw event/session retrieval
2. session summary retrieval
3. actor card retrieval
4. explicit perspective observation retrieval
5. derived perspective observation retrieval

Merge policy:

- actor card has fixed small budget.
- explicit observations have priority for evidence-heavy questions.
- derived observations are included with lower cap and source-chain hints.
- contradiction observations are surfaced prominently.

Acceptance:

- [x] Debug trace identifies which lane selected each memory.
  - Implemented core trace lane metadata for raw event/vector/keyword retrieval, session-summary fallback, graph-path expansion, and facet-match filtering; automatic retrieval traces persist candidate/selected `lanes` details.
  - Lane reasons are privacy-safe/truncated and redact local paths plus secret-shaped values before trace persistence.
- [x] Retrieval with actor perspective does not suppress existing project memories.
  - Context-pack perspective loading now degrades fail-open for the project-memory lane: if actor-card or observation retrieval fails, a sanitized warning is emitted and existing relevant memories/timeline still render.
- [x] Retrieval without actor perspective is unchanged.
  - Explicitly disabled perspective toggles (`includeActorCard: false`, `includePerspectiveObservations: false`) no longer trigger perspective validation/loading when no actor ids are supplied, preserving baseline context-pack output.

## Phase 5 — Minimal Perspective Deriver (P2)

New files:

- `src/core/operations/perspective-deriver.ts`
- optional worker/queue integration under existing outbox/runtime services

Initial behavior:

- selected events from a session become candidate explicit observations.
- structured LLM extraction is optional and feature-flagged.
- every observation includes source event ids.
- same generated observation may be saved to multiple observer perspectives only when observation policy allows.

Feature flags:

```yaml
memoryOperations:
  perspectiveMemory:
    enabled: false
    deriver:
      enabled: false
      maxEventsPerBatch: 20
      maxObserversPerSession: 5
```

Acceptance:

- [x] Deriver is disabled by default.
  - `PerspectiveDeriver` requires both `memoryOperations.perspectiveMemory.enabled` and `memoryOperations.perspectiveMemory.deriver.enabled`; service wiring also avoids constructing it for read-only/disabled configs.
- [x] No LLM call holds an open DB transaction.
  - Extraction runs before actor/session/observation persistence; the minimal extractor is rule-based today, while the extractor interface can be LLM-backed without spanning SQLite writes.
- [x] Failed derivations do not block normal memory ingestion.
  - `MemoryIngestService` invokes the optional deriver only after successful non-duplicate event writes and swallows derivation failures so embedding/mirror/ingest results remain intact.
- [x] Duplicate observations are deduped by `(projectHash, observer, observed, content/source hash)`.
  - Deriver writes through `PerspectiveObservationRepository.create`, preserving the repository unique key and policy-based observer fan-out.

## Phase 6 — Dialectic query agent (P2/P3)

New optional service:

- `src/core/operations/perspective-query-agent.ts`

Purpose:

- Answer questions that require iterative context gathering, e.g. “What does Hermes currently know about coder's blocker?”

Tools exposed to the agent:

- search perspective observations
- search raw events
- expand source refs
- read actor card
- list session actors

Guardrails:

- read-only by default
- max tool iterations by reasoning level
- source citations required in final answer
- no raw secret output

Acceptance:

- [x] Minimal reasoning level uses only search tools.
  - `PerspectiveQueryAgent` minimal mode calls only perspective-observation search and raw-event search; expansion, actor-card, and session-actor tools remain unused.
- [x] Agent response includes source refs.
  - Evidence-backed answers collect `mem:<citation>` refs from perspective observation source events and raw event results, and render them in a final `Sources:` line.
- [x] Tool iteration cap is enforced.
  - Reasoning-level caps are checked before every tool call; tests verify a minimal cap of one prevents the second search call and reports `hitToolIterationCap`.

## Phase 7 — Dreamer/consolidation specialists (P3)

Optional specialists:

- deduction specialist
- induction specialist
- contradiction specialist
- actor card maintenance specialist

Inputs:

- high-access observations
- high-surprisal/contradictory observations
- repeated session patterns
- manual promotion candidates

Outputs:

- derived observations with source chains
- actor card update suggestions or validated updates
- contradiction flags for dashboard review

Acceptance:

- [ ] Specialists are opt-in per project.
- [ ] Specialists emit metrics for created/deleted observations and card updates.
- [ ] Actor card updates never exceed caps and preserve source evidence.

## Phase 8 — Dashboard and scenario tests (P1/P2)

### 8.1 Dashboard

Potential UI additions:

- actor list per project/session
- actor card view
- perspective observation timeline
- observer → observed graph
- source evidence expansion
- contradiction review queue

### 8.2 Unified scenario tests

Inspired by Honcho's `tests/unified` JSON tests, add a CML scenario runner.

Candidate location:

- `tests/scenarios/`
- `tests/scenarios/run-memory-scenario.ts`

Scenario steps:

- create project-scoped temp store
- ingest session events with actors
- set actor observation policy
- upsert actor card
- create/query perspective observations
- call context pack
- assert contains/not-contains/source-ref/project-scope behavior

Required scenarios:

- [x] self-observation only by default
- [x] observe-others opt-in creates queryable perspective
- [x] actor card prefix/length validation
- [x] contradiction observation appears before generic derived observations
- [x] project-scope isolation prevents actor facts leaking across projects
- [x] privacy filter redacts secret-like values in card/observation outputs

## Suggested first implementation slice

If implementing next, start with a low-risk P0 slice:

1. Add types and SQLite tables.
2. Add repositories and unit tests.
3. Add manual actor-card and perspective-observation MCP tools.
4. Extend `mem-context-pack` read path.
5. Add scenario tests for manual observations.

Do **not** start with LLM derivation. Manual/read-path foundation gives immediate value and creates the validation harness needed before adding background agents.

## Open questions

1. Should actor ids be globally stable across projects or always project-local with optional global alias?
2. Should `INSTRUCTION:` actor card entries be allowed for actors other than the current user?
3. Should group-chat platform display names be hashed by default?
4. Should perspective observations be embedded in the existing vector outbox or kept FTS-only for P0?
5. Should actor cards be editable from the dashboard, MCP only, or both?
6. What is the right default observe policy for Hermes subagents: self-only, manager-observes-workers, or all assistants observe user?
