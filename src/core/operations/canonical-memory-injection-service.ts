import { z } from 'zod';

import type { SQLiteDatabase } from '../sqlite-wrapper.js';
import {
  canonicalMemoryAssetId,
  isCanonicalMemoryAssetRegistration,
  type CanonicalMemoryAssetType
} from './memory-asset-catalog-service.js';
import {
  CANONICAL_MEMORY_PERMISSION_MODE_ENV,
  resolveCanonicalMemoryPermissionMode,
  type CanonicalMemoryPermissionMode
} from './canonical-memory-access-service.js';
import { MemoryAssetRepository } from './memory-asset-repository.js';
import type { MemoryAssetInjectionMode } from './memory-asset-permissions.js';

export const CANONICAL_MEMORY_ACTOR_ID_ENV = 'CLAUDE_MEMORY_ACTOR_ID';

const ActorIdSchema = z.string().trim().min(1).max(240);

export type CanonicalMemoryInjectionLane = 'session_start' | 'prompt' | 'context_pack';

export interface CanonicalMemoryInjectionCandidate<T> {
  canonicalType: CanonicalMemoryAssetType;
  canonicalId: string;
  value: T;
}

export interface CanonicalMemoryInjection<T> {
  value: T;
  injectionMode: Extract<MemoryAssetInjectionMode, 'direct' | 'summary' | 'reference'>;
  priority: number;
}

export interface CanonicalMemoryInjectionSelection<T> {
  mode: CanonicalMemoryPermissionMode;
  items: CanonicalMemoryInjection<T>[];
}

export function resolveCanonicalMemoryActorId(
  explicitActorId: unknown,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const raw = typeof explicitActorId === 'string' && explicitActorId.trim().length > 0
    ? explicitActorId
    : env[CANONICAL_MEMORY_ACTOR_ID_ENV];
  const parsed = ActorIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function injectionModeRank(mode: 'direct' | 'summary' | 'reference'): number {
  if (mode === 'direct') return 3;
  if (mode === 'summary') return 2;
  return 1;
}

export class CanonicalMemoryInjectionService {
  private readonly repository: MemoryAssetRepository;
  readonly mode: CanonicalMemoryPermissionMode;

  constructor(
    db: SQLiteDatabase,
    options: { mode?: CanonicalMemoryPermissionMode; env?: NodeJS.ProcessEnv } = {}
  ) {
    this.repository = new MemoryAssetRepository(db);
    this.mode = options.mode ?? resolveCanonicalMemoryPermissionMode(options.env);
  }

  select<T>(input: {
    projectHash: string;
    actorId?: string;
    lane: CanonicalMemoryInjectionLane;
    candidates: CanonicalMemoryInjectionCandidate<T>[];
  }): CanonicalMemoryInjectionSelection<T> {
    const actorId = resolveCanonicalMemoryActorId(input.actorId);
    if (this.mode !== 'legacy' && !actorId) {
      throw new Error(`actor identity is required when ${CANONICAL_MEMORY_PERMISSION_MODE_ENV}=${this.mode}`);
    }

    if (this.mode === 'legacy') {
      return {
        mode: this.mode,
        items: input.candidates.map((candidate) => ({
          value: candidate.value,
          injectionMode: 'direct',
          priority: 0
        }))
      };
    }

    const selected: Array<CanonicalMemoryInjection<T> & { canonicalId: string }> = [];
    for (const candidate of input.candidates) {
      const assetId = canonicalMemoryAssetId(candidate.canonicalType, candidate.canonicalId);
      const asset = this.repository.get(assetId, input.projectHash);
      const registered = Boolean(
        asset && isCanonicalMemoryAssetRegistration(asset, candidate.canonicalType, candidate.canonicalId)
      );

      if (!asset) {
        if (this.mode === 'registered') {
          selected.push({ value: candidate.value, injectionMode: 'direct', priority: 0, canonicalId: candidate.canonicalId });
        }
        continue;
      }
      if (!registered || asset.status !== 'active') continue;

      const binding = this.repository.getBinding(assetId, actorId!, input.projectHash);
      if (!binding?.enabled || binding.injectionMode === 'tool') continue;
      selected.push({
        value: candidate.value,
        injectionMode: binding.injectionMode,
        priority: binding.priority,
        canonicalId: candidate.canonicalId
      });
    }

    selected.sort((left, right) => (
      right.priority - left.priority
      || injectionModeRank(right.injectionMode) - injectionModeRank(left.injectionMode)
      || left.canonicalId.localeCompare(right.canonicalId)
    ));
    return {
      mode: this.mode,
      items: selected.map(({ canonicalId: _canonicalId, ...item }) => item)
    };
  }
}
