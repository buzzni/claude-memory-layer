/**
 * Reference navigation telemetry.
 *
 * Split out of the event store so any caller holding a SQLite handle can record
 * that a delivered reference was actually opened, together with the typed kind
 * of the memory (specs/recent-memory-patterns-2026-09-06 R1/R3).
 */

import { randomUUID } from 'crypto';
import { normalizeMemoryKind } from './memory-ref.js';
import {
  normalizeRetrievalTriggerType,
  normalizeTelemetryClient,
  type RecordReferenceNavigationInput,
  type RecordReferenceNavigationResult
} from './retrieval-telemetry.js';
import { readTraceItems } from './retrieval-trace-ledger.js';
import { sqliteAll, sqliteGet, sqliteRun, type SQLiteDatabase } from './sqlite-wrapper.js';

/**
 * Attribution window for an opened reference. Deliberately short: a reference
 * opened long after delivery cannot be attributed to it with confidence.
 */
export const REFERENCE_ATTRIBUTION_WINDOW_MS = 15 * 60 * 1000;

function tableExists(db: SQLiteDatabase, table: string): boolean {
  return sqliteAll<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [table]
  ).length > 0;
}

function columnExists(db: SQLiteDatabase, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  return sqliteAll<{ name: string }>(db, `PRAGMA table_info(${table})`)
    .some((row) => row.name === column);
}

/**
 * Reference navigation attribution (specs/recent-memory-patterns R1/R3).
 *
 * Kept as a database-level function so callers that hold only a SQLite handle —
 * `mem-lesson-get`, `mem-source-ref`, `mem-details` — can record an opened
 * reference against the trace that delivered it, with the memory's typed kind.
 * Attribution is deliberately conservative: only a unique recent reference
 * delivery is attributed, everything else stays ambiguous or unattributed.
 */
export function recordReferenceNavigationOnDb(
  db: SQLiteDatabase,
  input: RecordReferenceNavigationInput
): RecordReferenceNavigationResult {
  const openedAt = input.openedAt ?? new Date();
  const windowStart = new Date(openedAt.getTime() - REFERENCE_ATTRIBUTION_WINDOW_MS).toISOString();
  const openedAtIso = openedAt.toISOString();
  const targetKind = normalizeMemoryKind(input.targetKind ?? 'event');
  const targetProjectId = input.targetProjectId ?? null;
  const hasTypedItems = tableExists(db, 'retrieval_trace_items');
  // Attribution needs delivery evidence, not just selection. A trace whose
  // context was formatted but never emitted (or whose write failed) did not put
  // this reference in front of anyone, so an open cannot belong to it
  // (specs R3, finding 10). Stores whose helpfulness rows predate the delivery
  // columns cannot express this, and keep the older selection-based behaviour
  // rather than losing every attribution.
  const deliveryEvidenceAvailable = columnExists(db, 'memory_helpfulness', 'delivery_status');
  const wasDelivered = (traceId: string): boolean => {
    if (!deliveryEvidenceAvailable) return true;
    // A helpfulness row written before the typed columns carries kind
    // `unknown`; it cannot disprove the match, so it is admitted alongside an
    // exact kind match rather than excluded.
    const kindClause = columnExists(db, 'memory_helpfulness', 'memory_kind')
      ? ` AND COALESCE(memory_kind, 'event') IN (?, 'unknown')`
      : '';
    const scopeClause = columnExists(db, 'memory_helpfulness', 'memory_project_id')
      ? ' AND memory_project_id IS ?' : '';
    const params: unknown[] = [traceId, input.targetEventId];
    if (kindClause) params.push(targetKind);
    if (scopeClause) params.push(targetProjectId);
    const row = sqliteGet<{ delivered: number }>(
      db,
      `SELECT 1 AS delivered FROM memory_helpfulness
       WHERE trace_id = ? AND event_id = ?${kindClause}${scopeClause}
         AND delivery_status IN ('emitted', 'acknowledged')
       LIMIT 1`,
      params
    );
    if (row) return true;
    // An instrumented store needs positive delivery evidence. Absence is
    // unknown, and must never become attributed navigation by assumption.
    return false;
  };
  const traceRows = sqliteAll<Record<string, unknown>>(
    db,
    `SELECT trace_id, session_id, trigger_type, selected_event_ids
     FROM retrieval_traces
     WHERE presentation_mode = 'reference'
       AND datetime(created_at) >= datetime(?)
       AND datetime(created_at) <= datetime(?)
     ORDER BY created_at DESC
     LIMIT 500`,
    [windowStart, openedAtIso]
  ).filter((row) => {
    if (input.attributionSessionId && row.session_id !== input.attributionSessionId) return false;
    // Prefer typed items so opening lesson X is never attributed to a trace
    // that merely delivered an event whose id happens to match (specs R1/R3).
    let selectedHere: boolean;
    if (hasTypedItems) {
      const typed = readTraceItems(db, String(row.trace_id || ''));
      if (typed.length > 0) {
        selectedHere = typed.some((item) =>
          item.selected && item.memoryId === input.targetEventId && item.memoryKind === targetKind && item.projectId === targetProjectId);
        return selectedHere && wasDelivered(String(row.trace_id || ''));
      }
    }
    try {
      const selected = JSON.parse(String(row.selected_event_ids || '[]'));
      selectedHere = Array.isArray(selected) && selected.includes(input.targetEventId);
    } catch {
      return false;
    }
    return selectedHere && wasDelivered(String(row.trace_id || ''));
  });

  const byTrace = new Map<string, Record<string, unknown>>();
  for (const row of traceRows) {
    const traceId = String(row.trace_id || '');
    if (traceId) byTrace.set(traceId, row);
  }
  const candidates = Array.from(byTrace.values());
  const attributed = candidates.length === 1 ? candidates[0] : undefined;
  const traceId = attributed ? String(attributed.trace_id) : null;
  const outcome = candidates.length === 1
    ? 'attributed'
    : candidates.length > 1
      ? 'ambiguous'
      : 'unattributed';
  const reason = candidates.length === 1
    ? 'unique_recent_reference_delivery'
    : candidates.length > 1
      ? 'multiple_recent_reference_deliveries'
      : 'no_recent_reference_delivery';
  const navigationClient = normalizeTelemetryClient(input.navigationClient);

  const repeated = sqliteGet<{ navigation_id: string }>(
    db,
    `SELECT navigation_id
     FROM retrieval_navigation_events
     WHERE target_event_id = ?
       AND memory_kind = ?
       AND memory_project_id IS ?
       AND trace_id IS ?
       AND navigation_action = ?
       AND navigation_client = ?
       AND attribution_outcome = ?
       AND datetime(last_opened_at) >= datetime(?)
     ORDER BY last_opened_at DESC
     LIMIT 1`,
    [input.targetEventId, targetKind, targetProjectId, traceId, input.action, navigationClient, outcome, windowStart]
  );

  if (repeated) {
    sqliteRun(
      db,
      `UPDATE retrieval_navigation_events
       SET open_count = open_count + 1, last_opened_at = ?
       WHERE navigation_id = ?`,
      [openedAtIso, repeated.navigation_id]
    );
    return { outcome, traceId, repeated: true };
  }

  sqliteRun(
    db,
    `INSERT INTO retrieval_navigation_events (
       navigation_id, target_event_id, trace_id, delivery_session_id,
       presentation_mode, trigger_type, memory_kind, memory_project_id, navigation_action, navigation_client,
       attribution_outcome, attribution_reason, open_count, first_opened_at, last_opened_at
     ) VALUES (?, ?, ?, ?, 'reference', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      randomUUID(),
      input.targetEventId,
      traceId,
      attributed?.session_id || input.attributionSessionId || null,
      normalizeRetrievalTriggerType(attributed?.trigger_type),
      targetKind,
      targetProjectId,
      input.action,
      navigationClient,
      outcome,
      reason,
      openedAtIso,
      openedAtIso
    ]
  );
  return { outcome, traceId, repeated: false };
}
