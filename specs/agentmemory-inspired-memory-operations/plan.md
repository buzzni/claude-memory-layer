# AgentMemory-Inspired Memory Operations Layer Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Build a project-scoped, privacy-safe memory operations layer for facets, actions/frontier/checkpoints/leases, retention governance, graph expansion, and procedural lessons.

**Architecture:** Keep CML's SQLite `events` as the source of truth. Add rebuildable/idempotent projection tables and service classes under `src/core/operations/`, then expose a small curated surface through MCP, CLI, and dashboard stats. Ranking-affecting features stay behind config flags until replay gates pass.

**Tech Stack:** TypeScript ESM, better-sqlite3, existing CML EventStore/Retriever/EntityRepo/EdgeRepo/MCP handlers, Vitest, replay benchmark scripts.

---

## Phase 0: Alignment and safety baseline

### [x] Task 0.1 — Confirm current state and lock scope

**Objective:** Make sure implementation begins from the current repo state and does not accidentally modify unrelated work.

**Files:**
- Read: `AGENTS.md`
- Read: `package.json`
- Read: `src/extensions/mcp/tools.ts`
- Read: `src/extensions/mcp/handlers.ts`
- Read: `src/core/sqlite-event-store.ts`

**Steps:**

1. Run `git status --short`.
2. Confirm no unrelated changes, or move this work to a clean branch/worktree.
3. Run focused baseline tests:
   ```bash
   npm test -- --run tests/extensions/mcp-context-tools.test.ts tests/core/retrieval-disclosure-service.test.ts tests/core/retrieval-benchmark.test.ts
   ```
4. Record any pre-existing failures in the implementation PR notes.

**Done when:** baseline command output is captured and unrelated changes are not mixed into the feature branch.

### [x] Task 0.2 — Add operation config defaults

**Objective:** Add disabled-by-default feature flags so new ranking/governance behavior can ship safely.

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/services/memory-service-config.ts`
- Test: `tests/core/memory-service-config.test.ts`

**Config sketch:**

```typescript
export const MemoryOperationsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  facets: z.object({ enabled: z.boolean().default(true) }).default({}),
  actions: z.object({ enabled: z.boolean().default(true) }).default({}),
  retention: z.object({ enabled: z.boolean().default(false), policyVersion: z.string().default('v1') }).default({}),
  graphExpansion: z.object({ enabled: z.boolean().default(false), maxHops: z.number().default(1) }).default({}),
  lessons: z.object({ enabled: z.boolean().default(false) }).default({})
}).default({});
```

**Verification:**

```bash
npm test -- --run tests/core/memory-service-config.test.ts
npm run typecheck
```

---

## Phase 1: Facet taxonomy and repository (P0)

### [x] Task 1.1 — Define facet types

**Objective:** Add strongly typed facet assignment contracts.

**Files:**
- Modify: `src/core/types.ts`
- Create: `src/core/operations/facets.ts`
- Test: `tests/core/operations-facets.test.ts`

**Implementation notes:**

- Use target types: `event`, `entity`, `edge`, `consolidated_memory`, `lesson`, `action`.
- Built-in dimensions:
  - `kind`
  - `workflow`
  - `artifact`
  - `source`
  - `privacy`
  - `quality`
  - `retention`
  - `project`
- Allow custom dimensions behind validation: lowercase kebab-case, max length 64.

**Verification:**

```bash
npm test -- --run tests/core/operations-facets.test.ts
```

### [x] Task 1.2 — Add `memory_facets` schema

**Objective:** Create a derived table for facet assignments.

**Files:**
- Modify: `src/core/sqlite-event-store.ts`
- Test: `tests/core/sqlite-event-store-operations-schema.test.ts`

**DDL sketch:**

```sql
CREATE TABLE IF NOT EXISTS memory_facets (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  dimension TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  source TEXT NOT NULL DEFAULT 'manual',
  evidence_event_ids TEXT NOT NULL DEFAULT '[]',
  project_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(target_type, target_id, dimension, value, source, project_hash)
);
CREATE INDEX IF NOT EXISTS idx_memory_facets_project_dimension_value
  ON memory_facets(project_hash, dimension, value);
CREATE INDEX IF NOT EXISTS idx_memory_facets_target
  ON memory_facets(target_type, target_id);
```

**Verification:**

```bash
npm test -- --run tests/core/sqlite-event-store-operations-schema.test.ts
```

### [x] Task 1.3 — Implement `FacetRepository`

**Objective:** Provide idempotent assign/remove/query APIs.

**Files:**
- Create: `src/core/operations/facet-repository.ts`
- Test: `tests/core/facet-repository.test.ts`

**Required methods:**

```typescript
assign(input: FacetAssignmentInput): Promise<MemoryFacetAssignment>;
remove(input: FacetRemoveInput): Promise<boolean>;
query(input: FacetQuery): Promise<MemoryFacetAssignment[]>;
listForTarget(targetType: FacetTargetType, targetId: string): Promise<MemoryFacetAssignment[]>;
```

**Verification:**

```bash
npm test -- --run tests/core/facet-repository.test.ts
```

### [x] Task 1.4 — Add audit write helper

**Objective:** Make facet assignment auditable before exposing MCP tools.

**Files:**
- Create: `src/core/operations/governance-audit.ts`
- Modify: `src/core/sqlite-event-store.ts`
- Test: `tests/core/governance-audit.test.ts`

**Done when:** facet assignment can write an audit row with actor, projectHash, target, before/after, and source event ids.

---

## Phase 2: Facet-aware retrieval and disclosure (P0)

### [x] Task 2.1 — Add retrieval option types

**Objective:** Let retriever callers pass facet filters without changing default behavior.

**Files:**
- Modify: `src/core/retriever.ts`
- Modify: `src/core/engine/retrieval-orchestrator.ts`
- No code change required: `src/core/engine/retrieval-services.ts` already forwards orchestrator/disclosure option types
- Test: `tests/core/retriever-facet-filter.test.ts`
- Test: `tests/core/retrieval-orchestrator.test.ts`

**Option sketch:**

```typescript
facets?: Array<{ dimension: string; value: string }>;
```

**Important:** If `facets` is absent, existing retrieval output must be byte-for-byte equivalent where practical.

### [x] Task 2.2 — Filter/rerank candidates by facets

**Objective:** Apply facet filters in a bounded, explainable way.

**Files:**
- Modify: `src/core/retriever.ts`
- Modify: `src/core/engine/retrieval-disclosure-service.ts`
- Test: `tests/core/retriever-facet-filter.test.ts`
- Test: `tests/core/retrieval-disclosure-service.test.ts`

**Rules:**

1. If facets are strict filters, exclude non-matching candidate IDs before final selection.
2. If later adding soft facets, add score contribution but keep feature flag disabled until replay gate passes.
3. Disclosure envelope reason includes `facet_match`.

**Verification:**

```bash
npm test -- --run tests/core/retriever-facet-filter.test.ts tests/core/retrieval-disclosure-service.test.ts
```

---

## Phase 3: Operational actions, frontier, leases, checkpoints (P0/P1)

### [x] Task 3.1 — Add action/checkpoint/lease types and schema

**Objective:** Add minimal projection tables for operational state.

**Files:**
- Create: `src/core/operations/actions.ts`
- Modify: `src/core/sqlite-event-store.ts`
- Modify: `src/core/operations/index.ts`
- Test: `tests/core/sqlite-event-store-operations-schema.test.ts`

**Tables:**

- `memory_actions`
- `memory_action_edges` (includes `source` ownership so projection-generated dependencies can be stale-synced without deleting manual edges)
- `memory_leases`
- `memory_checkpoints`

**Indexes:**

- `memory_actions(project_hash, status, priority DESC, updated_at DESC)`
- `memory_leases(target_type, target_id, expires_at)`
- `memory_checkpoints(project_hash, action_id, created_at DESC)`

### [x] Task 3.2 — Implement repositories

**Objective:** Add repository classes with atomic lease behavior.

**Files:**
- Create: `src/core/operations/action-repository.ts`
- Create: `src/core/operations/lease-repository.ts`
- Create: `src/core/operations/checkpoint-repository.ts`
- Test: `tests/core/action-repository.test.ts`
- Test: `tests/core/lease-repository.test.ts`
- Test: `tests/core/checkpoint-repository.test.ts`

**Required lease behavior:**

- `acquire()` succeeds if no active lease exists.
- `acquire()` fails if another active lease exists.
- expired leases can be reclaimed.
- `renew()` and `release()` are idempotent and audited.

### [x] Task 3.3 — Implement frontier service

**Objective:** Rank next actions with explanations.

**Files:**
- Create: `src/core/operations/frontier-service.ts`
- Modify: `src/core/operations/index.ts`
- Test: `tests/core/frontier-service.test.ts`

**Scoring inputs:**

- priority
- status
- blockers/action edges
- recency
- active lease absence/presence
- verified/high-quality facets

**Output shape:**

```typescript
interface FrontierItem {
  action: MemoryAction;
  score: number;
  reasons: string[];
  sourceRefs: string[];
}
```

### Task 3.4 — Optional projection from task entities [x]

**Objective:** Seed actions from existing task entities without making task entity a hard dependency.

**Files:**
- Created: `src/core/operations/action-projector.ts`
- Modified: `src/core/operations/index.ts`
- Test: `tests/core/action-projector.test.ts`

**Implemented rules:**
- `memory_actions` remains a projection and references task entities through `relatedEntityIds`.
- Projection is fail-closed unless both `projectHash` and task `project` scope are supplied.
- Projected action IDs are deterministic from task entity IDs, so repeated projection is idempotent.
- Task blocker edges are converted to `depends_on` action edges while preserving non-task blockers as entity references.
- Projector-owned action edges use `source='task_projector'`; stale sync removes only projector-owned edges and preserves manual dependencies.

---

## Phase 4: Retention and governance (P0/P1)

### [x] Task 4.1 — Implement retention policy v1

**Objective:** Compute explainable lifecycle scores in dry-run mode.

**Files:**
- Create: `src/core/operations/retention-policy.ts`
- Test: `tests/core/retention-policy.test.ts`

**Inputs:**

- event type
- memory level
- created/last accessed recency
- retrieval count
- helpfulness/adherence score
- quarantine/private metadata
- citation/evidence confidence
- manual facets `retention:keep`, `retention:review`, `retention:discard`

**Decisions:**

- `keep`
- `review`
- `downgrade`
- `quarantine`
- `tombstone_candidate`

**Implemented:**

- Pure dry-run evaluator `evaluateRetentionPolicy()` in `src/core/operations/retention-policy.ts`.
- Score factors include level, recency, retrieval count, helpfulness/adherence, evidence confidence, event type, privacy/quarantine metadata, and manual retention facets.
- Active quarantine takes precedence over manual keep; private low-signal memories route to review instead of tombstone.
- Manual `retention:discard` produces a non-destructive tombstone candidate only.
- Results include policy version, reasons, factor breakdown, and dry-run diff.

**Verification:**

```bash
npm test -- --run tests/core/retention-policy.test.ts
```

### [x] Task 4.2 — Add `memory_retention_scores`

**Objective:** Store computed scores and policy version.

**Files:**
- Modify: `src/core/sqlite-event-store.ts`
- Create: `src/core/operations/retention-repository.ts`
- Test: `tests/core/retention-repository.test.ts`

**Implemented:**

- `memory_retention_scores` table stores target, project scope, policy version, decision, lifecycle score, reasons, dry-run diff, source event ids, and timestamps.
- `RetentionRepository.upsert()` is idempotent by `(target_type, target_id, project_hash, policy_version)` and writes `retention_score` governance audit rows.
- Repository reads are project-scoped and decision-filterable; unscoped writes fail closed.
- Cross-project wrapper/result mismatches are rejected before persistence.

**Verification:**

```bash
npm test -- --run tests/core/sqlite-event-store-operations-schema.test.ts tests/core/retention-repository.test.ts
```

### [x] Task 4.3 — Add dry-run audit command

**Objective:** Provide non-destructive CLI for lifecycle review.

**Files:**
- Modify: `src/apps/cli/index.ts`
- Test: `tests/apps/retention-audit-cli.test.ts`

**Command sketch:**

```bash
claude-memory-layer retention audit --project "$PWD" --dry-run --limit 100 --json
```

**Expected:** JSON summary with decisions and redacted samples.

**Implemented:**

- Added `runRetentionAudit()` in `src/core/operations/retention-audit.ts` as a read-only, project-scoped audit helper over existing SQLite event/facet/telemetry data.
- Added `claude-memory-layer retention audit --project "$PWD" --dry-run --limit 100 --json` with strict project/hash and positive-integer option validation.
- JSON/text output includes policy version, decision counts, would-change count, reason codes, lifecycle scores, dry-run actions, and privacy-filtered samples without raw local paths or secret-bearing payloads.
- Missing project stores return an empty dry-run report instead of initializing storage or running migrations.

**Verification:**

```bash
npm test -- --run tests/apps/retention-audit-cli.test.ts tests/core/retention-policy.test.ts tests/core/retention-repository.test.ts tests/core/sqlite-event-store-operations-schema.test.ts
npm run typecheck
npm run build
```

### [x] Task 4.4 — Add quarantine governance action

**Objective:** Allow explicit quarantine with audit, no hard delete.

**Files:**
- Create: `src/core/operations/governance-service.ts`
- Modify: `src/core/privacy/filter.ts` if needed
- Test: `tests/core/governance-service.test.ts`

**Rule:** P0 never hard-deletes source events.

**Implemented:**

- Added `GovernanceService.quarantine()` for explicit project-scoped event quarantine with fail-closed target/project validation.
- Quarantine mutates event metadata only, preserving source rows and adding active quarantine metadata plus a `quarantine:<category>` tag.
- Each successful quarantine writes a `memory_governance_audit` row with actor, target, before/after metadata, reason/category, source evidence IDs, and redacted payloads.
- Quarantine validation and metadata/audit writes happen in one transaction; stale row metadata fails closed before audit persistence.
- Default event read/search/count/session paths continue suppressing active-quarantine rows; explicit `includeQuarantined` remains the audit opt-in.
- Governance audit redaction now covers POSIX, Windows drive, and UNC local-path-shaped payloads, not only `[POSIX_PATH]` paths.

**Verification:**

```bash
npm test -- --run tests/core/governance-service.test.ts tests/core/governance-audit.test.ts tests/core/sqlite-event-store-project-scope-repair.test.ts
npm run typecheck
npm run build
```

---

## Phase 5: Graph-powered retrieval (P1)

### [x] Task 5.1 — Add graph path service

**Objective:** Add weighted bounded path expansion over existing `entities`/`edges`.

**Files:**
- Create: `src/core/operations/graph-path-service.ts`
- Test: `tests/core/graph-path-service.test.ts`

**Behavior:**

- Build adjacency once per query.
- Use cost `1 / weight` when edge metadata has weight; default weight = 0.5.
- Bound `maxHops <= 2` for MCP/API calls.
- Return path explanation, not just IDs.

**Implemented:**

- Added `GraphPathService.expand()` over current `edges` plus active `entities` labels, with one adjacency build per request.
- Supports outgoing, incoming, and bidirectional traversal so query entities can expand to related entries while preserving original edge direction in explanations.
- Uses weighted cost (`1 / weight`) with safe default weight `0.5`, picks the lowest-cost bounded path per target, applies deterministic edge-id tie breaks, and returns `scoreContribution` values for paths and steps.
- Clamps requested traversal to `maxHops <= 2`; no temporal/history table is introduced in this task.
- Retrieval ranking/disclosure integration remains explicitly deferred to Task 5.3.

**Verification:**

```bash
npm test -- --run tests/core/graph-path-service.test.ts
npm run typecheck
```

### [x] Task 5.2 — Add rule-based entity extraction

**Objective:** Extract candidate entity names from query without LLM dependency.

**Files:**
- Create: `src/core/operations/query-entity-extractor.ts`
- Test: `tests/core/query-entity-extractor.test.ts`

**Initial extraction:**

- quoted strings
- file paths
- package identifiers
- capitalized technical terms
- known entity aliases from `entity_aliases`

**Implemented:**

- Added `QueryEntityExtractor.extract()` with deterministic source priority and capped result counts.
- Extracts quoted phrases, relative/source file paths, npm-style package identifiers, and capitalized technical terms without LLM calls.
- Resolves active entity title/canonical-key aliases from existing `entity_aliases` joined to `entities`, skipping deprecated entities.
- Deduplicates heuristic candidates while preserving distinct alias evidence, prefers entity alias matches over duplicate heuristic matches, uses locale-independent tie-breaks, and drops oversized heuristic candidates.

**Verification:**

```bash
npm test -- --run tests/core/query-entity-extractor.test.ts
npm run typecheck
```

### [x] Task 5.3 — Integrate graph path reasons into disclosure

**Objective:** Show why graph expansion selected a result.

**Files:**
- Modify: `src/core/retriever.ts`
- Modify: `src/core/engine/retrieval-disclosure-service.ts`
- Test: `tests/core/retriever-graph-path.test.ts`
- Test: `tests/core/retrieval-disclosure-service.test.ts`

**Feature flag:** `operations.graphExpansion.enabled` must gate ranking changes.

**Implemented:**

- Wired `operations.graphExpansion` through memory service composition → retrieval services → retrieval orchestrator so default retrieval calls only enable query-entity graph path ranking when the operations feature flag is enabled.
- Integrated `QueryEntityExtractor` and `GraphPathService` into retriever graph expansion with bounded `maxHops`, bounded candidate/path counts, legacy-schema fail-closed fallback, and deterministic sorting.
- Added `selectedDebug/candidateDebug.graphPaths` metadata for graph-expanded event results, preserving start entity, target, hop count, and relation path.
- Exposed graph path selections in retrieval disclosure envelopes as `entity_overlap` reasons with compact `metadata.graphPaths`; existing related-event graph-hop behavior remains unchanged.

**Verification:**

```bash
npm test -- --run tests/core/retriever-graph-path.test.ts tests/core/retrieval-disclosure-service.test.ts
npm run typecheck
npm run build
npm test -- --run
```

### [x] Task 5.4 — Temporal edge history design spike

**Objective:** Decide whether edge history belongs in `edges` metadata, a new `edge_history` table, or event-derived projection.

**Files:**
- Updated: `specs/agentmemory-inspired-memory-operations/context.md`
- Created: `docs/graph-temporal-edge-spike.md`

**Done when:** a follow-up implementation decision is documented with migration risks.

**Decision:** Use a new append-only `edge_history` table as the temporal graph source and keep existing `edges` as the current-state projection.

**Implementation notes:**

- Rejected `edges.meta_json`-only history because it is hard to index, validate, and audit for `asOf` queries.
- Deferred pure event-derived projection as a rebuild/repair source because current events do not yet encode temporal relationship updates with enough structure for runtime queries.
- Proposed bitemporal fields: `valid_from`/`valid_to` for modeled-world validity, `committed_at` for system/update time, plus `status`, `weight`, source event IDs, bounded evidence, and current projection linkage.
- Documented migration/backfill risks and mitigations: legacy duplicate edges, conservative validity defaults, current/history drift, query performance, and privacy-safe evidence handling.

---

## Phase 6: Procedural lessons (P1)

### Task 6.1 — Add lesson types and schema

**Objective:** Store workflow lessons as first-class derived memories.

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/sqlite-event-store.ts`
- Create: `src/core/operations/lesson-repository.ts`
- Test: `tests/core/lesson-repository.test.ts`

### Task 6.2 — Implement rule-based lesson candidates

**Objective:** Generate review candidates from repeated successful workflows without LLM.

**Files:**
- Create: `src/core/operations/lesson-candidate-service.ts`
- Test: `tests/core/lesson-candidate-service.test.ts`

**Candidate rules:**

- at least two sessions share similar tool/file/task patterns
- ended with successful build/test/commit signal where available
- no active privacy/quarantine conflict
- source refs available

### Task 6.3 — Add manual promotion

**Objective:** Promote a candidate to lesson only after explicit request or high-confidence rule.

**Files:**
- Create: `src/core/operations/lesson-service.ts`
- Test: `tests/core/lesson-service.test.ts`

**Output:** lesson with trigger, steps, evidence source refs, confidence, failure modes.

---

## Phase 7: MCP tools and API surface (P0/P1)

### Task 7.1 — Add MCP tool definitions

**Objective:** Register curated operational tools.

**Files:**
- Modify: `src/extensions/mcp/tools.ts`
- Test: `tests/extensions/mcp-context-tools.test.ts`
- Test: `tests/extensions/mcp-operation-tools.test.ts`

**Initial tools:**

- `mem-facet-query`
- `mem-facet-tag`
- `mem-action-list`
- `mem-action-update`
- `mem-frontier`
- `mem-checkpoint-create`
- `mem-checkpoint-list`
- `mem-retention-audit`
- `mem-graph-query`
- `mem-lesson-list`

**Rule:** if this list is reduced during implementation, update spec and tests in the same commit.

### Task 7.2 — Add MCP handlers

**Objective:** Wire tools to services with strict validation and privacy-safe output.

**Files:**
- Modify: `src/extensions/mcp/handlers.ts`
- Test: `tests/extensions/mcp-operation-tools.test.ts`

**Handler requirements:**

- validate required args and types
- resolve projectPath → projectHash with existing registry helpers
- reject state-changing calls without project scope
- redact previews
- return compact JSON
- audit state-changing operations

### Task 7.3 — Add CLI equivalents

**Objective:** Make operational features usable without MCP.

**Files:**
- Modify: `src/apps/cli/index.ts`
- Test: `tests/apps/operations-cli.test.ts`

**Commands:**

```bash
claude-memory-layer facet query --project "$PWD" --dimension workflow --value release --json
claude-memory-layer action list --project "$PWD" --status pending --json
claude-memory-layer frontier --project "$PWD" --limit 10 --json
claude-memory-layer checkpoint list --project "$PWD" --json
claude-memory-layer retention audit --project "$PWD" --dry-run --json
```

---

## Phase 8: Dashboard/API observability (P1)

### Task 8.1 — Add aggregate stats API

**Objective:** Surface operation health without raw content.

**Files:**
- Modify: `src/apps/server/api/stats.ts`
- Test: `tests/apps/dashboard-operations-stats.test.ts`

**Aggregates:**

- facet distribution by dimension/value
- action status counts
- active leases by target type
- retention decision counts
- governance audit operations by day
- lesson counts by confidence bucket

### Task 8.2 — Add dashboard cards

**Objective:** Add UI visibility for operational memory health.

**Files:**
- Modify: UI files under `src/apps/server` or `src/ui` depending current dashboard structure
- Test: existing dashboard UI/smoke tests, or add focused rendering test if available

**Rule:** no raw content in aggregate cards.

---

## Phase 9: Evaluation and release gates (P0/P1)

### Task 9.1 — Add replay fixture categories

**Objective:** Prevent retrieval and privacy regressions.

**Files:**
- Modify or create: `benchmarks/replay/*operations*.json`
- Modify: `tests/core/replay-evaluator.test.ts`

**Categories:**

- facet filter positive
- facet filter no-match
- graph path explanation
- retention quarantine suppression
- source-ref redaction
- action/frontier relevance

### Task 9.2 — Add benchmark thresholds

**Objective:** Ensure ranking changes do not degrade golden replay.

**Files:**
- Modify: `scripts/replay-retrieval-benchmark.ts` only if new options are needed
- Test: `tests/apps/replay-retrieval-benchmark-cli.test.ts`

**Commands:**

```bash
npm run benchmark:replay
npm test -- --run tests/core/replay-evaluator.test.ts tests/apps/replay-retrieval-benchmark-cli.test.ts
```

### Task 9.3 — Full verification before merge

**Objective:** Validate code, tests, build, and docs.

**Commands:**

```bash
npm run typecheck
npm test -- --run
npm run build
npm run benchmark:replay
```

**Done when:** all pass, or any pre-existing failure is documented with evidence and unrelated to this feature.

---

## Milestone slicing

### Milestone A — Facets + dry-run retention (smallest useful slice)

Includes:

- Phase 0
- Phase 1
- Phase 2 strict facet filter
- Phase 4 dry-run retention score
- MCP/CLI: `mem-facet-query`, `mem-facet-tag`, `mem-retention-audit`

Why first:

- Low risk
- Reuses existing telemetry
- Provides immediate product value for search quality and governance

### Milestone B — Actions/frontier/checkpoints

Includes:

- Phase 3
- MCP/CLI: `mem-action-list`, `mem-action-update`, `mem-frontier`, checkpoint tools
- Dashboard action/lease stats

Why second:

- Enables multi-agent workflows
- Builds on existing task/entity work without blocking retrieval changes

### Milestone C — Graph path + lessons

Includes:

- Phase 5
- Phase 6
- replay fixtures for graph/lesson behavior

Why third:

- Higher quality value but more ranking/evidence risk
- Should ship behind flags and benchmark gates

## Implementation rules

1. Write tests before code for each repository/service.
2. Add only one tool family per PR when possible.
3. Keep new modules under `src/core/operations/` until a better existing boundary is obvious.
4. Do not place app-specific MCP/CLI logic in core services.
5. Do not hard-delete data in this feature's first release.
6. Keep privacy redaction tests close to every new user-facing output.
7. Update this spec folder when tool names, schemas, or priorities change.

## Verification checklist

- [ ] `git status --short` reviewed before and after edits.
- [ ] Unit tests added for every new repository/service.
- [ ] MCP handler tests cover argument validation and project-scope failure.
- [ ] CLI tests cover JSON output and dry-run behavior.
- [ ] `mem-context-pack`, `mem-search`, `mem-source-ref` behavior unchanged without feature flags.
- [ ] Retention/governance actions are non-destructive by default.
- [ ] New outputs use redacted previews/source refs.
- [ ] `npm run typecheck` passes.
- [ ] `npm test -- --run` passes or pre-existing unrelated failures are documented.
- [ ] `npm run build` passes.
- [ ] `npm run benchmark:replay` passes.
