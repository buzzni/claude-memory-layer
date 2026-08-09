import { z } from 'zod';

import type { SQLiteDatabase } from '../sqlite-wrapper.js';
import type { CoreMemoryBlock, MemoryLesson } from '../types.js';
import {
  canonicalMemoryAssetId,
  isCanonicalMemoryAssetRegistration,
  type CanonicalMemoryAssetType
} from './memory-asset-catalog-service.js';
import { CoreMemoryBlockRepository } from './core-memory-block-repository.js';
import { LessonRepository } from './lesson-repository.js';
import { MemoryAssetPermissionService } from './memory-asset-permission-service.js';
import { MemoryAssetRepository } from './memory-asset-repository.js';
import type { MemoryAsset } from './memory-asset-permissions.js';

const InputSchema = z.object({
  projectHash: z.string().trim().min(1).max(240),
  actorId: z.string().trim().min(1).max(240),
  canonicalType: z.enum(['lesson', 'core_memory_block']),
  canonicalId: z.string().trim().min(1).max(240)
});

export interface SharedCanonicalMemoryAsset {
  asset: MemoryAsset;
  canonicalType: CanonicalMemoryAssetType;
  canonicalId: string;
  value: MemoryLesson | CoreMemoryBlock;
}

/**
 * Validates a source project's shared canonical asset without applying the
 * migration-oriented legacy/registered fallback. Cross-project reads are
 * always strict: the registry must be valid, active, and explicitly shared.
 */
export class SharedCanonicalMemoryAssetReadService {
  private readonly assets: MemoryAssetRepository;
  private readonly permissions: MemoryAssetPermissionService;
  private readonly lessons: LessonRepository;
  private readonly blocks: CoreMemoryBlockRepository;

  constructor(db: SQLiteDatabase) {
    this.assets = new MemoryAssetRepository(db);
    this.permissions = new MemoryAssetPermissionService(db);
    this.lessons = new LessonRepository(db);
    this.blocks = new CoreMemoryBlockRepository(db);
  }

  async get(input: unknown): Promise<SharedCanonicalMemoryAsset | null> {
    const parsed = InputSchema.parse(input);
    const assetId = canonicalMemoryAssetId(parsed.canonicalType, parsed.canonicalId);
    const asset = this.assets.get(assetId, parsed.projectHash);
    if (!asset
      || asset.status !== 'active'
      || asset.visibility !== 'shared'
      || !isCanonicalMemoryAssetRegistration(asset, parsed.canonicalType, parsed.canonicalId)) {
      return null;
    }

    const decision = this.permissions.check({
      projectHash: parsed.projectHash,
      assetId,
      requesterActorId: parsed.actorId,
      permission: 'read'
    });
    if (!decision.decision.allowed) return null;

    const value = await this.loadCanonicalValue(parsed.projectHash, parsed.canonicalType, parsed.canonicalId);
    return value ? { asset, canonicalType: parsed.canonicalType, canonicalId: parsed.canonicalId, value } : null;
  }

  private async loadCanonicalValue(
    projectHash: string,
    canonicalType: CanonicalMemoryAssetType,
    canonicalId: string
  ): Promise<MemoryLesson | CoreMemoryBlock | null> {
    if (canonicalType === 'lesson') {
      const lesson = this.lessons.get(canonicalId);
      return lesson?.projectHash === projectHash ? lesson : null;
    }
    return this.blocks.get({ projectHash, blockKey: canonicalId as 'project' | 'user' });
  }
}
