# AgentMemory-Inspired Memory Operations Layer Specification

> **Version**: 0.1.0
> **Status**: Draft — Phase 4 retention policy v1 implemented
> **Created**: 2026-05-18
> **Reference**: `agentmemory` analysis
> **Related specs**: `endless-mode`, `entity-edge-model`, `task-entity-system`, `progressive-disclosure`, `memory-utilization-improvements`, `mcp-desktop-integration`, `vector-outbox-v2`

## 1. Summary

Add a first-class **Memory Operations Layer** to CML that turns stored memory from a passive retrieval corpus into an operational system agents can inspect, classify, govern, and act on.

This spec is inspired by `agentmemory` but deliberately adapts only the parts that fit CML's architecture:

- Facets/tags for explicit memory classification and filtering
- Action/frontier/checkpoint/lease primitives for multi-step agent work
- Retention/governance/audit policies using existing retrieval telemetry
- Weighted graph retrieval and temporal edge history on top of CML's existing entity/edge model
- Procedural lesson extraction from repeated successful sessions
- Curated MCP/CLI/API surfaces with project-scope and privacy fail-closed defaults

## 2. Problem

CML already captures sessions, events, embeddings, retrieval traces, helpfulness, entities/edges, and consolidated memories. However, agents still mostly interact with memory through search/context-pack tools.

This creates five product gaps.

1. **Classification gap**: memories cannot be reliably filtered by durable, user-visible facets such as task type, artifact, workflow, confidence, source, or retention policy.
2. **Operations gap**: memory does not directly expose “what should the agent do next?”, “who is working on it?”, or “where can a long task resume?”
3. **Governance gap**: access/helpfulness/level/quarantine signals exist but are not unified into retention decisions, dry-run audits, or policy explainability.
4. **Graph explainability gap**: entity/edge infrastructure exists, but graph traversal is not yet a first-class retrieval explanation or temporal query surface.
5. **Procedural learning gap**: repeated successful workflows are not promoted into structured lessons/procedures that can later become skills, runbooks, or prompts.

## 3. Goals

### G1. Faceted memory classification

Provide explicit facet assignment/query support for memories, entities, consolidated memories, and source references.

Examples:

- `kind:debugging`
- `artifact:file:/src/core/retriever.ts`
- `source:codex`
- `privacy:private`
- `quality:verified`
- `retention:keep`
- `workflow:release`

### G2. Action/frontier/checkpoint primitives

Represent operational work as durable, project-scoped projections.

- `action`: task-like item derived from user requests, plans, or explicit tool calls
- `action_edge`: dependency/blocker/references relation between actions or entities
- `frontier`: ranked next actions for an agent/session/project
- `lease`: short-lived claim to avoid duplicate agent work
- `checkpoint`: resumable state snapshot for long-running work

### G3. Retention/governance/audit lifecycle

Use existing telemetry to compute lifecycle decisions without destroying source data.

Inputs:

- memory level (`L0`-`L4`)
- retrieval count / recency
- helpfulness/adherence signals
- source event type
- project scope
- private/quarantine metadata
- citation/evidence alignment
- manual facet overrides

Outputs:

- `keep`, `review`, `downgrade`, `quarantine`, `tombstone_candidate`
- explanation and dry-run diff
- audit event for every state-changing decision

### G4. Graph-powered retrieval expansion

Extend existing entity/edge capabilities with weighted path expansion and temporal semantics.

- Extract candidate entities from query.
- Traverse high-confidence weighted edges up to a bounded hop count.
- Attach path explanations to retrieval disclosure envelopes.
- Support `asOf` query semantics after edge history is available.

### G5. Procedural lessons

Detect repeated successful patterns and promote them to structured lessons.

A lesson has:

- trigger condition
- ordered steps
- source events/sessions
- confidence/evidence
- failure modes
- candidate skill/runbook export metadata

### G6. Curated operational MCP/API surface

Expose only a small initial tool set.

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

Tool names can be merged or reduced during implementation; the key requirement is that every state-changing tool is project-scoped, privacy-safe, and audited.

## 4. Non-goals

- Do not port `agentmemory`'s iii-engine runtime.
- Do not copy all 53 agentmemory MCP tools.
- Do not make destructive deletion the default governance action.
- Do not expose raw transcript/tool payloads from new tools unless the caller explicitly uses existing source/detail tools and passes privacy filters.
- Do not introduce a second source of truth beside CML's SQLite events.
- Do not enable LLM-based extraction by default without review/evidence gates.
- Do not couple this feature directly to Hermes-specific skills; export skill candidates as optional artifacts only.

## 5. Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│ Apps / Interfaces                                             │
│ CLI, MCP, Dashboard API                                       │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│ Memory Operations Services                                    │
│ Facets · Actions · Frontier · Lease · Checkpoint · Retention  │
│ Governance · Graph Expansion · Lessons                        │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│ Existing CML Core                                             │
│ EventStore · Retriever · EntityRepo · EdgeRepo ·              │
│ RetrievalDisclosure · Consolidation · Analytics               │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│ SQLite source of truth + derived projections                  │
│ events, sessions, vectors, retrieval_traces, helpfulness,     │
│ entities, edges, working_set, consolidated_memories, ...      │
└──────────────────────────────────────────────────────────────┘
```

### 5.1 Source-of-truth rule

- Raw facts remain in `events` and explicit user/admin operations.
- New operation tables are projections and can be rebuilt where possible.
- State-changing operations append an audit record and preserve source event IDs.

### 5.2 Project scope rule

Every operation accepts one of:

- `projectPath`
- `projectHash`
- explicit `scope: { projectHash }`

Default behavior is fail-closed if a candidate item lacks project evidence or conflicts with the requested scope.

### 5.3 Privacy rule

Operational tools return compact envelopes by default:

- stable IDs
- redacted preview
- type/facet/status/confidence
- source refs
- explanation

Raw content remains behind existing `mem-details` / `mem-source-ref` style flows and must apply private tag filtering and secret redaction.

## 6. Data model

### 6.1 Facets

```typescript
interface MemoryFacetAssignment {
  id: string;
  targetType: 'event' | 'entity' | 'edge' | 'consolidated_memory' | 'lesson' | 'action';
  targetId: string;
  dimension: string;
  value: string;
  confidence: number;
  source: 'manual' | 'rule' | 'llm' | 'import' | 'projection';
  evidenceEventIds: string[];
  projectHash?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

Recommended table: `memory_facets`.

Required indexes:

- `(project_hash, dimension, value)`
- `(target_type, target_id)`
- `(dimension, value, confidence DESC)`

### 6.2 Actions

```typescript
interface MemoryAction {
  actionId: string;
  projectHash: string;
  title: string;
  status: 'pending' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
  priority: number;
  sourceEventIds: string[];
  relatedEntityIds: string[];
  currentCheckpointId?: string;
  leaseId?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface MemoryActionEdge {
  edgeId: string;
  srcActionId: string;
  relType: 'depends_on' | 'blocks' | 'duplicates' | 'derived_from' | 'references';
  dstType: 'action' | 'entity' | 'event' | 'source_ref';
  dstId: string;
  confidence: number;
  createdAt: Date;
}
```

Recommended tables: `memory_actions`, `memory_action_edges`.

### 6.3 Leases

```typescript
interface MemoryLease {
  leaseId: string;
  targetType: 'action' | 'checkpoint' | 'routine';
  targetId: string;
  holder: string;
  expiresAt: Date;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  renewedAt?: Date;
}
```

Recommended table: `memory_leases`.

Lease acquisition must be atomic and must fail if an active lease exists.

### 6.4 Checkpoints

```typescript
interface MemoryCheckpoint {
  checkpointId: string;
  projectHash: string;
  actionId?: string;
  sessionId?: string;
  title: string;
  summary: string;
  stateJson: Record<string, unknown>;
  sourceEventIds: string[];
  createdAt: Date;
  expiresAt?: Date;
}
```

Recommended table: `memory_checkpoints`.

### 6.5 Retention scores

```typescript
interface MemoryRetentionScore {
  targetType: 'event' | 'consolidated_memory' | 'lesson';
  targetId: string;
  projectHash?: string;
  score: number;
  decision: 'keep' | 'review' | 'downgrade' | 'quarantine' | 'tombstone_candidate';
  reasons: string[];
  computedAt: Date;
  policyVersion: string;
}
```

Recommended table: `memory_retention_scores`.

### 6.6 Governance audit

```typescript
interface MemoryGovernanceAuditEntry {
  auditId: string;
  operation: 'facet_tag' | 'action_update' | 'lease_acquire' | 'checkpoint_create' | 'retention_score' | 'quarantine' | 'verify' | 'lesson_promote';
  actor: string;
  projectHash?: string;
  targetType: string;
  targetId: string;
  beforeJson?: Record<string, unknown>;
  afterJson?: Record<string, unknown>;
  sourceEventIds: string[];
  createdAt: Date;
}
```

Recommended table: `memory_governance_audit`.

### 6.7 Lessons

```typescript
interface MemoryLesson {
  lessonId: string;
  projectHash?: string;
  name: string;
  trigger: string;
  steps: string[];
  confidence: number;
  sourceSessionIds: string[];
  sourceEventIds: string[];
  failureModes: string[];
  skillCandidate: boolean;
  createdAt: Date;
  updatedAt: Date;
}
```

Recommended table: `memory_lessons`.

## 7. Functional requirements

### AMO-01 Facet repository

CML MUST provide a repository/service for idempotent facet assignment, removal, query, and target lookup.

Acceptance criteria:

- [x] Assigning the same `(targetType, targetId, dimension, value, source)` twice is idempotent.
- [x] Query by project + dimension/value returns only project-scoped items by default.
- [x] Facet assignment writes `memory_governance_audit`.

### AMO-02 Facet-aware retrieval

Retrieval MUST support optional facet filters and return facet-based reasons.

Acceptance criteria:

- [x] `retrieveMemories(query, { facets: [{ dimension, value }] })` narrows candidates before final selection or reranking.
- [x] Disclosure envelopes include `facet_match` reason when a facet contributes to ranking.
- [x] Default context-pack behavior remains unchanged when facets are absent.

### AMO-03 Action model

CML MUST support explicit action list/update operations independent of the transient Hermes todo list.

Acceptance criteria:

- [x] Actions have statuses and source event evidence.
- [x] Actions can be derived from existing `task` entities where available.
- [x] Action updates are append/audit friendly and do not mutate raw event content.

### AMO-04 Frontier ranking

CML MUST expose a frontier query that ranks next actions.

Acceptance criteria:

- [x] Completed/cancelled actions are excluded by default.
- [x] Blocked actions are deprioritized unless `includeBlocked=true`.
- [x] Ranking explains at least three factors: priority, recency, blockers/edges, or lease status.

### AMO-05 Lease safety

CML MUST support short-lived leases for actions/checkpoints.

Acceptance criteria:

- [x] Active lease prevents another holder from acquiring the same target.
- [x] Expired lease can be reclaimed.
- [x] Lease acquire/release/renew writes audit entries.

### AMO-06 Checkpoints

CML MUST support project-scoped checkpoints for long-running or delegated work.

Acceptance criteria:

- [x] Checkpoints store compact `summary` and redacted `stateJson`.
- [x] Checkpoints can be listed by project/action/session.
- [x] Checkpoint details expose source refs, not raw secret-bearing content.

### AMO-07 Retention scoring

CML MUST compute explainable lifecycle scores in dry-run mode first.

Acceptance criteria:

- [x] Score combines recency, retrieval count, helpfulness, level, evidence/citation confidence, privacy/quarantine status, and manual facets.
- [ ] CLI/API can run retention audit without modifying data.
- [x] Results include reasons and policy version.

### AMO-08 Governance actions

CML MUST provide governed state transitions for quarantine/tombstone candidates.

Acceptance criteria:

- P0 supports dry-run and quarantine only; hard delete is not implemented.
- Every governance action records actor, target, before/after, reasons, source evidence.
- Default read paths continue suppressing quarantined rows unless explicit audit opt-in is set.

### AMO-09 Verification

CML MUST support verification state for memories/lessons/actions.

Acceptance criteria:

- Verification includes confidence, source event IDs, and optional evidence spans/source refs.
- Verified items can receive facet `quality:verified`.
- Verification failure cannot delete source memory; it can mark `quality:disputed` or `retention:review`.

### AMO-10 Weighted graph retrieval

CML MUST support bounded weighted graph expansion for retrieval.

Acceptance criteria:

- Graph expansion is disabled by default or bounded by `maxHops <= 2`.
- Path explanations include node names, relation types, and score contribution.
- It uses existing `edges`/`entities` first and adds history only in a later migration.

### AMO-11 Temporal graph state

CML SHOULD support temporal edge history for `asOf` graph queries.

Acceptance criteria:

- Edge history records valid time and commit/update time.
- `mem-graph-query` can answer current and `asOf` relationships.
- Temporal query is covered by replay/unit tests.

### AMO-12 Procedural lessons

CML SHOULD promote recurring successful workflows into lessons.

Acceptance criteria:

- A lesson is created only with at least two source sessions or explicit manual promotion.
- Each lesson has trigger, steps, source refs, confidence, and failure modes.
- Skill export is optional and manual.

### AMO-13 MCP tools

Operational MCP tools MUST be curated and project-safe.

Acceptance criteria:

- Tool handlers validate arguments with schema checks.
- State-changing tools require project scope and actor/holder string.
- Tools return compact JSON with redacted previews.
- Tests cover handler registration and project-scope failure.

### AMO-14 Dashboard/API observability

CML SHOULD expose operational memory health through existing dashboard stats patterns.

Acceptance criteria:

- Stats include facet distribution, action status counts, active leases, retention decisions, governance audit counts.
- No raw private content appears in aggregate stats.

### AMO-15 Evaluation gates

CML MUST add regression tests and replay fixtures before enabling ranking changes by default.

Acceptance criteria:

- `npm test -- --run` covers repositories/services/MCP handlers.
- `npm run benchmark:replay` remains green.
- New fixture categories cover facet filter, graph path, retention quarantine, and source-ref redaction.

## 8. MCP/API sketch

### 8.1 `mem-facet-query`

Input:

```json
{
  "projectPath": "/repo/path",
  "dimension": "workflow",
  "value": "release",
  "targetType": "event",
  "limit": 20
}
```

Output:

```json
{
  "results": [
    {
      "targetRef": "event:<id>",
      "preview": "redacted compact preview",
      "facets": [{ "dimension": "workflow", "value": "release", "confidence": 0.9 }],
      "sourceRefs": ["mem:abcd12"]
    }
  ],
  "meta": { "projectHash": "...", "total": 1 }
}
```

### 8.2 `mem-frontier`

Input:

```json
{
  "projectPath": "/repo/path",
  "limit": 10,
  "includeBlocked": false,
  "claim": false,
  "holder": "hermes-main"
}
```

Output:

```json
{
  "actions": [
    {
      "actionId": "act_...",
      "title": "Improve retrieval replay fixture",
      "status": "pending",
      "score": 0.82,
      "reasons": ["high_priority", "recent_user_request", "unleased"],
      "sourceRefs": ["event:..."]
    }
  ]
}
```

### 8.3 `mem-retention-audit`

Input:

```json
{
  "projectPath": "/repo/path",
  "dryRun": true,
  "policyVersion": "v1",
  "limit": 100
}
```

Output:

```json
{
  "dryRun": true,
  "policyVersion": "v1",
  "summary": {
    "keep": 70,
    "review": 20,
    "quarantine": 0,
    "tombstone_candidate": 0
  },
  "samples": [
    {
      "targetRef": "event:...",
      "decision": "review",
      "score": 0.42,
      "reasons": ["low_helpfulness", "old_l0", "never_retrieved"]
    }
  ]
}
```

## 9. Quality bar

A successful implementation must satisfy:

1. No default behavior regression for existing `mem-context-pack`, `mem-search`, `mem-source-ref` tools.
2. New operational tools are project-scoped and privacy-safe by default.
3. Derived tables are rebuildable or idempotent.
4. Governance actions are auditable and non-destructive in P0.
5. Retrieval ranking changes are behind config flags until replay fixtures pass.
6. Dashboard/API aggregates never expose raw secret-bearing payloads.

## 10. Open questions

1. Should actions be backed directly by `task` entities, or should `memory_actions` be a separate projection that references task entities when available?
2. Should facet taxonomy be user-configurable in config, or fixed in code for v1?
3. Which actor string should MCP use by default: tool caller, session id, configured agent name, or explicit input?
4. Should retention decisions produce new events, rows in `memory_governance_audit`, or both?
5. Should procedural lessons be exported to Hermes skills automatically or only as review candidates?

## 11. Initial decision recommendations

1. Use separate projection tables for actions/facets/retention to preserve existing event model.
2. Start with fixed built-in facet dimensions plus custom values.
3. Require explicit `actor`/`holder` for state-changing CLI/MCP calls; default to `cml-cli` only for CLI commands.
4. Store governance decisions in `memory_governance_audit` first; append raw event only for user-visible milestones.
5. Keep lesson-to-skill export manual until evidence quality is proven.
