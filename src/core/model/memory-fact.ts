import { z } from 'zod';

export const MemoryFactTypeSchema = z.enum([
  'decision',
  'constraint',
  'task_state',
  'tool_observation',
  'preference',
  'code_context',
  'summary_fact'
]);
export type MemoryFactType = z.infer<typeof MemoryFactTypeSchema>;

export const MemoryFactSchema = z.object({
  factId: z.string(),
  projectHash: z.string(),
  factType: MemoryFactTypeSchema,
  text: z.string(),
  derivedFromEventIds: z.array(z.string()).default([]),
  sourceKind: z.enum(['prompt', 'assistant', 'tool', 'import']),
  confidence: z.number().min(0).max(1),
  importance: z.number().min(0).max(1).default(0.5),
  tags: z.array(z.string()).default([]),
  entityRefs: z.array(z.string()).optional(),
  fileRefs: z.array(z.string()).optional(),
  symbolRefs: z.array(z.string()).optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type MemoryFact = z.infer<typeof MemoryFactSchema>;
