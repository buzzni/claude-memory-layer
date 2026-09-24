import { z } from 'zod';

import { sqliteTransaction, type SQLiteDatabase } from '../sqlite-wrapper.js';
import { writeGovernanceAuditEntrySync } from './governance-audit.js';
import { MemoryAssetRepository, type ListMemoryAssetsInput } from './memory-asset-repository.js';
import {
  CreateMemoryAssetInputSchema,
  MemoryAssetPermissionDeniedError,
  MemoryAssetPermissionSchema,
  SetMemoryAssetBindingInputSchema,
  SetMemoryAssetGrantInputSchema,
  UpdateMemoryAssetInputSchema,
  checkMemoryAssetPermission,
  type MemoryAsset,
  type MemoryAssetBinding,
  type MemoryAssetGrant,
  type MemoryAssetPermission,
  type MemoryAssetPermissionDecision
} from './memory-asset-permissions.js';

const ActorIdSchema = z.string().trim().min(1).max(240);

export interface MemoryAssetAccessInput {
  projectHash?: string;
  assetId: string;
  requesterActorId: string;
  permission: MemoryAssetPermission;
}

export interface MemoryAssetAccessResult {
  asset?: MemoryAsset;
  decision: MemoryAssetPermissionDecision;
}

export interface CreateAuthorizedMemoryAssetInput {
  projectHash?: string;
  requesterActorId: string;
  assetId?: string;
  assetType: MemoryAsset['assetType'];
  title: string;
  status?: MemoryAsset['status'];
  visibility?: MemoryAsset['visibility'];
  sourceRefs?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdateAuthorizedMemoryAssetInput {
  projectHash?: string;
  requesterActorId: string;
  assetId: string;
  expectedVersion?: number;
  title?: string;
  status?: MemoryAsset['status'];
  visibility?: MemoryAsset['visibility'];
  sourceRefs?: string[];
  metadata?: Record<string, unknown>;
}

export interface BindAuthorizedMemoryAssetInput {
  projectHash?: string;
  requesterActorId: string;
  assetId: string;
  actorId: string;
  injectionMode?: MemoryAssetBinding['injectionMode'];
  priority?: number;
  enabled?: boolean;
}

export interface GrantAuthorizedMemoryAssetInput {
  projectHash?: string;
  requesterActorId: string;
  assetId: string;
  actorId: string;
  permissions: MemoryAssetPermission[];
}

function snapshot(value: MemoryAsset | MemoryAssetBinding | MemoryAssetGrant | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  return { ...value };
}

export class MemoryAssetPermissionService {
  private readonly repository: MemoryAssetRepository;

  constructor(private readonly db: SQLiteDatabase) {
    this.repository = new MemoryAssetRepository(db);
  }

  async create(input: CreateAuthorizedMemoryAssetInput): Promise<MemoryAsset> {
    const requesterActorId = ActorIdSchema.parse(input.requesterActorId);
    const parsed = CreateMemoryAssetInputSchema.parse({
      ...input,
      ownerActorId: requesterActorId,
      sourceRefs: input.sourceRefs ?? []
    });
    return sqliteTransaction(this.db, () => {
      const asset = this.repository.create(parsed);
      writeGovernanceAuditEntrySync(this.db, {
        operation: 'memory_asset_create',
        actor: requesterActorId,
        projectHash: asset.projectHash,
        targetType: 'memory_asset',
        targetId: asset.assetId,
        afterJson: snapshot(asset)
      });
      return asset;
    });
  }

  async list(input: ListMemoryAssetsInput & { requesterActorId: string }): Promise<MemoryAsset[]> {
    const requesterActorId = ActorIdSchema.parse(input.requesterActorId);
    const requestedLimit = Math.min(500, Math.max(1, input.limit ?? 100));
    const pageSize = Math.max(100, requestedLimit);
    const readable: MemoryAsset[] = [];
    let offset = 0;

    // Filtering after a limited query can omit readable assets when newer
    // private assets occupy the first page. Scan deterministic pages until the
    // requested number of authorized results is found or the project is exhausted.
    while (readable.length < requestedLimit) {
      const assets = this.repository.list({
        projectHash: input.projectHash,
        assetType: input.assetType,
        status: input.status,
        limit: pageSize,
        offset
      });
      for (const asset of assets) {
        if (this.evaluate(asset, requesterActorId, 'read').allowed) {
          readable.push(asset);
          if (readable.length === requestedLimit) return readable;
        }
      }
      if (assets.length < pageSize) break;
      offset += assets.length;
    }
    return readable;
  }

  async get(input: Omit<MemoryAssetAccessInput, 'permission'>): Promise<MemoryAsset | null> {
    const result = this.check({ ...input, permission: 'read' });
    return result.decision.allowed ? result.asset ?? null : null;
  }

  check(input: MemoryAssetAccessInput): MemoryAssetAccessResult {
    const requesterActorId = ActorIdSchema.parse(input.requesterActorId);
    const permission = MemoryAssetPermissionSchema.parse(input.permission);
    const asset = this.repository.get(input.assetId, input.projectHash);
    if (!asset) {
      return {
        decision: {
          allowed: false,
          permission,
          source: 'none',
          reason: 'permission denied'
        }
      };
    }
    const decision = this.evaluate(asset, requesterActorId, permission);
    return decision.allowed ? { asset, decision } : { decision };
  }

  async update(input: UpdateAuthorizedMemoryAssetInput): Promise<MemoryAsset> {
    const requesterActorId = ActorIdSchema.parse(input.requesterActorId);
    const parsed = UpdateMemoryAssetInputSchema.parse(input);
    return sqliteTransaction(this.db, () => {
      const before = this.requireAllowed(input.projectHash, input.assetId, requesterActorId, 'write');
      const after = this.repository.update(parsed);
      writeGovernanceAuditEntrySync(this.db, {
        operation: 'memory_asset_update',
        actor: requesterActorId,
        projectHash: after.projectHash,
        targetType: 'memory_asset',
        targetId: after.assetId,
        beforeJson: snapshot(before),
        afterJson: snapshot(after)
      });
      return after;
    });
  }

  async bind(input: BindAuthorizedMemoryAssetInput): Promise<MemoryAssetBinding> {
    const requesterActorId = ActorIdSchema.parse(input.requesterActorId);
    const parsed = SetMemoryAssetBindingInputSchema.parse(input);
    return sqliteTransaction(this.db, () => {
      const asset = this.requireAllowed(input.projectHash, input.assetId, requesterActorId, 'bind');
      const before = this.repository.getBinding(asset.assetId, parsed.actorId, asset.projectHash);
      const after = this.repository.setBinding(parsed);
      writeGovernanceAuditEntrySync(this.db, {
        operation: 'memory_asset_bind',
        actor: requesterActorId,
        projectHash: asset.projectHash,
        targetType: 'memory_asset_binding',
        targetId: `${asset.assetId}:${parsed.actorId}`,
        beforeJson: snapshot(before),
        afterJson: snapshot(after)
      });
      return after;
    });
  }

  async setGrant(input: GrantAuthorizedMemoryAssetInput): Promise<MemoryAssetGrant> {
    const requesterActorId = ActorIdSchema.parse(input.requesterActorId);
    const parsed = SetMemoryAssetGrantInputSchema.parse({ ...input, createdBy: requesterActorId });
    return sqliteTransaction(this.db, () => {
      const asset = this.requireAllowed(input.projectHash, input.assetId, requesterActorId, 'grant');
      const before = this.repository.getGrant(asset.assetId, parsed.actorId, asset.projectHash);
      const after = this.repository.setGrant(parsed);
      writeGovernanceAuditEntrySync(this.db, {
        operation: 'memory_asset_grant_set',
        actor: requesterActorId,
        projectHash: asset.projectHash,
        targetType: 'memory_asset_grant',
        targetId: `${asset.assetId}:${parsed.actorId}`,
        beforeJson: snapshot(before),
        afterJson: snapshot(after)
      });
      return after;
    });
  }

  private evaluate(
    asset: MemoryAsset,
    actorId: string,
    permission: MemoryAssetPermission
  ): MemoryAssetPermissionDecision {
    return checkMemoryAssetPermission({
      asset,
      actorId,
      permission,
      binding: this.repository.getBinding(asset.assetId, actorId, asset.projectHash),
      grant: this.repository.getGrant(asset.assetId, actorId, asset.projectHash)
    });
  }

  private requireAllowed(
    projectHash: string | undefined,
    assetId: string,
    actorId: string,
    permission: MemoryAssetPermission
  ): MemoryAsset {
    const result = this.check({ projectHash, assetId, requesterActorId: actorId, permission });
    if (!result.asset || !result.decision.allowed) {
      throw new MemoryAssetPermissionDeniedError(assetId, actorId, permission);
    }
    return result.asset;
  }
}
