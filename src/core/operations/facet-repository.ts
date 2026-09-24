import { randomUUID } from 'crypto';

import {
  sqliteAll,
  sqliteGet,
  sqliteRun,
  toDateFromSQLite,
  type SQLiteDatabase
} from '../sqlite-wrapper.js';
import {
  FacetSourceSchema,
  FacetTargetTypeSchema,
  parseFacetAssignmentInput,
  parseFacetQuery,
  parseFacetRemoveInput,
  type FacetAssignmentInput,
  type FacetQuery,
  type FacetRemoveInput,
  type FacetTargetType,
  type MemoryFacetAssignment
} from './facets.js';
import { writeGovernanceAuditEntry } from './governance-audit.js';

interface MemoryFacetRow {
  id: string;
  target_type: string;
  target_id: string;
  dimension: string;
  value: string;
  confidence: number;
  source: string;
  evidence_event_ids: string;
  project_hash: string | null;
  created_at: string;
  updated_at: string;
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
  } catch {
    return [];
  }
}

function projectHashToStorage(projectHash: string | undefined): string {
  return projectHash ?? '';
}

function rowToFacet(row: MemoryFacetRow): MemoryFacetAssignment {
  const projectHash = typeof row.project_hash === 'string' && row.project_hash.length > 0
    ? row.project_hash
    : undefined;

  return {
    id: row.id,
    targetType: FacetTargetTypeSchema.parse(row.target_type),
    targetId: row.target_id,
    dimension: row.dimension,
    value: row.value,
    confidence: Number(row.confidence),
    source: FacetSourceSchema.parse(row.source),
    evidenceEventIds: parseStringArray(row.evidence_event_ids),
    projectHash,
    createdAt: toDateFromSQLite(row.created_at),
    updatedAt: toDateFromSQLite(row.updated_at)
  };
}

function facetToAuditJson(facet: MemoryFacetAssignment): Record<string, unknown> {
  return {
    id: facet.id,
    targetType: facet.targetType,
    targetId: facet.targetId,
    dimension: facet.dimension,
    value: facet.value,
    confidence: facet.confidence,
    source: facet.source,
    evidenceEventIds: facet.evidenceEventIds,
    projectHash: facet.projectHash,
    createdAt: facet.createdAt.toISOString(),
    updatedAt: facet.updatedAt.toISOString()
  };
}

export class FacetRepository {
  constructor(private readonly db: SQLiteDatabase) {}

  async assign(input: unknown): Promise<MemoryFacetAssignment> {
    const assignment = parseFacetAssignmentInput(input);
    const existing = this.findByUniqueKey(assignment);
    const now = new Date().toISOString();

    if (existing) {
      sqliteRun(
        this.db,
        `UPDATE memory_facets
         SET confidence = ?, evidence_event_ids = ?, project_hash = ?, updated_at = ?
         WHERE id = ?`,
        [
          assignment.confidence,
          JSON.stringify(assignment.evidenceEventIds),
          projectHashToStorage(assignment.projectHash),
          now,
          existing.id
        ]
      );
      const saved = this.getById(existing.id);
      await this.auditAssignment(assignment, existing, saved);
      return saved;
    }

    const id = randomUUID();
    sqliteRun(
      this.db,
      `INSERT INTO memory_facets (
        id, target_type, target_id, dimension, value, confidence, source,
        evidence_event_ids, project_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        assignment.targetType,
        assignment.targetId,
        assignment.dimension,
        assignment.value,
        assignment.confidence,
        assignment.source,
        JSON.stringify(assignment.evidenceEventIds),
        projectHashToStorage(assignment.projectHash),
        now,
        now
      ]
    );

    const saved = this.getById(id);
    await this.auditAssignment(assignment, null, saved);
    return saved;
  }

  async remove(input: unknown): Promise<boolean> {
    const removeInput = parseFacetRemoveInput(input);
    const { sql, params } = this.removeSql(removeInput);
    const result = sqliteRun(this.db, sql, params);
    return result.changes > 0;
  }

  async query(input: unknown): Promise<MemoryFacetAssignment[]> {
    const query = parseFacetQuery(input);
    const { sql, params } = this.querySql(query);
    const rows = sqliteAll<MemoryFacetRow>(this.db, sql, params);
    return rows.map(rowToFacet);
  }

  async listForTarget(targetType: FacetTargetType, targetId: string): Promise<MemoryFacetAssignment[]> {
    const parsedTargetType = FacetTargetTypeSchema.parse(targetType);
    const trimmedTargetId = targetId.trim();
    if (!trimmedTargetId) {
      throw new Error('targetId is required');
    }
    return this.query({ targetType: parsedTargetType, targetId: trimmedTargetId, limit: 500 });
  }

  private getById(id: string): MemoryFacetAssignment {
    const row = sqliteGet<MemoryFacetRow>(this.db, `SELECT * FROM memory_facets WHERE id = ?`, [id]);
    if (!row) {
      throw new Error(`Memory facet not found after write: ${id}`);
    }
    return rowToFacet(row);
  }

  private findByUniqueKey(input: FacetAssignmentInput): MemoryFacetAssignment | null {
    const row = sqliteGet<MemoryFacetRow>(
      this.db,
      `SELECT * FROM memory_facets
       WHERE target_type = ? AND target_id = ? AND dimension = ? AND value = ? AND source = ? AND project_hash = ?`,
      [
        input.targetType,
        input.targetId,
        input.dimension,
        input.value,
        input.source,
        projectHashToStorage(input.projectHash)
      ]
    );
    return row ? rowToFacet(row) : null;
  }

  private async auditAssignment(
    input: FacetAssignmentInput,
    before: MemoryFacetAssignment | null,
    after: MemoryFacetAssignment
  ): Promise<void> {
    await writeGovernanceAuditEntry(this.db, {
      operation: 'facet_tag',
      actor: input.actor ?? 'cml-core',
      projectHash: input.projectHash,
      targetType: input.targetType,
      targetId: input.targetId,
      beforeJson: before ? facetToAuditJson(before) : undefined,
      afterJson: facetToAuditJson(after),
      sourceEventIds: input.evidenceEventIds
    });
  }

  private querySql(query: FacetQuery): { sql: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (query.targetType) {
      clauses.push('target_type = ?');
      params.push(query.targetType);
    }
    if (query.targetId) {
      clauses.push('target_id = ?');
      params.push(query.targetId);
    }
    if (query.dimension) {
      clauses.push('dimension = ?');
      params.push(query.dimension);
    }
    if (query.value) {
      clauses.push('value = ?');
      params.push(query.value);
    }
    if (query.source) {
      clauses.push('source = ?');
      params.push(query.source);
    }
    if (query.projectHash) {
      clauses.push('project_hash = ?');
      params.push(query.projectHash);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(query.limit);
    return {
      sql: `SELECT * FROM memory_facets ${where} ORDER BY confidence DESC, updated_at DESC LIMIT ?`,
      params
    };
  }

  private removeSql(input: FacetRemoveInput): { sql: string; params: unknown[] } {
    const clauses = [
      'target_type = ?',
      'target_id = ?',
      'dimension = ?',
      'value = ?',
      'source = ?',
      'project_hash = ?'
    ];
    const params: unknown[] = [
      input.targetType,
      input.targetId,
      input.dimension,
      input.value,
      input.source,
      projectHashToStorage(input.projectHash)
    ];

    return {
      sql: `DELETE FROM memory_facets WHERE ${clauses.join(' AND ')}`,
      params
    };
  }
}
