import { z } from 'zod';

export const MemorySummaryTypeSchema = z.enum([
  'turn',
  'session',
  'project',
  'continuity',
  'timeline_digest'
]);
export type MemorySummaryType = z.infer<typeof MemorySummaryTypeSchema>;

export const MemorySummarySchema = z.object({
  summaryId: z.string(),
  summaryType: MemorySummaryTypeSchema,
  refId: z.string(),
  text: z.string(),
  sourceEventIds: z.array(z.string()).default([]),
  sourceFactIds: z.array(z.string()).default([]),
  createdAt: z.string()
});
export type MemorySummary = z.infer<typeof MemorySummarySchema>;
