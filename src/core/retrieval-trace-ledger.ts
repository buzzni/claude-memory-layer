/**
 * Typed retrieval ledger (specs/recent-memory-patterns-2026-09-06 R1).
 *
 * `retrieval_traces` keeps its legacy id arrays for old readers. Every new
 * write additionally lands in `retrieval_trace_items`, where each reference
 * carries its kind, owning project and rank. New readers prefer the typed rows;
 * a read-only resolver reconstructs kinds for legacy traces without ever
 * mutating them.
 */

import { createHash } from 'crypto';
import {
  MEMORY_KINDS,
  inferMemoryKindFromLegacyId,
  memoryRefKey,
  normalizeMemoryKind,
  type MemoryKind,
  type ResolvedMemoryRef
} from './memory-ref.js';
import {
  emptyTypedSelectionSummary,
  type RetrievalTraceItem,
  type RetrievalTraceItemInput,
  type TypedSelectionSummary
} from './retrieval-telemetry.js';
import { sqliteAll, sqliteExec, sqliteRun, type SQLiteDatabase } from './sqlite-wrapper.js';

export const RETRIEVAL_TRACE_ITEMS_DDL = `
  CREATE TABLE IF NOT EXISTS retrieval_trace_items (
    trace_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    memory_kind TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    project_id TEXT,
    rank INTEGER,
    selected INTEGER NOT NULL DEFAULT 0,
    score REAL,
    content_hash TEXT,
    memory_version TEXT,
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (trace_id, item_key)
  );
  CREATE INDEX IF NOT EXISTS idx_retrieval_trace_items_memory
    ON retrieval_trace_items(memory_kind, memory_id);
  CREATE INDEX IF NOT EXISTS idx_retrieval_trace_items_selected
    ON retrieval_trace_items(selected, memory_kind);
`;

export function ensureRetrievalTraceItemsSchema(db: SQLiteDatabase): void {
  sqliteExec(db, RETRIEVAL_TRACE_ITEMS_DDL);
}

/** Content hash of the delivered excerpt. The excerpt itself is never stored. */
export function memoryContentHash(content: string | null | undefined): string | null {
  if (typeof content !== 'string' || content.length === 0) return null;
  return `sha256:${createHash('sha256').update(content).digest('hex').slice(0, 32)}`;
}

function tableExists(db: SQLiteDatabase, table: string): boolean {
  return sqliteAll<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [table]
  ).length > 0;
}

/**
 * Which memory tables actually contain an id. An id present in two tables stays
 * `unknown`/`ambiguous`: guessing a kind is exactly the failure mode that made
 * lesson selections look like dangling event ids.
 */
export function resolveMemoryRefKinds(
  db: SQLiteDatabase,
  ids: string[],
  options: { projectId?: string | null; allowedProjectIds?: string[] } = {}
): Map<string, ResolvedMemoryRef> {
  const resolved = new Map<string, ResolvedMemoryRef>();
  const unique = Array.from(new Set(ids.filter((id) => typeof id === 'string' && id.length > 0)));
  if (unique.length === 0) return resolved;

  const matches = new Map<string, Set<MemoryKind>>();
  const projectById = new Map<string, string | null>();
  const addMatch = (id: string, kind: MemoryKind, projectId: string | null) => {
    const set = matches.get(id) ?? new Set<MemoryKind>();
    set.add(kind);
    matches.set(id, set);
    if (!projectById.has(id) || projectById.get(id) === null) projectById.set(id, projectId);
  };

  for (let i = 0; i < unique.length; i += 400) {
    const chunk = unique.slice(i, i + 400);
    const placeholders = chunk.map(() => '?').join(',');
    // The event store is one database per project, so an event's owning
    // project is the store's project scope rather than a per-row column.
    if (tableExists(db, 'events')) {
      for (const row of sqliteAll<{ id: string }>(
        db,
        `SELECT id FROM events WHERE id IN (${placeholders})`,
        chunk
      )) addMatch(row.id, 'event', options.projectId ?? null);
    }
    if (tableExists(db, 'memory_lessons')) {
      for (const row of sqliteAll<{ lesson_id: string; project_hash: string | null }>(
        db,
        `SELECT lesson_id, project_hash FROM memory_lessons WHERE lesson_id IN (${placeholders})`,
        chunk
      )) addMatch(row.lesson_id, 'lesson', row.project_hash ?? null);
    }
    if (tableExists(db, 'consolidated_rules')) {
      for (const row of sqliteAll<{ rule_id: string }>(
        db,
        `SELECT rule_id FROM consolidated_rules WHERE rule_id IN (${placeholders})`,
        chunk
      )) addMatch(row.rule_id, 'rule', null);
    }
    // Core blocks are delivered as the pseudo-id `core:<blockKey>`. The prefix
    // alone is a claim, not proof: resolve it against the block table so a
    // reference to a block that no longer exists is reported as unresolved
    // instead of being counted as a healthy core delivery (specs R1).
    if (tableExists(db, 'core_memory_blocks')) {
      const coreKeys = chunk
        .filter((id) => inferMemoryKindFromLegacyId(id) === 'core')
        .map((id) => id.slice('core:'.length));
      if (coreKeys.length > 0) {
        const corePlaceholders = coreKeys.map(() => '?').join(',');
        for (const row of sqliteAll<{ block_key: string; project_hash: string | null }>(
          db,
          `SELECT block_key, project_hash FROM core_memory_blocks WHERE block_key IN (${corePlaceholders})`,
          coreKeys
        )) {
          addMatch(
            `core:${row.block_key}`,
            'core',
            row.project_hash && row.project_hash.length > 0 ? row.project_hash : (options.projectId ?? null)
          );
        }
      }
    }
  }

  const allowed = options.allowedProjectIds ? new Set(options.allowedProjectIds) : null;
  for (const id of unique) {
    const kinds = Array.from(matches.get(id) ?? []);
    const projectId = projectById.get(id) ?? null;
    if (kinds.length === 0) {
      resolved.set(id, { id, kind: 'unknown', projectId: options.projectId ?? null, resolution: 'unresolved', matchedKinds: [] });
      continue;
    }
    if (kinds.length > 1) {
      resolved.set(id, { id, kind: 'unknown', projectId, resolution: 'ambiguous', matchedKinds: kinds });
      continue;
    }
    // A reference the caller may not read is reported, never silently typed.
    if (allowed && projectId && !allowed.has(projectId)) {
      resolved.set(id, { id, kind: 'unknown', projectId, resolution: 'forbidden', matchedKinds: kinds });
      continue;
    }
    resolved.set(id, { id, kind: kinds[0], projectId, resolution: 'resolved', matchedKinds: kinds });
  }
  return resolved;
}

export function normalizeTraceItems(
  items: RetrievalTraceItemInput[],
  defaults: { projectId?: string | null } = {}
): RetrievalTraceItem[] {
  const byKey = new Map<string, RetrievalTraceItem>();
  items.forEach((item, index) => {
    if (!item || typeof item.id !== 'string' || item.id.length === 0) return;
    const kind = normalizeMemoryKind(item.kind);
    const projectId = item.projectId ?? defaults.projectId ?? null;
    // Scope-aware: the same kind/id in two projects is two memories under two
    // permission boundaries and must not collapse onto one row (specs R1).
    // The key is derived from the normalized identity. Accepting a caller's
    // arbitrary key would let two different refs collapse onto one row, or the
    // same ref occupy multiple rows with conflicting metadata.
    const itemKey = memoryRefKey({ projectId, kind, id: item.id });
    const score = typeof item.score === 'number' && Number.isFinite(item.score) ? item.score : null;
    const existing = byKey.get(itemKey);
    const normalized: RetrievalTraceItem = {
      traceId: '',
      itemKey,
      memoryKind: kind,
      memoryId: item.id,
      projectId,
      rank: typeof item.rank === 'number' && Number.isFinite(item.rank) ? Math.max(0, Math.floor(item.rank)) : index,
      selected: item.selected === true || existing?.selected === true,
      score: score ?? existing?.score ?? null,
      contentHash: item.contentHash ?? existing?.contentHash ?? null,
      memoryVersion: item.memoryVersion ?? existing?.memoryVersion ?? null,
      deleted: item.deleted === true || existing?.deleted === true
    };
    byKey.set(itemKey, existing ? { ...normalized, rank: existing.rank } : normalized);
  });
  return Array.from(byKey.values());
}

export function writeTraceItems(
  db: SQLiteDatabase,
  traceId: string,
  items: RetrievalTraceItem[]
): void {
  if (items.length === 0) return;
  for (const item of items) {
    sqliteRun(
      db,
      `INSERT INTO retrieval_trace_items (
         trace_id, item_key, memory_kind, memory_id, project_id, rank, selected, score,
         content_hash, memory_version, deleted
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(trace_id, item_key) DO UPDATE SET
         memory_kind = excluded.memory_kind,
         memory_id = excluded.memory_id,
         project_id = excluded.project_id,
         rank = excluded.rank,
         selected = MAX(retrieval_trace_items.selected, excluded.selected),
         score = COALESCE(excluded.score, retrieval_trace_items.score),
         content_hash = COALESCE(excluded.content_hash, retrieval_trace_items.content_hash),
         memory_version = COALESCE(excluded.memory_version, retrieval_trace_items.memory_version),
         deleted = MAX(retrieval_trace_items.deleted, excluded.deleted)`,
      [
        traceId, item.itemKey, item.memoryKind, item.memoryId, item.projectId,
        item.rank, item.selected ? 1 : 0, item.score,
        item.contentHash, item.memoryVersion, item.deleted ? 1 : 0
      ]
    );
  }
}

export function readTraceItems(db: SQLiteDatabase, traceId: string): RetrievalTraceItem[] {
  if (!tableExists(db, 'retrieval_trace_items')) return [];
  return sqliteAll<Record<string, unknown>>(
    db,
    `SELECT * FROM retrieval_trace_items WHERE trace_id = ? ORDER BY rank ASC`,
    [traceId]
  ).map(rowToTraceItem);
}

function rowToTraceItem(row: Record<string, unknown>): RetrievalTraceItem {
  return {
    traceId: String(row.trace_id ?? ''),
    itemKey: String(row.item_key ?? ''),
    memoryKind: normalizeMemoryKind(row.memory_kind),
    memoryId: String(row.memory_id ?? ''),
    projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
    rank: row.rank === null || row.rank === undefined ? null : Number(row.rank),
    selected: Number(row.selected) === 1,
    score: row.score === null || row.score === undefined ? null : Number(row.score),
    contentHash: row.content_hash === null || row.content_hash === undefined ? null : String(row.content_hash),
    memoryVersion: row.memory_version === null || row.memory_version === undefined ? null : String(row.memory_version),
    deleted: Number(row.deleted) === 1
  };
}

/**
 * Typed selections for a window. Traces that already have typed items are read
 * as-is; older traces are resolved read-only from their legacy arrays so a
 * report can reproduce the historical event/lesson split without a migration.
 */
export function summarizeTypedSelections(
  db: SQLiteDatabase,
  options: { since?: Date; until?: Date; resolveLegacy?: boolean } = {}
): TypedSelectionSummary {
  const summary = emptyTypedSelectionSummary();
  if (!tableExists(db, 'retrieval_traces')) return summary;

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.since) {
    clauses.push('julianday(created_at) >= julianday(?)');
    params.push(options.since.toISOString());
  }
  if (options.until) {
    clauses.push('julianday(created_at) < julianday(?)');
    params.push(options.until.toISOString());
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  const traces = sqliteAll<{ trace_id: string; selected_event_ids: string | null; project_hash: string | null }>(
    db,
    `SELECT trace_id, selected_event_ids, project_hash FROM retrieval_traces${where}`,
    params
  );

  const hasItems = tableExists(db, 'retrieval_trace_items');
  const legacyTraces: typeof traces = [];
  for (const trace of traces) {
    const typed = hasItems ? readTraceItems(db, trace.trace_id) : [];
    if (typed.length > 0) {
      summary.typedTraces += 1;
      for (const item of typed) {
        if (!item.selected) continue;
        summary.byKind[item.memoryKind] += 1;
        summary.total += 1;
        if (item.memoryKind === 'unknown') summary.unresolved += 1;
      }
      continue;
    }
    legacyTraces.push(trace);
  }

  if (options.resolveLegacy === false) return summary;

  const legacyIds: string[] = [];
  const perTrace: Array<{ traceId: string; ids: string[]; projectId: string | null }> = [];
  for (const trace of legacyTraces) {
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(trace.selected_event_ids || '[]');
      if (Array.isArray(parsed)) ids = parsed.filter((id): id is string => typeof id === 'string');
    } catch { /* corrupt legacy array contributes nothing */ }
    if (ids.length === 0) continue;
    perTrace.push({ traceId: trace.trace_id, ids, projectId: trace.project_hash ?? null });
    legacyIds.push(...ids);
  }
  if (perTrace.length === 0) return summary;

  const resolvedById = resolveMemoryRefKinds(db, legacyIds);
  for (const entry of perTrace) {
    summary.legacyResolvedTraces += 1;
    for (const id of entry.ids) {
      const ref = resolvedById.get(id);
      const kind = ref?.resolution === 'resolved' ? ref.kind : 'unknown';
      summary.byKind[kind] += 1;
      summary.total += 1;
      if (ref?.resolution === 'ambiguous') summary.ambiguous += 1;
      else if (!ref || ref.resolution !== 'resolved') summary.unresolved += 1;
    }
  }
  return summary;
}

export interface TraceItemBackfillResult {
  dryRun: boolean;
  scannedTraces: number;
  tracesWithItems: number;
  writtenItems: number;
  byKind: Record<MemoryKind, number>;
  unresolved: number;
  ambiguous: number;
}

/**
 * Explicit, opt-in backfill of typed items for legacy traces. Reports never
 * call this: reading is done with the resolver above so a read-only audit
 * cannot mutate a user's store.
 */
export function backfillTraceItems(
  db: SQLiteDatabase,
  options: { dryRun?: boolean; limit?: number; since?: Date } = {}
): TraceItemBackfillResult {
  const dryRun = options.dryRun !== false;
  const limit = Math.min(Math.max(options.limit ?? 1000, 1), 100_000);
  const result: TraceItemBackfillResult = {
    dryRun,
    scannedTraces: 0,
    tracesWithItems: 0,
    writtenItems: 0,
    byKind: Object.fromEntries(MEMORY_KINDS.map((kind) => [kind, 0])) as Record<MemoryKind, number>,
    unresolved: 0,
    ambiguous: 0
  };
  if (!tableExists(db, 'retrieval_traces')) return result;
  if (!dryRun) ensureRetrievalTraceItemsSchema(db);
  // A dry run against a store that predates the typed table still previews
  // every legacy trace: creating the table just to count would be a write.
  const hasItemsTable = tableExists(db, 'retrieval_trace_items');
  if (!dryRun && !hasItemsTable) return result;

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.since) {
    clauses.push('julianday(t.created_at) >= julianday(?)');
    params.push(options.since.toISOString());
  }
  if (hasItemsTable) {
    clauses.push('NOT EXISTS (SELECT 1 FROM retrieval_trace_items i WHERE i.trace_id = t.trace_id)');
  }
  // Empty traces never gain typed rows, so letting them consume the limit
  // would select the same empty batch forever. Filter usable arrays before
  // LIMIT, including corrupt legacy JSON and arrays without string IDs.
  clauses.push(`(${['candidate_event_ids', 'selected_event_ids'].map((column) =>
    `EXISTS (SELECT 1 FROM json_each(
      CASE WHEN json_valid(t.${column}) THEN
        CASE WHEN json_type(t.${column}) = 'array' THEN t.${column} ELSE '[]' END
      ELSE '[]' END
    ) AS id WHERE id.type = 'text' AND length(trim(id.value)) > 0)`
  ).join(' OR ')})`);
  params.push(limit);

  const traces = sqliteAll<{
    trace_id: string;
    selected_event_ids: string | null;
    candidate_event_ids: string | null;
    project_hash: string | null;
  }>(
    db,
    `SELECT t.trace_id, t.selected_event_ids, t.candidate_event_ids, t.project_hash
     FROM retrieval_traces t
     ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY t.created_at DESC
     LIMIT ?`,
    params
  );

  for (const trace of traces) {
    result.scannedTraces += 1;
    const selected = parseIdArray(trace.selected_event_ids);
    const candidates = parseIdArray(trace.candidate_event_ids);
    const all = Array.from(new Set([...candidates, ...selected]));
    if (all.length === 0) continue;
    const resolvedById = resolveMemoryRefKinds(db, all, { projectId: trace.project_hash ?? null });
    const items = normalizeTraceItems(
      all.map((id, index) => {
        const ref = resolvedById.get(id);
        if (ref?.resolution === 'ambiguous') result.ambiguous += 1;
        else if (!ref || ref.resolution !== 'resolved') result.unresolved += 1;
        const kind = ref?.resolution === 'resolved' ? ref.kind : 'unknown';
        result.byKind[kind] += 1;
        return {
          kind,
          id,
          projectId: ref?.projectId ?? trace.project_hash ?? null,
          rank: index,
          selected: selected.includes(id),
          // An id that resolves to no row today may have been deleted, may
          // predate a table, or may live in a store this reader cannot see.
          // `deleted` is reserved for an observed deletion; an unresolved
          // reference stays kind `unknown` and is counted as unresolved.
          deleted: false
        };
      }),
      { projectId: trace.project_hash ?? null }
    );
    result.tracesWithItems += 1;
    result.writtenItems += items.length;
    if (!dryRun) writeTraceItems(db, trace.trace_id, items);
  }
  return result;
}

function parseIdArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
  } catch {
    return [];
  }
}
