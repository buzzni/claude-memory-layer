import { z } from 'zod';

import type { SQLiteDatabase } from '../sqlite-wrapper.js';
import {
  canonicalMemoryAssetId,
  isCanonicalMemoryAssetRegistration
} from './memory-asset-catalog-service.js';
import { MemoryAssetPermissionService } from './memory-asset-permission-service.js';
import { MemoryAssetRepository } from './memory-asset-repository.js';
import type { MemoryAssetPermissionSource } from './memory-asset-permissions.js';

export const CANONICAL_MEMORY_PERMISSION_MODE_ENV = 'CLAUDE_MEMORY_ASSET_PERMISSION_MODE';

export const CanonicalMemoryPermissionModeSchema = z.enum(['legacy', 'registered', 'strict']);
export type CanonicalMemoryPermissionMode = z.infer<typeof CanonicalMemoryPermissionModeSchema>;

const RequesterActorIdSchema = z.string().trim().min(1).max(240);

const CanonicalMemoryAccessInputSchema = z.object({
  projectHash: z.string().trim().min(1).max(240),
  canonicalType: z.enum(['lesson', 'core_memory_block']),
  canonicalId: z.string().trim().min(1).max(240),
  requesterActorId: z.string().trim().min(1).max(240).optional(),
  permission: z.enum(['read', 'write'])
});

export interface CanonicalMemoryAccessDecision {
  allowed: boolean;
  mode: CanonicalMemoryPermissionMode;
  registered: boolean;
  source: MemoryAssetPermissionSource | 'legacy' | 'unregistered';
}

export class CanonicalMemoryAccessDeniedError extends Error {
  readonly code = 'CANONICAL_MEMORY_ACCESS_DENIED';

  constructor() {
    super('permission denied for canonical memory access');
    this.name = 'CanonicalMemoryAccessDeniedError';
  }
}

export function resolveCanonicalMemoryPermissionMode(
  env: NodeJS.ProcessEnv = process.env
): CanonicalMemoryPermissionMode {
  const raw = env[CANONICAL_MEMORY_PERMISSION_MODE_ENV]?.trim().toLowerCase();
  if (!raw) return 'legacy';
  const parsed = CanonicalMemoryPermissionModeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${CANONICAL_MEMORY_PERMISSION_MODE_ENV} must be legacy, registered, or strict`);
  }
  return parsed.data;
}

export class CanonicalMemoryAccessService {
  private readonly repository: MemoryAssetRepository;
  private readonly permissionService: MemoryAssetPermissionService;
  readonly mode: CanonicalMemoryPermissionMode;

  constructor(
    db: SQLiteDatabase,
    options: { mode?: CanonicalMemoryPermissionMode; env?: NodeJS.ProcessEnv } = {}
  ) {
    this.repository = new MemoryAssetRepository(db);
    this.permissionService = new MemoryAssetPermissionService(db);
    this.mode = options.mode ?? resolveCanonicalMemoryPermissionMode(options.env);
  }

  requireRequester(requesterActorId: string | undefined): void {
    if (this.mode === 'legacy') return;
    if (!requesterActorId) {
      throw new Error(`requesterActorId is required when ${CANONICAL_MEMORY_PERMISSION_MODE_ENV}=${this.mode}`);
    }
    RequesterActorIdSchema.parse(requesterActorId);
  }

  requireUnregisteredWrite(requesterActorId: string | undefined): CanonicalMemoryAccessDecision {
    this.requireRequester(requesterActorId);
    if (this.mode === 'strict') throw new CanonicalMemoryAccessDeniedError();
    return {
      allowed: true,
      mode: this.mode,
      registered: false,
      source: this.mode === 'legacy' ? 'legacy' : 'unregistered'
    };
  }

  check(input: unknown): CanonicalMemoryAccessDecision {
    const parsed = CanonicalMemoryAccessInputSchema.parse(input);
    const assetId = canonicalMemoryAssetId(parsed.canonicalType, parsed.canonicalId);
    const asset = this.repository.get(assetId, parsed.projectHash);
    const registered = Boolean(
      asset && isCanonicalMemoryAssetRegistration(asset, parsed.canonicalType, parsed.canonicalId)
    );

    if (this.mode === 'legacy') {
      return { allowed: true, mode: this.mode, registered, source: 'legacy' };
    }
    this.requireRequester(parsed.requesterActorId);

    if (!asset) {
      const allowed = this.mode === 'registered';
      return {
        allowed,
        mode: this.mode,
        registered: false,
        source: allowed ? 'unregistered' : 'none'
      };
    }

    // A deterministic id occupied by a non-canonical asset is a conflict, not
    // an unregistered fallback. Otherwise a caller could bypass protection by
    // creating an unrelated asset with the canonical id.
    if (!registered) {
      return { allowed: false, mode: this.mode, registered: false, source: 'none' };
    }

    const result = this.permissionService.check({
      projectHash: parsed.projectHash,
      assetId,
      requesterActorId: parsed.requesterActorId!,
      permission: parsed.permission
    });
    return {
      allowed: result.decision.allowed,
      mode: this.mode,
      registered: true,
      source: result.decision.source
    };
  }

  require(input: unknown): CanonicalMemoryAccessDecision {
    const decision = this.check(input);
    if (!decision.allowed) throw new CanonicalMemoryAccessDeniedError();
    return decision;
  }
}
