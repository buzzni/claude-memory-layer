import { z } from 'zod';

export const RawEventTypeSchema = z.enum([
  'user_prompt',
  'assistant_response',
  'tool_output',
  'session_marker',
  'imported_turn'
]);
export type RawEventType = z.infer<typeof RawEventTypeSchema>;

export const PrivacyLevelSchema = z.enum(['public', 'internal', 'private', 'masked']);
export type PrivacyLevel = z.infer<typeof PrivacyLevelSchema>;

export const RawEventSchema = z.object({
  eventId: z.string(),
  projectHash: z.string(),
  sessionId: z.string(),
  turnId: z.string().optional(),
  eventType: RawEventTypeSchema,
  content: z.string(),
  toolName: z.string().optional(),
  sourceRef: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
  privacyLevel: PrivacyLevelSchema.default('internal'),
  createdAt: z.string()
});
export type RawEvent = z.infer<typeof RawEventSchema>;
