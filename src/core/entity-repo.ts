/**
 * Entity Repository - CRUD operations for Task/Condition/Artifact entities
 * AXIOMMIND Principle 5: Task is Entity
 */

import { dbRun, dbAll, toDate, type Database } from './db-wrapper.js';
import { randomUUID } from 'crypto';
import type {
  Entity,
  EntityType,
  EntityStage,
  EntityStatus
} from './types.js';
import { makeEntityCanonicalKey } from './canonical-key.js';
import { EdgeRepo } from './edge-repo.js';
import {
  sanitizeGovernanceAuditValue,
  writeGovernanceAuditEntry
} from './operations/governance-audit.js';

export interface CreateEntityInput {
  entityType: EntityType;
  title: string;
  currentJson: Record<string, unknown>;
  project?: string;
  stage?: EntityStage;
  status?: EntityStatus;
}

export interface UpdateEntityInput {
  currentJson?: Record<string, unknown>;
  stage?: EntityStage;
  status?: EntityStatus;
  searchText?: string;
}

export class EntityRepo {
  constructor(private db: Database) {}

  /**
   * Create a new entity
   */
  async create(input: CreateEntityInput): Promise<Entity> {
    const entityId = randomUUID();
    const canonicalKey = makeEntityCanonicalKey(input.entityType, input.title, {
      project: input.project
    });

    const titleNorm = input.title.toLowerCase().trim();
    const searchText = `${input.title} ${JSON.stringify(input.currentJson)}`;

    const now = new Date();

    await dbRun(
      this.db,
      `INSERT INTO entities (
        entity_id, entity_type, canonical_key, title, stage, status,
        current_json, title_norm, search_text, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entityId,
        input.entityType,
        canonicalKey,
        input.title,
        input.stage ?? 'raw',
        input.status ?? 'active',
        JSON.stringify(input.currentJson),
        titleNorm,
        searchText,
        now.toISOString(),
        now.toISOString()
      ]
    );

    // Create primary alias
    await dbRun(
      this.db,
      `INSERT INTO entity_aliases (entity_type, canonical_key, entity_id, is_primary)
       VALUES (?, ?, ?, TRUE)
       ON CONFLICT (entity_type, canonical_key) DO NOTHING`,
      [input.entityType, canonicalKey, entityId]
    );

    return {
      entityId,
      entityType: input.entityType,
      canonicalKey,
      title: input.title,
      stage: input.stage ?? 'raw',
      status: input.status ?? 'active',
      currentJson: input.currentJson,
      titleNorm,
      searchText,
      createdAt: now,
      updatedAt: now
    };
  }

  /**
   * Find entity by ID
   */
  async findById(entityId: string): Promise<Entity | null> {
    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM entities WHERE entity_id = ?`,
      [entityId]
    );

    if (rows.length === 0) return null;
    return this.rowToEntity(rows[0]);
  }

  /**
   * Find entity by canonical key
   */
  async findByCanonicalKey(
    entityType: EntityType,
    canonicalKey: string
  ): Promise<Entity | null> {
    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM entities
       WHERE entity_type = ? AND canonical_key = ?`,
      [entityType, canonicalKey]
    );

    if (rows.length === 0) return null;
    return this.rowToEntity(rows[0]);
  }

  /**
   * Find or create entity by title (idempotent)
   */
  async findOrCreate(input: CreateEntityInput): Promise<{ entity: Entity; created: boolean }> {
    const canonicalKey = makeEntityCanonicalKey(input.entityType, input.title, {
      project: input.project
    });

    const existing = await this.findByCanonicalKey(input.entityType, canonicalKey);
    if (existing) {
      return { entity: existing, created: false };
    }

    const entity = await this.create(input);

    // `entities` has no unique constraint on canonical_key, so two concurrent
    // hook processes can both get past the lookup above and insert. The
    // `entity_aliases` PK is the arbiter: re-resolve through it so every racer
    // converges on the same entity and edges never split across duplicates.
    const canonical = await this.findByAlias(input.entityType, canonicalKey);
    if (canonical && canonical.entityId !== entity.entityId) {
      return { entity: canonical, created: false };
    }

    return { entity, created: true };
  }

  /**
   * Update entity
   */
  async update(entityId: string, input: UpdateEntityInput): Promise<Entity | null> {
    const existing = await this.findById(entityId);
    if (!existing) return null;

    const updates: string[] = [];
    const values: unknown[] = [];

    if (input.currentJson !== undefined) {
      updates.push('current_json = ?');
      values.push(JSON.stringify(input.currentJson));
    }
    if (input.stage !== undefined) {
      updates.push('stage = ?');
      values.push(input.stage);
    }
    if (input.status !== undefined) {
      updates.push('status = ?');
      values.push(input.status);
    }
    if (input.searchText !== undefined) {
      updates.push('search_text = ?');
      values.push(input.searchText);
    }

    updates.push('updated_at = ?');
    values.push(new Date().toISOString());

    values.push(entityId);

    await dbRun(
      this.db,
      `UPDATE entities SET ${updates.join(', ')} WHERE entity_id = ?`,
      values
    );

    return this.findById(entityId);
  }

  /**
   * List entities by type
   */
  async listByType(
    entityType: EntityType,
    options?: { status?: EntityStatus; limit?: number; offset?: number }
  ): Promise<Entity[]> {
    let query = `SELECT * FROM entities WHERE entity_type = ?`;
    const params: unknown[] = [entityType];

    if (options?.status) {
      query += ` AND status = ?`;
      params.push(options.status);
    }

    query += ` ORDER BY updated_at DESC`;

    if (options?.limit) {
      query += ` LIMIT ?`;
      params.push(options.limit);
    }
    if (options?.offset) {
      query += ` OFFSET ?`;
      params.push(options.offset);
    }

    const rows = await dbAll<Record<string, unknown>>(this.db, query, params);
    return rows.map(row => this.rowToEntity(row));
  }

  /**
   * Search entities by text
   */
  async search(
    query: string,
    options?: { entityType?: EntityType; limit?: number }
  ): Promise<Entity[]> {
    const searchPattern = `%${query.toLowerCase()}%`;

    let sql = `SELECT * FROM entities WHERE (title_norm LIKE ? OR search_text LIKE ?)`;
    const params: unknown[] = [searchPattern, searchPattern];

    if (options?.entityType) {
      sql += ` AND entity_type = ?`;
      params.push(options.entityType);
    }

    sql += ` AND status = 'active' ORDER BY updated_at DESC`;

    if (options?.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }

    const rows = await dbAll<Record<string, unknown>>(this.db, sql, params);
    return rows.map(row => this.rowToEntity(row));
  }

  /**
   * Get tasks by status
   */
  async getTasksByStatus(status: string): Promise<Entity[]> {
    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM entities
       WHERE entity_type = 'task'
       AND json_extract(current_json, '$.status') = ?
       AND status = 'active'
       ORDER BY updated_at DESC`,
      [status]
    );

    return rows.map(row => this.rowToEntity(row));
  }

  /**
   * Get blocked tasks with their blockers
   */
  async getBlockedTasksWithBlockers(): Promise<Array<{
    task: Entity;
    blockers: Array<{ entityId: string; entityType: string; title: string }>;
  }>> {
    const tasks = await this.getTasksByStatus('blocked');

    const results: Array<{
      task: Entity;
      blockers: Array<{ entityId: string; entityType: string; title: string }>;
    }> = [];

    for (const task of tasks) {
      const blockerEdges = await dbAll<Record<string, unknown>>(
        this.db,
        `SELECT e.dst_id, ent.entity_type, ent.title
         FROM edges e
         JOIN entities ent ON ent.entity_id = e.dst_id
         WHERE e.src_id = ? AND e.rel_type = 'blocked_by'`,
        [task.entityId]
      );

      results.push({
        task,
        blockers: blockerEdges.map(row => ({
          entityId: row.dst_id as string,
          entityType: row.entity_type as string,
          title: row.title as string
        }))
      });
    }

    return results;
  }

  /**
   * Add alias for entity
   */
  async addAlias(
    entityType: EntityType,
    canonicalKey: string,
    entityId: string
  ): Promise<void> {
    await dbRun(
      this.db,
      `INSERT INTO entity_aliases (entity_type, canonical_key, entity_id, is_primary)
       VALUES (?, ?, ?, FALSE)
       ON CONFLICT (entity_type, canonical_key) DO NOTHING`,
      [entityType, canonicalKey, entityId]
    );
  }

  /**
   * Find entity by alias
   */
  async findByAlias(entityType: EntityType, canonicalKey: string): Promise<Entity | null> {
    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT e.* FROM entities e
       JOIN entity_aliases a ON e.entity_id = a.entity_id
       WHERE a.entity_type = ? AND a.canonical_key = ?`,
      [entityType, canonicalKey]
    );

    if (rows.length === 0) return null;
    return this.rowToEntity(rows[0]);
  }

  /**
   * Fact reconciliation primitive (Mem0-style UPDATE): mark an entity
   * superseded by a newer one and link them with a `supersedes` edge, so
   * graph-based retrieval (GraphPathService) stops traversing/surfacing the
   * old entity as if it were still current.
   *
   * Repeating the exact same supersession is an idempotent NOOP (reported via
   * `alreadySuperseded`). Superseding an already-superseded entity by a
   * *different* entity throws instead of silently doing nothing, so a genuine
   * conflict (A replaced by B, then someone claims A is replaced by C) cannot
   * be mistaken for success.
   */
  async supersede(
    oldEntityId: string,
    newEntityId: string,
    options: { actor: string; sourceEventIds?: string[] }
  ): Promise<{ old: Entity; new: Entity; alreadySuperseded: boolean }> {
    const oldEntity = await this.findById(oldEntityId);
    if (!oldEntity) throw new Error(`entity not found: ${oldEntityId}`);
    const newEntity = await this.findById(newEntityId);
    if (!newEntity) throw new Error(`entity not found: ${newEntityId}`);

    const edges = new EdgeRepo(this.db);

    if (oldEntity.status === 'superseded') {
      const existing = await edges.findByDst(oldEntityId, 'supersedes');
      const supersededBy = existing[0]?.srcId;
      if (supersededBy && supersededBy !== newEntityId) {
        throw new Error(
          `entity ${oldEntityId} is already superseded by ${supersededBy}, not ${newEntityId}`
        );
      }
      return { old: oldEntity, new: newEntity, alreadySuperseded: true };
    }

    // Link first, flip status second. These are separate statements, so if the
    // process dies between them the recoverable state is "edge written, entity
    // still active" (a retry completes it) rather than "entity superseded with
    // no link", which would make the conflict check above silently NOOP.
    await edges.upsert({
      srcType: 'entity',
      srcId: newEntityId,
      relType: 'supersedes',
      dstType: 'entity',
      dstId: oldEntityId,
      metaJson: { actor: options.actor }
    });

    const updated = await this.update(oldEntityId, { status: 'superseded' });
    if (!updated) throw new Error(`entity update failed: ${oldEntityId}`);

    await writeGovernanceAuditEntry(this.db, {
      operation: 'entity_supersede',
      actor: options.actor,
      targetType: 'entity',
      targetId: oldEntityId,
      beforeJson: sanitizeGovernanceAuditValue({ status: oldEntity.status }) as Record<string, unknown>,
      afterJson: sanitizeGovernanceAuditValue({ status: 'superseded', supersededBy: newEntityId }) as Record<string, unknown>,
      sourceEventIds: options.sourceEventIds
    });

    return { old: updated, new: newEntity, alreadySuperseded: false };
  }

  /**
   * Convert database row to Entity
   */
  private rowToEntity(row: Record<string, unknown>): Entity {
    return {
      entityId: row.entity_id as string,
      entityType: row.entity_type as EntityType,
      canonicalKey: row.canonical_key as string,
      title: row.title as string,
      stage: row.stage as EntityStage,
      status: row.status as EntityStatus,
      currentJson: typeof row.current_json === 'string'
        ? JSON.parse(row.current_json)
        : row.current_json as Record<string, unknown>,
      titleNorm: row.title_norm as string | undefined,
      searchText: row.search_text as string | undefined,
      createdAt: toDate(row.created_at),
      updatedAt: toDate(row.updated_at)
    };
  }
}
