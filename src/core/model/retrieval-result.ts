import { z } from 'zod';

export const RetrievalReasonSchema = z.enum([
  'semantic_match',
  'keyword_match',
  'recent_relevance',
  'continuity_link',
  'entity_overlap',
  'tool_followup',
  'summary_fallback'
]);
export type RetrievalReason = z.infer<typeof RetrievalReasonSchema>;

export const RetrievalResultTypeSchema = z.enum([
  'fact',
  'summary',
  'tool_evidence',
  'rule',
  'source'
]);
export type RetrievalResultType = z.infer<typeof RetrievalResultTypeSchema>;

export const RetrievalResultEnvelopeSchema = z.object({
  id: z.string(),
  resultType: RetrievalResultTypeSchema,
  title: z.string().optional(),
  snippet: z.string(),
  score: z.number().min(0).max(1),
  reasons: z.array(RetrievalReasonSchema).default([]),
  sourceRef: z.string().optional(),
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
});
export type RetrievalResultEnvelope = z.infer<typeof RetrievalResultEnvelopeSchema>;
