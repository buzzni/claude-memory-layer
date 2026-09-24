import { z } from 'zod';

import { sqliteAll, sqliteGet, type SQLiteDatabase } from '../sqlite-wrapper.js';
import { MemoryAssetPermissionService } from './memory-asset-permission-service.js';
import { MemoryAssetRepository } from './memory-asset-repository.js';
import type { MemoryAsset, MemoryAssetStatus, MemoryAssetType } from './memory-asset-permissions.js';

const CatalogSyncInputSchema = z.object({
  projectHash: z.string().trim().min(1).max(240),
  requesterActorId: z.string().trim().min(1).max(240),
  apply: z.boolean().default(false),
  limit: z.number().int().positive().max(500).default(100)
});

export type CanonicalMemoryAssetType = 'lesson' | 'core_memory_block';
export type MemoryAssetCatalogAction = 'create' | 'created' | 'exists' | 'conflict';

interface CanonicalAssetRow {
  canonical_type: CanonicalMemoryAssetType;
  canonical_id: string;
  title: string;
  canonical_status: MemoryAssetStatus;
}

interface CountRow {
  count: number;
}

export interface CanonicalMemoryAssetCandidate {
  canonicalType: CanonicalMemoryAssetType;
  canonicalId: string;
  assetId: string;
  assetType: MemoryAssetType;
  title: string;
  status: MemoryAssetStatus;
  sourceRefs: string[];
  metadata: Record<string, unknown>;
}

export interface MemoryAssetCatalogItem {
  candidate: CanonicalMemoryAssetCandidate;
  action: MemoryAssetCatalogAction;
  reason?: string;
}

export interface MemoryAssetCatalogSyncResult {
  dryRun: boolean;
  projectHash: string;
  totalCandidates: number;
  scanned: number;
  truncated: boolean;
  planned: number;
  created: number;
  existing: number;
  conflicts: number;
  items: MemoryAssetCatalogItem[];
}

export function canonicalMemoryAssetId(type: CanonicalMemoryAssetType, canonicalId: string): string {
  return `${type}:${canonicalId.trim()}`;
}

export function isCanonicalMemoryAssetRegistration(
  asset: MemoryAsset,
  canonicalType: CanonicalMemoryAssetType,
  canonicalId: string
): boolean {
  const assetId = canonicalMemoryAssetId(canonicalType, canonicalId);
  const expectedAssetType: MemoryAssetType = canonicalType === 'lesson' ? 'lesson' : 'memory';
  return asset.assetId === assetId
    && asset.assetType === expectedAssetType
    && asset.sourceRefs.includes(assetId);
}

function rowToCandidate(row: CanonicalAssetRow): CanonicalMemoryAssetCandidate {
  const assetId = canonicalMemoryAssetId(row.canonical_type, row.canonical_id);
  return {
    canonicalType: row.canonical_type,
    canonicalId: row.canonical_id,
    assetId,
    assetType: row.canonical_type === 'lesson' ? 'lesson' : 'memory',
    title: row.title,
    status: row.canonical_status,
    // The canonical object retains its own evidence references. Keeping only
    // this pointer avoids duplicating event ids (and potential legacy data)
    // into the permission registry.
    sourceRefs: [assetId],
    metadata: {
      canonicalType: row.canonical_type,
      canonicalId: row.canonical_id
    }
  };
}

function matchesCanonicalAsset(asset: MemoryAsset, candidate: CanonicalMemoryAssetCandidate): boolean {
  return isCanonicalMemoryAssetRegistration(asset, candidate.canonicalType, candidate.canonicalId);
}

function classifyCandidate(
  repository: MemoryAssetRepository,
  projectHash: string,
  candidate: CanonicalMemoryAssetCandidate
): MemoryAssetCatalogItem {
  const asset = repository.get(candidate.assetId, projectHash);
  if (!asset) return { candidate, action: 'create' };
  if (matchesCanonicalAsset(asset, candidate)) return { candidate, action: 'exists' };
  return {
    candidate,
    action: 'conflict',
    reason: 'deterministic asset id is already registered for another canonical source',
  };
}

export class MemoryAssetCatalogService {
  private readonly repository: MemoryAssetRepository;
  private readonly permissionService: MemoryAssetPermissionService;

  constructor(private readonly db: SQLiteDatabase) {
    this.repository = new MemoryAssetRepository(db);
    this.permissionService = new MemoryAssetPermissionService(db);
  }

  async sync(input: unknown): Promise<MemoryAssetCatalogSyncResult> {
    const parsed = CatalogSyncInputSchema.parse(input);
    const candidates = this.listCanonicalCandidates(parsed.projectHash, parsed.limit);
    const totalCandidates = this.countCanonicalCandidates(parsed.projectHash);
    const items = candidates.map((candidate) => classifyCandidate(this.repository, parsed.projectHash, candidate));
    const planned = items.filter((item) => item.action === 'create').length;

    if (parsed.apply) {
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (item.action !== 'create') continue;

        // Recheck immediately before the write so a concurrent/idempotent
        // registration becomes an exists/conflict result instead of an overwrite.
        const current = classifyCandidate(this.repository, parsed.projectHash, item.candidate);
        if (current.action !== 'create') {
          items[index] = current;
          continue;
        }

        try {
          await this.permissionService.create({
            projectHash: parsed.projectHash,
            requesterActorId: parsed.requesterActorId,
            assetId: item.candidate.assetId,
            assetType: item.candidate.assetType,
            title: item.candidate.title,
            status: item.candidate.status,
            visibility: 'private',
            sourceRefs: item.candidate.sourceRefs,
            metadata: item.candidate.metadata
          });
          items[index] = { ...item, action: 'created' };
        } catch (error) {
          // Another connection may have won after the preflight check. Treat
          // the now-visible row idempotently; propagate unrelated failures.
          const raced = classifyCandidate(this.repository, parsed.projectHash, item.candidate);
          if (raced.action === 'create') throw error;
          items[index] = raced;
        }
      }
    }

    return this.buildResult(parsed.apply, parsed.projectHash, totalCandidates, planned, items);
  }

  private countCanonicalCandidates(projectHash: string): number {
    const lessonCount = sqliteGet<CountRow>(
      this.db,
      `SELECT COUNT(*) AS count FROM memory_lessons WHERE project_hash = ?`,
      [projectHash]
    )?.count ?? 0;
    const blockCount = sqliteGet<CountRow>(
      this.db,
      `SELECT COUNT(*) AS count FROM core_memory_blocks WHERE project_hash = ?`,
      [projectHash]
    )?.count ?? 0;
    return Number(lessonCount) + Number(blockCount);
  }

  private listCanonicalCandidates(projectHash: string, limit: number): CanonicalMemoryAssetCandidate[] {
    const rows = sqliteAll<CanonicalAssetRow>(
      this.db,
      `SELECT canonical_type, canonical_id, title, canonical_status
       FROM (
         SELECT
           'lesson' AS canonical_type,
           lesson_id AS canonical_id,
           name AS title,
           'active' AS canonical_status
         FROM memory_lessons
         WHERE project_hash = ?
         UNION ALL
         SELECT
           'core_memory_block' AS canonical_type,
           block_key AS canonical_id,
           'Core memory: ' || block_key AS title,
           CASE WHEN LENGTH(TRIM(content)) = 0 THEN 'archived' ELSE 'active' END AS canonical_status
         FROM core_memory_blocks
         WHERE project_hash = ?
       )
       ORDER BY canonical_type ASC, canonical_id ASC
       LIMIT ?`,
      [projectHash, projectHash, limit]
    );
    return rows.map(rowToCandidate);
  }

  private buildResult(
    apply: boolean,
    projectHash: string,
    totalCandidates: number,
    planned: number,
    items: MemoryAssetCatalogItem[]
  ): MemoryAssetCatalogSyncResult {
    return {
      dryRun: !apply,
      projectHash,
      totalCandidates,
      scanned: items.length,
      truncated: totalCandidates > items.length,
      planned,
      created: items.filter((item) => item.action === 'created').length,
      existing: items.filter((item) => item.action === 'exists').length,
      conflicts: items.filter((item) => item.action === 'conflict').length,
      items
    };
  }
}
