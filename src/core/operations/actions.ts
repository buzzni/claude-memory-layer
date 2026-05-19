import { z } from 'zod';

const NonEmptyStringSchema = z.string().transform((value) => value.trim()).pipe(z.string().min(1));
const StringArraySchema = z.array(z.string().transform((value) => value.trim()).pipe(z.string().min(1))).default([]);
const DateInputSchema = z.union([z.date(), z.string().datetime()]).transform((value) => value instanceof Date ? value : new Date(value));

export const MemoryActionStatusSchema = z.enum(['pending', 'in_progress', 'blocked', 'done', 'cancelled']);
export type MemoryActionStatus = z.infer<typeof MemoryActionStatusSchema>;

export const MemoryActionEdgeRelTypeSchema = z.enum(['depends_on', 'blocks', 'duplicates', 'derived_from', 'references']);
export type MemoryActionEdgeRelType = z.infer<typeof MemoryActionEdgeRelTypeSchema>;

export const MemoryActionEdgeDstTypeSchema = z.enum(['action', 'entity', 'event', 'source_ref']);
export type MemoryActionEdgeDstType = z.infer<typeof MemoryActionEdgeDstTypeSchema>;

export const LeaseTargetTypeSchema = z.enum(['action', 'checkpoint', 'routine']);
export type LeaseTargetType = z.infer<typeof LeaseTargetTypeSchema>;

export interface MemoryAction {
  actionId: string;
  projectHash: string;
  title: string;
  status: MemoryActionStatus;
  priority: number;
  sourceEventIds: string[];
  relatedEntityIds: string[];
  currentCheckpointId?: string;
  leaseId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryActionEdge {
  edgeId: string;
  srcActionId: string;
  relType: MemoryActionEdgeRelType;
  dstType: MemoryActionEdgeDstType;
  dstId: string;
  confidence: number;
  createdAt: Date;
}

export interface MemoryLease {
  leaseId: string;
  targetType: LeaseTargetType;
  targetId: string;
  holder: string;
  expiresAt: Date;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  renewedAt?: Date;
  releasedAt?: Date;
}

export interface MemoryCheckpoint {
  checkpointId: string;
  projectHash: string;
  actionId?: string;
  sessionId?: string;
  title: string;
  summary: string;
  stateJson: Record<string, unknown>;
  sourceEventIds: string[];
  createdAt: Date;
  expiresAt?: Date;
}

export const UpsertActionInputSchema = z.object({
  actionId: z.string().uuid().optional(),
  projectHash: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  status: MemoryActionStatusSchema.default('pending'),
  priority: z.number().int().min(0).max(100).default(0),
  sourceEventIds: StringArraySchema,
  relatedEntityIds: StringArraySchema,
  currentCheckpointId: NonEmptyStringSchema.optional(),
  leaseId: NonEmptyStringSchema.optional(),
  actor: NonEmptyStringSchema.optional()
});
export type UpsertActionInput = z.infer<typeof UpsertActionInputSchema>;

export const UpdateActionInputSchema = z.object({
  actionId: z.string().uuid(),
  projectHash: NonEmptyStringSchema,
  title: NonEmptyStringSchema.optional(),
  status: MemoryActionStatusSchema.optional(),
  priority: z.number().int().min(0).max(100).optional(),
  sourceEventIds: StringArraySchema.optional(),
  relatedEntityIds: StringArraySchema.optional(),
  currentCheckpointId: NonEmptyStringSchema.nullish(),
  leaseId: NonEmptyStringSchema.nullish(),
  actor: NonEmptyStringSchema.optional()
});
export type UpdateActionInput = z.infer<typeof UpdateActionInputSchema>;

export const ListActionsInputSchema = z.object({
  projectHash: NonEmptyStringSchema,
  status: MemoryActionStatusSchema.optional(),
  includeTerminal: z.boolean().default(false),
  limit: z.number().int().positive().max(500).default(50)
});
export type ListActionsInput = z.infer<typeof ListActionsInputSchema>;

export const ActionEdgeInputSchema = z.object({
  srcActionId: z.string().uuid(),
  relType: MemoryActionEdgeRelTypeSchema,
  dstType: MemoryActionEdgeDstTypeSchema,
  dstId: NonEmptyStringSchema,
  confidence: z.number().min(0).max(1).default(1)
});
export type ActionEdgeInput = z.infer<typeof ActionEdgeInputSchema>;

export const AcquireLeaseInputSchema = z.object({
  targetType: LeaseTargetTypeSchema,
  targetId: NonEmptyStringSchema,
  holder: NonEmptyStringSchema,
  expiresAt: DateInputSchema,
  now: DateInputSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
  actor: NonEmptyStringSchema.optional(),
  projectHash: NonEmptyStringSchema.optional()
});
export type AcquireLeaseInput = z.infer<typeof AcquireLeaseInputSchema>;

export const RenewLeaseInputSchema = z.object({
  leaseId: z.string().uuid(),
  holder: NonEmptyStringSchema,
  expiresAt: DateInputSchema,
  now: DateInputSchema.optional(),
  actor: NonEmptyStringSchema.optional(),
  projectHash: NonEmptyStringSchema.optional()
});
export type RenewLeaseInput = z.infer<typeof RenewLeaseInputSchema>;

export const ReleaseLeaseInputSchema = z.object({
  leaseId: z.string().uuid(),
  holder: NonEmptyStringSchema,
  actor: NonEmptyStringSchema.optional(),
  projectHash: NonEmptyStringSchema.optional()
});
export type ReleaseLeaseInput = z.infer<typeof ReleaseLeaseInputSchema>;

export const CreateCheckpointInputSchema = z.object({
  checkpointId: z.string().uuid().optional(),
  projectHash: NonEmptyStringSchema,
  actionId: NonEmptyStringSchema.optional(),
  sessionId: NonEmptyStringSchema.optional(),
  title: NonEmptyStringSchema,
  summary: NonEmptyStringSchema,
  stateJson: z.record(z.unknown()).default({}),
  sourceEventIds: StringArraySchema,
  expiresAt: DateInputSchema.optional(),
  actor: NonEmptyStringSchema.optional()
});
export type CreateCheckpointInput = z.infer<typeof CreateCheckpointInputSchema>;

export const ListCheckpointsInputSchema = z.object({
  projectHash: NonEmptyStringSchema,
  actionId: NonEmptyStringSchema.optional(),
  sessionId: NonEmptyStringSchema.optional(),
  limit: z.number().int().positive().max(500).default(50)
});
export type ListCheckpointsInput = z.infer<typeof ListCheckpointsInputSchema>;
