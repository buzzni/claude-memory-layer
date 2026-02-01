/**
 * Edge Repository - CRUD operations for entity/entry relationships
 * AXIOMMIND Entity-Edge Model
 */

import { dbRun, dbAll, toDate, type Database } from './db-wrapper.js';
import { randomUUID } from 'crypto';
import type { Edge, NodeType, RelationType } from './types.js';

export interface CreateEdgeInput {
  srcType: NodeType;
  srcId: string;
  relType: RelationType;
  dstType: NodeType;
  dstId: string;
  metaJson?: Record<string, unknown>;
}

export class EdgeRepo {
  constructor(private db: Database) {}

  /**
   * Create a new edge (idempotent - ignores duplicates)
   */
  async create(input: CreateEdgeInput): Promise<Edge> {
    const edgeId = randomUUID();
    const now = new Date();

    await dbRun(
      this.db,
      `INSERT INTO edges (edge_id, src_type, src_id, rel_type, dst_type, dst_id, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      [
        edgeId,
        input.srcType,
        input.srcId,
        input.relType,
        input.dstType,
        input.dstId,
        JSON.stringify(input.metaJson ?? {}),
        now.toISOString()
      ]
    );

    return {
      edgeId,
      srcType: input.srcType,
      srcId: input.srcId,
      relType: input.relType,
      dstType: input.dstType,
      dstId: input.dstId,
      metaJson: input.metaJson,
      createdAt: now
    };
  }

  /**
   * Create or update edge
   */
  async upsert(input: CreateEdgeInput): Promise<Edge> {
    // Check for existing edge
    const existing = await this.findByEndpoints(
      input.srcType,
      input.srcId,
      input.relType,
      input.dstType,
      input.dstId
    );

    if (existing) {
      // Update meta_json
      await dbRun(
        this.db,
        `UPDATE edges SET meta_json = ? WHERE edge_id = ?`,
        [JSON.stringify(input.metaJson ?? {}), existing.edgeId]
      );
      return { ...existing, metaJson: input.metaJson };
    }

    return this.create(input);
  }

  /**
   * Find edge by endpoints
   */
  async findByEndpoints(
    srcType: NodeType,
    srcId: string,
    relType: RelationType,
    dstType: NodeType,
    dstId: string
  ): Promise<Edge | null> {
    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM edges
       WHERE src_type = ? AND src_id = ? AND rel_type = ?
       AND dst_type = ? AND dst_id = ?`,
      [srcType, srcId, relType, dstType, dstId]
    );

    if (rows.length === 0) return null;
    return this.rowToEdge(rows[0]);
  }

  /**
   * Find edges by source
   */
  async findBySrc(
    srcId: string,
    relType?: RelationType
  ): Promise<Edge[]> {
    let query = `SELECT * FROM edges WHERE src_id = ?`;
    const params: unknown[] = [srcId];

    if (relType) {
      query += ` AND rel_type = ?`;
      params.push(relType);
    }

    query += ` ORDER BY created_at DESC`;

    const rows = await dbAll<Record<string, unknown>>(this.db, query, params);
    return rows.map(row => this.rowToEdge(row));
  }

  /**
   * Find edges by destination
   */
  async findByDst(
    dstId: string,
    relType?: RelationType
  ): Promise<Edge[]> {
    let query = `SELECT * FROM edges WHERE dst_id = ?`;
    const params: unknown[] = [dstId];

    if (relType) {
      query += ` AND rel_type = ?`;
      params.push(relType);
    }

    query += ` ORDER BY created_at DESC`;

    const rows = await dbAll<Record<string, unknown>>(this.db, query, params);
    return rows.map(row => this.rowToEdge(row));
  }

  /**
   * Find all edges for a node (both directions)
   */
  async findByNode(nodeId: string): Promise<{ outgoing: Edge[]; incoming: Edge[] }> {
    const outgoing = await this.findBySrc(nodeId);
    const incoming = await this.findByDst(nodeId);
    return { outgoing, incoming };
  }

  /**
   * Delete edge by ID
   */
  async delete(edgeId: string): Promise<boolean> {
    await dbRun(
      this.db,
      `DELETE FROM edges WHERE edge_id = ?`,
      [edgeId]
    );
    return true; // DuckDB doesn't return affected rows easily
  }

  /**
   * Delete edges by source and relation type
   */
  async deleteBySrcAndRel(srcId: string, relType: RelationType): Promise<number> {
    await dbRun(
      this.db,
      `DELETE FROM edges WHERE src_id = ? AND rel_type = ?`,
      [srcId, relType]
    );
    return 0; // DuckDB doesn't return affected rows easily
  }

  /**
   * Delete edges by destination and relation type
   */
  async deleteByDstAndRel(dstId: string, relType: RelationType): Promise<number> {
    await dbRun(
      this.db,
      `DELETE FROM edges WHERE dst_id = ? AND rel_type = ?`,
      [dstId, relType]
    );
    return 0;
  }

  /**
   * Replace edges for a source and relation type
   * Used for mode=replace in task_blockers_set
   */
  async replaceEdges(
    srcId: string,
    relType: RelationType,
    newEdges: Omit<CreateEdgeInput, 'srcId' | 'relType'>[]
  ): Promise<Edge[]> {
    // Delete existing edges
    await this.deleteBySrcAndRel(srcId, relType);

    // Create new edges
    const created: Edge[] = [];
    for (const edge of newEdges) {
      const newEdge = await this.create({
        srcType: edge.srcType,
        srcId,
        relType,
        dstType: edge.dstType,
        dstId: edge.dstId,
        metaJson: edge.metaJson
      });
      created.push(newEdge);
    }

    return created;
  }

  /**
   * Get effective blockers (resolving condition → task)
   * Returns resolved blocker if condition has resolves_to edge
   */
  async getEffectiveBlockers(taskId: string): Promise<Array<{
    originalId: string;
    effectiveId: string;
    isResolved: boolean;
  }>> {
    const blockerEdges = await this.findBySrc(taskId, 'blocked_by');
    const results: Array<{
      originalId: string;
      effectiveId: string;
      isResolved: boolean;
    }> = [];

    for (const edge of blockerEdges) {
      // Check if blocker has resolves_to edge
      const resolvesTo = await dbAll<Record<string, unknown>>(
        this.db,
        `SELECT dst_id FROM edges
         WHERE src_id = ? AND rel_type = 'resolves_to'
         LIMIT 1`,
        [edge.dstId]
      );

      if (resolvesTo.length > 0) {
        results.push({
          originalId: edge.dstId,
          effectiveId: resolvesTo[0].dst_id as string,
          isResolved: true
        });
      } else {
        results.push({
          originalId: edge.dstId,
          effectiveId: edge.dstId,
          isResolved: false
        });
      }
    }

    return results;
  }

  /**
   * Find 2-hop related entries (Entry → Entity → Entry)
   */
  async findRelatedEntries(entryId: string): Promise<Array<{
    entryId: string;
    viaEntityId: string;
    relationPath: string;
  }>> {
    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `WITH first_hop AS (
         SELECT e1.dst_id AS entity_id
         FROM edges e1
         WHERE e1.src_type = 'entry'
           AND e1.rel_type = 'evidence_of'
           AND e1.src_id = ?
       )
       SELECT
         e2.src_id AS entry_id,
         f.entity_id AS via_entity_id,
         'evidence_of→evidence_of' AS relation_path
       FROM first_hop f
       JOIN edges e2 ON e2.dst_id = f.entity_id
                    AND e2.rel_type = 'evidence_of'
                    AND e2.src_type = 'entry'
       WHERE e2.src_id != ?`,
      [entryId, entryId]
    );

    return rows.map(row => ({
      entryId: row.entry_id as string,
      viaEntityId: row.via_entity_id as string,
      relationPath: row.relation_path as string
    }));
  }

  /**
   * Count edges by relation type
   */
  async countByRelType(): Promise<Array<{ relType: string; count: number }>> {
    const rows = await dbAll<{ rel_type: string; count: number }>(
      this.db,
      `SELECT rel_type, COUNT(*) as count FROM edges GROUP BY rel_type`
    );
    return rows.map(row => ({
      relType: row.rel_type,
      count: Number(row.count)
    }));
  }

  /**
   * Convert database row to Edge
   */
  private rowToEdge(row: Record<string, unknown>): Edge {
    return {
      edgeId: row.edge_id as string,
      srcType: row.src_type as NodeType,
      srcId: row.src_id as string,
      relType: row.rel_type as RelationType,
      dstType: row.dst_type as NodeType,
      dstId: row.dst_id as string,
      metaJson: typeof row.meta_json === 'string'
        ? JSON.parse(row.meta_json)
        : row.meta_json as Record<string, unknown> | undefined,
      createdAt: toDate(row.created_at)
    };
  }
}
