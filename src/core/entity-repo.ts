/**
 * Entity Repository - CRUD operations for Task/Condition/Artifact entities
 * AXIOMMIND Principle 5: Task is Entity
 */

import { Database } from 'duckdb';
import { randomUUID } from 'crypto';
import type {
  Entity,
  EntityType,
  EntityStage,
  EntityStatus,
  EntityAlias,
  TaskCurrentJson
} from './types.js';
import { makeEntityCanonicalKey } from './canonical-key.js';

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

    await this.db.run(
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
    await this.db.run(
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
    const rows = await this.db.all<Array<Record<string, unknown>>>(
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
    const rows = await this.db.all<Array<Record<string, unknown>>>(
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

    await this.db.run(
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

    const rows = await this.db.all<Array<Record<string, unknown>>>(query, params);
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

    const rows = await this.db.all<Array<Record<string, unknown>>>(sql, params);
    return rows.map(row => this.rowToEntity(row));
  }

  /**
   * Get tasks by status
   */
  async getTasksByStatus(status: string): Promise<Entity[]> {
    const rows = await this.db.all<Array<Record<string, unknown>>>(
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
      const blockerEdges = await this.db.all<Array<Record<string, unknown>>>(
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
    await this.db.run(
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
    const rows = await this.db.all<Array<Record<string, unknown>>>(
      `SELECT e.* FROM entities e
       JOIN entity_aliases a ON e.entity_id = a.entity_id
       WHERE a.entity_type = ? AND a.canonical_key = ?`,
      [entityType, canonicalKey]
    );

    if (rows.length === 0) return null;
    return this.rowToEntity(rows[0]);
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
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string)
    };
  }
}
