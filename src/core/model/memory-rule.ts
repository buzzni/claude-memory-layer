import { z } from 'zod';

export const MemoryRuleSchema = z.object({
  ruleId: z.string(),
  projectHash: z.string().optional(),
  scope: z.enum(['project', 'shared']),
  ruleType: z.enum(['preference', 'workflow', 'convention', 'constraint']),
  text: z.string(),
  confidence: z.number().min(0).max(1),
  evidenceIds: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type MemoryRule = z.infer<typeof MemoryRuleSchema>;
