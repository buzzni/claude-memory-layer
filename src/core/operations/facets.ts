import { z } from 'zod';

export const FacetTargetTypeSchema = z.enum([
  'event',
  'entity',
  'edge',
  'consolidated_memory',
  'lesson',
  'action'
]);
export type FacetTargetType = z.infer<typeof FacetTargetTypeSchema>;

export const BUILT_IN_FACET_DIMENSIONS = [
  'kind',
  'workflow',
  'artifact',
  'source',
  'privacy',
  'quality',
  'retention',
  'project'
] as const;

const customDimensionPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const TrimmedStringSchema = z.preprocess(
  (value) => typeof value === 'string' ? value.trim() : value,
  z.string().min(1)
);

export const FacetDimensionSchema = z.preprocess(
  (value) => typeof value === 'string' ? value.trim() : value,
  z.string()
    .min(1)
    .max(64)
    .refine((value) => (BUILT_IN_FACET_DIMENSIONS as readonly string[]).indexOf(value) !== -1 || customDimensionPattern.test(value), {
      message: 'Facet dimension must be built-in or lowercase kebab-case'
    })
);
export type FacetDimension = z.infer<typeof FacetDimensionSchema>;

export const FacetSourceSchema = z.enum(['manual', 'imported', 'derived', 'llm', 'system']).default('manual');
export type FacetSource = z.infer<typeof FacetSourceSchema>;

const EvidenceEventIdsSchema = z.preprocess(
  (value) => Array.isArray(value)
    ? value.map((item) => typeof item === 'string' ? item.trim() : item).filter(Boolean)
    : value,
  z.array(z.string().min(1)).default([])
);

const OptionalTrimmedStringSchema = z.preprocess(
  (value) => typeof value === 'string' ? value.trim() : value,
  z.string().min(1).optional()
);

export const MemoryFacetAssignmentInputSchema = z.object({
  targetType: FacetTargetTypeSchema,
  targetId: TrimmedStringSchema,
  dimension: FacetDimensionSchema,
  value: TrimmedStringSchema,
  confidence: z.number().min(0).max(1).default(1),
  source: FacetSourceSchema,
  evidenceEventIds: EvidenceEventIdsSchema,
  projectHash: OptionalTrimmedStringSchema,
  actor: OptionalTrimmedStringSchema
});
export type FacetAssignmentInput = z.infer<typeof MemoryFacetAssignmentInputSchema>;

export const MemoryFacetAssignmentSchema = MemoryFacetAssignmentInputSchema.extend({
  id: z.string().min(1),
  createdAt: z.date(),
  updatedAt: z.date()
});
export type MemoryFacetAssignment = z.infer<typeof MemoryFacetAssignmentSchema>;

export const FacetRemoveInputSchema = z.object({
  targetType: FacetTargetTypeSchema,
  targetId: TrimmedStringSchema,
  dimension: FacetDimensionSchema,
  value: TrimmedStringSchema,
  source: FacetSourceSchema,
  projectHash: OptionalTrimmedStringSchema,
  actor: OptionalTrimmedStringSchema
});
export type FacetRemoveInput = z.infer<typeof FacetRemoveInputSchema>;

export const FacetQuerySchema = z.object({
  targetType: FacetTargetTypeSchema.optional(),
  targetId: OptionalTrimmedStringSchema,
  dimension: FacetDimensionSchema.optional(),
  value: OptionalTrimmedStringSchema,
  source: FacetSourceSchema.optional(),
  projectHash: OptionalTrimmedStringSchema,
  limit: z.number().int().positive().max(500).default(100)
});
export type FacetQuery = z.infer<typeof FacetQuerySchema>;

export function parseFacetAssignmentInput(input: unknown): FacetAssignmentInput {
  return MemoryFacetAssignmentInputSchema.parse(input);
}

export function parseFacetRemoveInput(input: unknown): FacetRemoveInput {
  return FacetRemoveInputSchema.parse(input);
}

export function parseFacetQuery(input: unknown): FacetQuery {
  return FacetQuerySchema.parse(input ?? {});
}
