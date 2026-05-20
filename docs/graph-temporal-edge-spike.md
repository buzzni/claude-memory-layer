# Temporal Edge History Design Spike

Status: accepted design direction for AgentMemory-inspired memory operations Task 5.4.

## Decision

Use a new append-only `edge_history` table as the source of temporal graph state, while keeping the existing `edges` table as the current-state projection used by today's graph retrieval.

Do not encode edge history only inside `edges.meta_json`, and do not defer temporal graph state to a pure event-derived projection.

## Why this shape

### Existing CML graph shape

CML already has:

- `entities(entity_id, entity_type, canonical_key, title, status, current_json, ...)`
- `entity_aliases(entity_type, canonical_key, entity_id, ...)`
- `edges(edge_id, src_type, src_id, rel_type, dst_type, dst_id, meta_json, created_at)`
- `GraphPathService.expand()` over active current `edges`/`entities`, bounded to `maxHops <= 2`
- `EdgeRepo` methods that create, upsert, replace, query, and delete current edges

Task 5.1 and Task 5.3 intentionally use current `edges` first and defer history. Temporal history should therefore be additive and keep current retrieval fast and compatible.

### AgentMemory reference behavior

AgentMemory models each graph edge with temporal/version fields such as:

- `tcommit` — when the system committed this version
- `tvalid` / `tvalidEnd` — when the relationship is valid in the modeled world
- `version`, `supersededBy`, `isLatest`, `stale`
- `sourceObservationIds` and contextual evidence

It also has a separate graph edge history store. The important design lesson is not the exact KV shape; it is the separation between:

1. current/latest edge state, and
2. historical versions that can answer `asOf` queries.

## Options considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Store history only in `edges.meta_json` | No migration table; minimal short-term code | Hard to index/query; JSON validation scattered; current row mutability loses append-only audit; difficult to support valid-time and commit-time together | Reject |
| New `edge_history` table + current `edges` projection | Queryable, testable, append-only; preserves existing fast current graph retrieval; supports bitemporal fields and audit/evidence safely | Requires migration/backfill and repo API changes; current/history consistency must be maintained | Accept |
| Pure event-derived projection rebuilt from raw events | Best source-of-truth purity; rebuildable | Expensive for `asOf`; historical relationship updates are not represented cleanly in current events; requires more event ontology before product value | Defer as a later rebuild/repair source, not primary runtime table |

## Proposed schema

Use a migration that creates `edge_history` only if absent. Keep legacy stores compatible by making temporal services feature-detect the table.

```sql
CREATE TABLE IF NOT EXISTS edge_history (
  history_id TEXT PRIMARY KEY,
  edge_id TEXT NOT NULL,
  edge_key TEXT NOT NULL,
  src_type TEXT NOT NULL,
  src_id TEXT NOT NULL,
  rel_type TEXT NOT NULL,
  dst_type TEXT NOT NULL,
  dst_id TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'active',
  valid_from TEXT,
  valid_to TEXT,
  committed_at TEXT NOT NULL DEFAULT (datetime('now')),
  superseded_by_history_id TEXT,
  source_event_ids_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  meta_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_edge_history_key_commit
  ON edge_history(edge_key, committed_at DESC, history_id DESC);

CREATE INDEX IF NOT EXISTS idx_edge_history_valid
  ON edge_history(edge_key, valid_from, valid_to);

CREATE INDEX IF NOT EXISTS idx_edge_history_src
  ON edge_history(src_id, rel_type, committed_at DESC);

CREATE INDEX IF NOT EXISTS idx_edge_history_dst
  ON edge_history(dst_id, rel_type, committed_at DESC);

CREATE INDEX IF NOT EXISTS idx_edge_history_status
  ON edge_history(status);
```

### Field notes

- `edge_key` is a deterministic logical relationship key: `src_type|src_id|rel_type|dst_type|dst_id`.
- `edge_id` points at the current `edges.edge_id` when a current projection row exists. It may repeat across versions.
- `history_id` uniquely identifies a version.
- `committed_at` is system/update time.
- `valid_from`/`valid_to` are modeled-world validity time. `NULL valid_from` means unknown beginning. `NULL valid_to` means still valid.
- `weight` is promoted out of `meta_json` because graph traversal needs it indexed/validated and AgentMemory treats weight as first-class.
- `source_event_ids_json` and `evidence_json` should contain IDs/source refs and bounded evidence only, not raw private content.
- `meta_json` remains for non-indexed relation metadata.

## Write semantics

Add an `EdgeHistoryRepo` and make edge writes go through a single service boundary. Avoid triggers in the first implementation because current TypeScript tests can more directly verify repository behavior and legacy optional-table fallback.

### Create/upsert current edge

1. Normalize endpoints and relation into `edge_key`.
2. Resolve the current active history row for that key, if any.
3. If the logical relationship is unchanged except evidence/source IDs, append a new history row only when temporal fields or weight changed; otherwise update current `edges.meta_json` conservatively as today.
4. If relationship semantics changed, mark previous active history row `status='superseded'`, set its `valid_to` if missing, and set `superseded_by_history_id` to the new row.
5. Insert a new `edge_history` row with `status='active'`.
6. Upsert `edges` as the latest/current projection with sanitized `meta_json` containing at most `weight`, `historyId`, and bounded non-private metadata.

### Delete/quarantine current edge

Do not hard-delete history. For current graph suppression:

- append or update a history row with `status='tombstoned'`/`'quarantined'`, or mark the active history row as no longer active;
- remove/suppress the current `edges` projection row only if the caller explicitly requested current graph removal;
- keep source refs and audit metadata.

## Query semantics

### Current graph retrieval

Existing `GraphPathService.expand()` should continue reading `edges` by default. This keeps Task 5.1/5.3 behavior unchanged and fast.

### Temporal graph query

Introduce a new service rather than expanding every current retrieval path immediately:

```ts
interface TemporalGraphQueryInput {
  startNodes?: Array<{ type: NodeType; id: string }>;
  edgeKey?: string;
  asOf?: Date;      // modeled-world valid time
  knownAt?: Date;   // system commit time, defaults to now
  maxHops?: number; // clamp <= 2
  direction?: 'outgoing' | 'incoming' | 'both';
}
```

Temporal row selection for one logical edge key:

```sql
SELECT *
FROM edge_history
WHERE edge_key = ?
  AND status = 'active'
  AND committed_at <= :knownAt
  AND (valid_from IS NULL OR valid_from <= :asOf)
  AND (valid_to IS NULL OR valid_to > :asOf)
ORDER BY committed_at DESC, history_id DESC
LIMIT 1;
```

For graph expansion, build adjacency from the selected row per `edge_key`, then reuse the bounded weighted traversal semantics from `GraphPathService`.

### MCP/API surface

Add `asOf` only to a graph-specific query surface first, not broad memory retrieval ranking:

- `mem-graph-query({ projectPath, query|startNodeId, asOf?, knownAt?, maxHops? })`
- response includes bounded path metadata and safe source refs
- no raw edge rows, raw file paths, or private payloads

Only after temporal unit/replay tests are green should broader retrieval use `asOf` ranking by default.

## Migration plan

1. Add nullable/optional-table migration for `edge_history`.
2. Backfill one history row per existing `edges` row:
   - `history_id`: generated deterministic or UUID value
   - `edge_id`: existing `edges.edge_id`
   - `edge_key`: derived from endpoints/relation
   - `weight`: parsed from `meta_json.weight`, default `0.5`
   - `committed_at`: existing `edges.created_at` when available, otherwise migration time
   - `valid_from`: existing `edges.created_at` when available, otherwise `NULL`
   - `source_event_ids_json`: parse bounded known source refs from `meta_json` if present, otherwise `[]`
3. Add `EdgeHistoryRepo` with unit tests for create/upsert/supersede/current/asOf selection.
4. Update `EdgeRepo` or introduce `EdgeService` so current and history writes are consistent.
5. Add `TemporalGraphService` tests for:
   - current relationship selection
   - `asOf` before/after supersession
   - `knownAt` excluding future commits
   - tombstone/quarantine exclusion
   - legacy DB without `edge_history` fallback
6. Add MCP handler only after service-level behavior is covered.

## Migration risks and mitigations

| Risk | Mitigation |
|---|---|
| Current/history drift | Route writes through one `EdgeService`; add integrity check comparing active latest rows to `edges` projection |
| Duplicate legacy edges | Backfill by physical `edge_id` first; later add optional dedupe by `edge_key` after diagnostics report duplicates |
| Incorrect temporal assumptions during backfill | Use conservative defaults; `valid_from=NULL` is safer than inventing business validity if `created_at` is unreliable |
| Query slowdown | Keep current retrieval on `edges`; index `edge_history` by `edge_key`, src/dst, valid time, committed time |
| Privacy leaks through evidence/context | Store IDs/source refs and bounded evidence JSON only; route any user-facing result through existing redaction/sanitization helpers |
| Hard delete breaks audit | Never delete `edge_history`; represent removal as tombstone/quarantine status |
| Legacy SQLite stores lack optional table | Feature-detect table; temporal service returns explicit unsupported/empty result instead of crashing |
| Bitemporal ambiguity | Document `asOf` as valid time and `knownAt` as commit time; default `knownAt` to now |

## Follow-up implementation recommendation

Implement `edge_history` in the next graph phase as a P1 additive migration:

1. `EdgeHistoryRepo` + migration/backfill tests.
2. `TemporalGraphService` for current/asOf row selection and bounded traversal.
3. `mem-graph-query` with `asOf` after service tests.
4. Retrieval ranking integration only after replay fixtures prove no privacy or relevance regressions.

This gives CML AgentMemory-style temporal graph semantics without destabilizing the current SQLite source-of-truth or the already-verified graph path retrieval/disclosure work.
