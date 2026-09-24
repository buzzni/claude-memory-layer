import { z } from 'zod';

const NonEmptyStringSchema = z.string().trim().min(1).max(240);
const OptionalProjectHashSchema = z.string().trim().min(1).max(240).optional();
const StringArraySchema = z.array(z.string().trim().min(1).max(240)).max(100).default([]);

export const MemoryAssetTypeSchema = z.enum(['memory', 'lesson', 'skill', 'wiki', 'code_graph']);
export type MemoryAssetType = z.infer<typeof MemoryAssetTypeSchema>;

export const MemoryAssetStatusSchema = z.enum(['candidate', 'active', 'deprecated', 'archived']);
export type MemoryAssetStatus = z.infer<typeof MemoryAssetStatusSchema>;

export const MemoryAssetVisibilitySchema = z.enum(['private', 'project', 'shared']);
export type MemoryAssetVisibility = z.infer<typeof MemoryAssetVisibilitySchema>;

export const MemoryAssetPermissionSchema = z.enum(['read', 'write', 'bind', 'grant']);
export type MemoryAssetPermission = z.infer<typeof MemoryAssetPermissionSchema>;

export const MemoryAssetInjectionModeSchema = z.enum(['direct', 'summary', 'tool', 'reference']);
export type MemoryAssetInjectionMode = z.infer<typeof MemoryAssetInjectionModeSchema>;

export const MemoryAssetSchema = z.object({
  assetId: NonEmptyStringSchema,
  projectHash: OptionalProjectHashSchema,
  assetType: MemoryAssetTypeSchema,
  title: NonEmptyStringSchema,
  ownerActorId: NonEmptyStringSchema,
  version: z.number().int().positive(),
  status: MemoryAssetStatusSchema,
  visibility: MemoryAssetVisibilitySchema,
  sourceRefs: StringArraySchema,
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.date(),
  updatedAt: z.date()
});
export type MemoryAsset = z.infer<typeof MemoryAssetSchema>;

export const CreateMemoryAssetInputSchema = z.object({
  assetId: NonEmptyStringSchema.optional(),
  projectHash: OptionalProjectHashSchema,
  assetType: MemoryAssetTypeSchema,
  title: NonEmptyStringSchema,
  ownerActorId: NonEmptyStringSchema,
  status: MemoryAssetStatusSchema.default('active'),
  visibility: MemoryAssetVisibilitySchema.default('private'),
  sourceRefs: StringArraySchema,
  metadata: z.record(z.unknown()).optional()
});
export type CreateMemoryAssetInput = z.input<typeof CreateMemoryAssetInputSchema>;

export const UpdateMemoryAssetInputSchema = z.object({
  assetId: NonEmptyStringSchema,
  projectHash: OptionalProjectHashSchema,
  expectedVersion: z.number().int().positive().optional(),
  title: NonEmptyStringSchema.optional(),
  status: MemoryAssetStatusSchema.optional(),
  visibility: MemoryAssetVisibilitySchema.optional(),
  sourceRefs: StringArraySchema.optional(),
  metadata: z.record(z.unknown()).optional()
}).refine(
  (input) => input.title !== undefined
    || input.status !== undefined
    || input.visibility !== undefined
    || input.sourceRefs !== undefined
    || input.metadata !== undefined,
  'at least one asset field must be supplied'
);
export type UpdateMemoryAssetInput = z.input<typeof UpdateMemoryAssetInputSchema>;

export const MemoryAssetBindingSchema = z.object({
  projectHash: OptionalProjectHashSchema,
  assetId: NonEmptyStringSchema,
  actorId: NonEmptyStringSchema,
  injectionMode: MemoryAssetInjectionModeSchema,
  priority: z.number().int().min(-1000).max(1000),
  enabled: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date()
});
export type MemoryAssetBinding = z.infer<typeof MemoryAssetBindingSchema>;

export const SetMemoryAssetBindingInputSchema = z.object({
  projectHash: OptionalProjectHashSchema,
  assetId: NonEmptyStringSchema,
  actorId: NonEmptyStringSchema,
  injectionMode: MemoryAssetInjectionModeSchema.default('reference'),
  priority: z.number().int().min(-1000).max(1000).default(0),
  enabled: z.boolean().default(true)
});
export type SetMemoryAssetBindingInput = z.input<typeof SetMemoryAssetBindingInputSchema>;

export const MemoryAssetGrantSchema = z.object({
  projectHash: OptionalProjectHashSchema,
  assetId: NonEmptyStringSchema,
  actorId: NonEmptyStringSchema,
  permissions: z.array(MemoryAssetPermissionSchema).max(4),
  createdBy: NonEmptyStringSchema,
  createdAt: z.date(),
  updatedAt: z.date()
});
export type MemoryAssetGrant = z.infer<typeof MemoryAssetGrantSchema>;

export const SetMemoryAssetGrantInputSchema = z.object({
  projectHash: OptionalProjectHashSchema,
  assetId: NonEmptyStringSchema,
  actorId: NonEmptyStringSchema,
  permissions: z.array(MemoryAssetPermissionSchema).max(4),
  createdBy: NonEmptyStringSchema
});
export type SetMemoryAssetGrantInput = z.input<typeof SetMemoryAssetGrantInputSchema>;

export type MemoryAssetPermissionSource = 'owner' | 'visibility' | 'binding' | 'grant' | 'none';

export interface MemoryAssetPermissionDecision {
  allowed: boolean;
  permission: MemoryAssetPermission;
  source: MemoryAssetPermissionSource;
  reason: string;
}

export interface CheckMemoryAssetPermissionInput {
  asset: MemoryAsset;
  actorId: string;
  permission: MemoryAssetPermission;
  binding?: MemoryAssetBinding | null;
  grant?: MemoryAssetGrant | null;
}

/**
 * Small, deterministic permission core. Precedence deliberately follows
 * owner -> read visibility -> active binding -> explicit grant -> deny.
 * Bindings make an asset readable/injectable; they never confer mutation or
 * delegation rights.
 */
export function checkMemoryAssetPermission(input: CheckMemoryAssetPermissionInput): MemoryAssetPermissionDecision {
  const actorId = NonEmptyStringSchema.parse(input.actorId);
  const permission = MemoryAssetPermissionSchema.parse(input.permission);

  if (input.asset.ownerActorId === actorId) {
    return { allowed: true, permission, source: 'owner', reason: 'asset owner' };
  }

  if (permission === 'read' && (input.asset.visibility === 'project' || input.asset.visibility === 'shared')) {
    return { allowed: true, permission, source: 'visibility', reason: `${input.asset.visibility} visibility` };
  }

  if (
    permission === 'read'
    && input.binding?.actorId === actorId
    && input.binding.assetId === input.asset.assetId
    && input.binding.enabled
  ) {
    return { allowed: true, permission, source: 'binding', reason: 'active actor binding' };
  }

  if (
    input.grant?.actorId === actorId
    && input.grant.assetId === input.asset.assetId
    && input.grant.permissions.includes(permission)
  ) {
    return { allowed: true, permission, source: 'grant', reason: 'explicit actor grant' };
  }

  // Keep missing and inaccessible assets indistinguishable at the public
  // permission-check boundary. Allowed decisions still explain the winning
  // rule, while a denial never confirms that a private asset exists.
  return { allowed: false, permission, source: 'none', reason: 'permission denied' };
}

export class MemoryAssetPermissionDeniedError extends Error {
  readonly code = 'MEMORY_ASSET_PERMISSION_DENIED';

  constructor(
    readonly assetId: string,
    readonly actorId: string,
    readonly permission: MemoryAssetPermission
  ) {
    super(`Permission denied: actor ${actorId} cannot ${permission} memory asset ${assetId}`);
    this.name = 'MemoryAssetPermissionDeniedError';
  }
}
