import { randomUUID } from 'node:crypto';

import {
  sqliteAll,
  sqliteGet,
  sqliteRun,
  toDateFromSQLite,
  type SQLiteDatabase
} from '../sqlite-wrapper.js';
import {
  CreateMemoryAssetInputSchema,
  MemoryAssetBindingSchema,
  MemoryAssetGrantSchema,
  MemoryAssetPermissionSchema,
  MemoryAssetSchema,
  SetMemoryAssetBindingInputSchema,
  SetMemoryAssetGrantInputSchema,
  UpdateMemoryAssetInputSchema,
  type MemoryAsset,
  type MemoryAssetBinding,
  type MemoryAssetGrant,
  type MemoryAssetPermission,
  type MemoryAssetStatus,
  type MemoryAssetType,
  type MemoryAssetVisibility
} from './memory-asset-permissions.js';

interface MemoryAssetRow {
  asset_id: string;
  project_hash: string;
  asset_type: MemoryAssetType;
  title: string;
  owner_actor_id: string;
  version: number;
  status: MemoryAssetStatus;
  visibility: MemoryAssetVisibility;
  source_refs_json: string;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

interface MemoryAssetBindingRow {
  project_hash: string;
  asset_id: string;
  actor_id: string;
  injection_mode: MemoryAssetBinding['injectionMode'];
  priority: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface MemoryAssetGrantRow {
  project_hash: string;
  asset_id: string;
  actor_id: string;
  permissions_json: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function projectHashToStorage(projectHash: string | undefined): string {
  return projectHash ?? '';
}

function projectHashFromStorage(projectHash: string): string | undefined {
  return projectHash.length > 0 ? projectHash : undefined;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseRecord(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function rowToAsset(row: MemoryAssetRow): MemoryAsset {
  return MemoryAssetSchema.parse({
    assetId: row.asset_id,
    projectHash: projectHashFromStorage(row.project_hash),
    assetType: row.asset_type,
    title: row.title,
    ownerActorId: row.owner_actor_id,
    version: Number(row.version),
    status: row.status,
    visibility: row.visibility,
    sourceRefs: parseStringArray(row.source_refs_json),
    metadata: parseRecord(row.metadata_json),
    createdAt: toDateFromSQLite(row.created_at),
    updatedAt: toDateFromSQLite(row.updated_at)
  });
}

function rowToBinding(row: MemoryAssetBindingRow): MemoryAssetBinding {
  return MemoryAssetBindingSchema.parse({
    projectHash: projectHashFromStorage(row.project_hash),
    assetId: row.asset_id,
    actorId: row.actor_id,
    injectionMode: row.injection_mode,
    priority: Number(row.priority),
    enabled: Boolean(row.enabled),
    createdAt: toDateFromSQLite(row.created_at),
    updatedAt: toDateFromSQLite(row.updated_at)
  });
}

function rowToGrant(row: MemoryAssetGrantRow): MemoryAssetGrant {
  const permissions = parseStringArray(row.permissions_json)
    .map((permission) => MemoryAssetPermissionSchema.safeParse(permission))
    .filter((result) => result.success)
    .map((result) => result.data);
  return MemoryAssetGrantSchema.parse({
    projectHash: projectHashFromStorage(row.project_hash),
    assetId: row.asset_id,
    actorId: row.actor_id,
    permissions,
    createdBy: row.created_by,
    createdAt: toDateFromSQLite(row.created_at),
    updatedAt: toDateFromSQLite(row.updated_at)
  });
}

export interface ListMemoryAssetsInput {
  projectHash?: string;
  assetType?: MemoryAssetType;
  status?: MemoryAssetStatus;
  limit?: number;
  offset?: number;
}

export class MemoryAssetRepository {
  constructor(private readonly db: SQLiteDatabase) {}

  create(input: unknown): MemoryAsset {
    const parsed = CreateMemoryAssetInputSchema.parse(input);
    const assetId = parsed.assetId ?? randomUUID();
    const now = new Date().toISOString();
    sqliteRun(
      this.db,
      `INSERT INTO memory_assets (
        asset_id, project_hash, asset_type, title, owner_actor_id, version,
        status, visibility, source_refs_json, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      [
        assetId,
        projectHashToStorage(parsed.projectHash),
        parsed.assetType,
        parsed.title,
        parsed.ownerActorId,
        parsed.status,
        parsed.visibility,
        JSON.stringify(parsed.sourceRefs),
        parsed.metadata ? JSON.stringify(parsed.metadata) : null,
        now,
        now
      ]
    );
    return this.require(assetId, parsed.projectHash);
  }

  get(assetId: string, projectHash?: string): MemoryAsset | null {
    const row = sqliteGet<MemoryAssetRow>(
      this.db,
      `SELECT * FROM memory_assets WHERE asset_id = ? AND project_hash = ?`,
      [assetId.trim(), projectHashToStorage(projectHash)]
    );
    return row ? rowToAsset(row) : null;
  }

  require(assetId: string, projectHash?: string): MemoryAsset {
    const asset = this.get(assetId, projectHash);
    if (!asset) throw new Error(`Memory asset not found: ${assetId}`);
    return asset;
  }

  list(input: ListMemoryAssetsInput): MemoryAsset[] {
    const clauses = ['project_hash = ?'];
    const params: unknown[] = [projectHashToStorage(input.projectHash)];
    if (input.assetType) {
      clauses.push('asset_type = ?');
      params.push(input.assetType);
    }
    if (input.status) {
      clauses.push('status = ?');
      params.push(input.status);
    }
    params.push(
      Math.min(500, Math.max(1, input.limit ?? 100)),
      Math.max(0, Math.floor(input.offset ?? 0))
    );
    return sqliteAll<MemoryAssetRow>(
      this.db,
      `SELECT * FROM memory_assets
       WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at DESC, asset_id ASC
       LIMIT ? OFFSET ?`,
      params
    ).map(rowToAsset);
  }

  update(input: unknown): MemoryAsset {
    const parsed = UpdateMemoryAssetInputSchema.parse(input);
    const before = this.require(parsed.assetId, parsed.projectHash);
    const assignments: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown) => {
      assignments.push(`${column} = ?`);
      params.push(value);
    };
    if (parsed.title !== undefined) set('title', parsed.title);
    if (parsed.status !== undefined) set('status', parsed.status);
    if (parsed.visibility !== undefined) set('visibility', parsed.visibility);
    if (parsed.sourceRefs !== undefined) set('source_refs_json', JSON.stringify(parsed.sourceRefs));
    if (parsed.metadata !== undefined) set('metadata_json', JSON.stringify(parsed.metadata));
    assignments.push('version = version + 1', 'updated_at = ?');
    params.push(new Date().toISOString(), parsed.assetId, projectHashToStorage(parsed.projectHash));

    let where = 'asset_id = ? AND project_hash = ?';
    if (parsed.expectedVersion !== undefined) {
      where += ' AND version = ?';
      params.push(parsed.expectedVersion);
    }
    const result = sqliteRun(this.db, `UPDATE memory_assets SET ${assignments.join(', ')} WHERE ${where}`, params);
    if (result.changes !== 1) {
      throw new Error(`Memory asset version conflict: expected ${parsed.expectedVersion}, current ${before.version}`);
    }
    return this.require(parsed.assetId, parsed.projectHash);
  }

  getBinding(assetId: string, actorId: string, projectHash?: string): MemoryAssetBinding | null {
    const row = sqliteGet<MemoryAssetBindingRow>(
      this.db,
      `SELECT * FROM memory_asset_bindings WHERE asset_id = ? AND actor_id = ? AND project_hash = ?`,
      [assetId.trim(), actorId.trim(), projectHashToStorage(projectHash)]
    );
    return row ? rowToBinding(row) : null;
  }

  setBinding(input: unknown): MemoryAssetBinding {
    const parsed = SetMemoryAssetBindingInputSchema.parse(input);
    const now = new Date().toISOString();
    sqliteRun(
      this.db,
      `INSERT INTO memory_asset_bindings (
        project_hash, asset_id, actor_id, injection_mode, priority, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_hash, asset_id, actor_id) DO UPDATE SET
        injection_mode = excluded.injection_mode,
        priority = excluded.priority,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at`,
      [
        projectHashToStorage(parsed.projectHash),
        parsed.assetId,
        parsed.actorId,
        parsed.injectionMode,
        parsed.priority,
        parsed.enabled ? 1 : 0,
        now,
        now
      ]
    );
    const binding = this.getBinding(parsed.assetId, parsed.actorId, parsed.projectHash);
    if (!binding) throw new Error('Memory asset binding write failed');
    return binding;
  }

  getGrant(assetId: string, actorId: string, projectHash?: string): MemoryAssetGrant | null {
    const row = sqliteGet<MemoryAssetGrantRow>(
      this.db,
      `SELECT * FROM memory_asset_grants WHERE asset_id = ? AND actor_id = ? AND project_hash = ?`,
      [assetId.trim(), actorId.trim(), projectHashToStorage(projectHash)]
    );
    return row ? rowToGrant(row) : null;
  }

  setGrant(input: unknown): MemoryAssetGrant {
    const parsed = SetMemoryAssetGrantInputSchema.parse(input);
    const permissions = Array.from(new Set<MemoryAssetPermission>(parsed.permissions)).sort();
    const now = new Date().toISOString();
    sqliteRun(
      this.db,
      `INSERT INTO memory_asset_grants (
        project_hash, asset_id, actor_id, permissions_json, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_hash, asset_id, actor_id) DO UPDATE SET
        permissions_json = excluded.permissions_json,
        created_by = excluded.created_by,
        updated_at = excluded.updated_at`,
      [
        projectHashToStorage(parsed.projectHash),
        parsed.assetId,
        parsed.actorId,
        JSON.stringify(permissions),
        parsed.createdBy,
        now,
        now
      ]
    );
    const grant = this.getGrant(parsed.assetId, parsed.actorId, parsed.projectHash);
    if (!grant) throw new Error('Memory asset grant write failed');
    return grant;
  }
}
