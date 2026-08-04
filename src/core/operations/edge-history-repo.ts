/**
 * Bitemporal edge history (Zep/Graphiti-inspired), see
 * docs/graph-temporal-edge-spike.md. `edges` (via EdgeRepo) stays the fast
 * current-state projection; this repository is the append-only source for
 * asOf/knownAt temporal graph queries.
 */

import { randomUUID } from 'crypto';

import {
  sqliteAll,
  sqliteGet,
  sqliteRun,
  sqliteTransaction,
  toDateFromSQLite,
  type SQLiteDatabase
} from '../sqlite-wrapper.js';
import type { NodeType, RelationType } from '../types.js';

export type EdgeHistoryStatus = 'active' | 'superseded' | 'tombstoned' | 'quarantined';

export interface EdgeHistoryRow {
  historyId: string;
  edgeId: string;
  edgeKey: string;
  srcType: NodeType;
  srcId: string;
  relType: RelationType;
  dstType: NodeType;
  dstId: string;
  weight: number;
  status: EdgeHistoryStatus;
  validFrom?: Date;
  validTo?: Date;
  committedAt: Date;
  supersededByHistoryId?: string;
  sourceEventIds: string[];
  evidence: Record<string, unknown>;
  metaJson: Record<string, unknown>;
}

export interface RecordEdgeVersionInput {
  edgeId: string;
  srcType: NodeType;
  srcId: string;
  relType: RelationType;
  dstType: NodeType;
  dstId: string;
  weight?: number;
  validFrom?: Date;
  validTo?: Date;
  sourceEventIds?: string[];
  evidence?: Record<string, unknown>;
  metaJson?: Record<string, unknown>;
}

interface EdgeHistoryDbRow {
  history_id: string;
  edge_id: string;
  edge_key: string;
  src_type: string;
  src_id: string;
  rel_type: string;
  dst_type: string;
  dst_id: string;
  weight: number;
  status: string;
  valid_from: string | null;
  valid_to: string | null;
  committed_at: string;
  superseded_by_history_id: string | null;
  source_event_ids_json: string;
  evidence_json: string;
  meta_json: string;
}

const DEFAULT_WEIGHT = 0.5;

/** Deterministic logical relationship key: src|rel|dst. */
export function makeEdgeKey(
  srcType: NodeType,
  srcId: string,
  relType: RelationType,
  dstType: NodeType,
  dstId: string
): string {
  return `${srcType}|${srcId}|${relType}|${dstType}|${dstId}`;
}

export function hasEdgeHistoryTable(db: SQLiteDatabase): boolean {
  const row = sqliteGet<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'edge_history' LIMIT 1`
  );
  return Boolean(row);
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function rowToEdgeHistory(row: EdgeHistoryDbRow): EdgeHistoryRow {
  return {
    historyId: row.history_id,
    edgeId: row.edge_id,
    edgeKey: row.edge_key,
    srcType: row.src_type as NodeType,
    srcId: row.src_id,
    relType: row.rel_type as RelationType,
    dstType: row.dst_type as NodeType,
    dstId: row.dst_id,
    weight: row.weight,
    status: row.status as EdgeHistoryStatus,
    validFrom: row.valid_from ? toDateFromSQLite(row.valid_from) : undefined,
    validTo: row.valid_to ? toDateFromSQLite(row.valid_to) : undefined,
    committedAt: toDateFromSQLite(row.committed_at),
    supersededByHistoryId: row.superseded_by_history_id ?? undefined,
    sourceEventIds: parseStringArray(row.source_event_ids_json),
    evidence: parseJsonObject(row.evidence_json),
    metaJson: parseJsonObject(row.meta_json)
  };
}

export class EdgeHistoryRepo {
  constructor(private readonly db: SQLiteDatabase) {}

  /**
   * Record a new version for one logical edge (create/upsert path).
   * NOOP (no new row) when neither the weight nor the metadata changed and no
   * explicit validTo override was given — repeated idempotent edge upserts
   * must not spam history. Otherwise the previous active row is superseded
   * and a new active row is inserted.
   *
   * The supersede/insert/backlink trio runs in one transaction: a partial
   * failure would otherwise leave the edge_key with zero active rows, which
   * makes getCurrent return null and silently corrupts the NOOP check on the
   * next call (EdgeRepo swallows history errors by design).
   */
  async recordVersion(input: RecordEdgeVersionInput): Promise<EdgeHistoryRow> {
    const edgeKey = makeEdgeKey(input.srcType, input.srcId, input.relType, input.dstType, input.dstId);
    const current = this.getCurrentSync(edgeKey);
    const now = new Date();
    const weight = input.weight ?? DEFAULT_WEIGHT;
    const metaJson = JSON.stringify(input.metaJson ?? {});

    if (
      current
      && current.weight === weight
      && JSON.stringify(current.metaJson) === metaJson
      && !input.validTo
    ) {
      return current;
    }

    const historyId = randomUUID();
    sqliteTransaction(this.db, () => {
      if (current) {
        sqliteRun(
          this.db,
          `UPDATE edge_history SET status = 'superseded', valid_to = COALESCE(valid_to, ?) WHERE history_id = ?`,
          [now.toISOString(), current.historyId]
        );
      }

      sqliteRun(
        this.db,
        `INSERT INTO edge_history (
          history_id, edge_id, edge_key, src_type, src_id, rel_type, dst_type, dst_id,
          weight, status, valid_from, valid_to, committed_at, superseded_by_history_id,
          source_event_ids_json, evidence_json, meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, ?, ?, ?)`,
        [
          historyId,
          input.edgeId,
          edgeKey,
          input.srcType,
          input.srcId,
          input.relType,
          input.dstType,
          input.dstId,
          weight,
          (input.validFrom ?? now).toISOString(),
          input.validTo ? input.validTo.toISOString() : null,
          now.toISOString(),
          JSON.stringify(input.sourceEventIds ?? []),
          JSON.stringify(input.evidence ?? {}),
          metaJson
        ]
      );

      if (current) {
        sqliteRun(this.db, `UPDATE edge_history SET superseded_by_history_id = ? WHERE history_id = ?`, [historyId, current.historyId]);
      }
    });

    const saved = this.getRowById(historyId);
    if (!saved) throw new Error('edge history row was not saved');
    return saved;
  }

  /** The current active version for a logical edge, or null. */
  async getCurrent(edgeKey: string): Promise<EdgeHistoryRow | null> {
    return this.getCurrentSync(edgeKey);
  }

  private getCurrentSync(edgeKey: string): EdgeHistoryRow | null {
    const row = sqliteGet<EdgeHistoryDbRow>(
      this.db,
      `SELECT * FROM edge_history
       WHERE edge_key = ? AND status = 'active'
       ORDER BY committed_at DESC, history_id DESC LIMIT 1`,
      [edgeKey]
    );
    return row ? rowToEdgeHistory(row) : null;
  }

  /**
   * The version of a logical edge that was valid at `asOf` (modeled-world
   * time) as understood by the system at `knownAt` (commit time, default now).
   *
   * Deviates from the spike doc's literal `status = 'active'` predicate: that
   * would make a past `asOf` only ever match the single current-head row
   * (exactly one row per edge_key can be 'active' at a time once
   * recordVersion supersedes the rest), so genuinely historical states could
   * never be reconstructed. Excluding only tombstoned/quarantined rows keeps
   * superseded-but-once-valid rows queryable, which is also the only reading
   * consistent with the doc's own "tombstone/quarantine exclusion" being a
   * distinct test case from ordinary supersession.
   */
  async selectAsOf(input: { edgeKey: string; asOf?: Date; knownAt?: Date }): Promise<EdgeHistoryRow | null> {
    const asOf = (input.asOf ?? new Date()).toISOString();
    const knownAt = (input.knownAt ?? new Date()).toISOString();
    const row = sqliteGet<EdgeHistoryDbRow>(
      this.db,
      `SELECT * FROM edge_history
       WHERE edge_key = ?
         AND status NOT IN ('tombstoned', 'quarantined')
         AND committed_at <= ?
         AND (valid_from IS NULL OR valid_from <= ?)
         AND (valid_to IS NULL OR valid_to > ?)
       ORDER BY committed_at DESC, history_id DESC LIMIT 1`,
      [input.edgeKey, knownAt, asOf, asOf]
    );
    return row ? rowToEdgeHistory(row) : null;
  }

  /** All versions for a logical edge, newest first — for tests/debugging. */
  async listByEdgeKey(edgeKey: string): Promise<EdgeHistoryRow[]> {
    const rows = sqliteAll<EdgeHistoryDbRow>(
      this.db,
      `SELECT * FROM edge_history WHERE edge_key = ? ORDER BY committed_at DESC, history_id DESC`,
      [edgeKey]
    );
    return rows.map(rowToEdgeHistory);
  }

  private getRowById(historyId: string): EdgeHistoryRow | null {
    const row = sqliteGet<EdgeHistoryDbRow>(this.db, `SELECT * FROM edge_history WHERE history_id = ?`, [historyId]);
    return row ? rowToEdgeHistory(row) : null;
  }
}
