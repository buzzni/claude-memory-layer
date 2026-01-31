/**
 * Core types for code-memory plugin
 * Idris2 inspired: Complete, immutable type definitions with Zod validation
 */

import { z } from 'zod';

// ============================================================
// Event Types
// ============================================================

export const EventTypeSchema = z.enum([
  'user_prompt',
  'agent_response',
  'session_summary'
]);
export type EventType = z.infer<typeof EventTypeSchema>;

// ============================================================
// Memory Event (L0 EventStore)
// ============================================================

export const MemoryEventSchema = z.object({
  id: z.string().uuid(),
  eventType: EventTypeSchema,
  sessionId: z.string(),
  timestamp: z.date(),
  content: z.string(),
  canonicalKey: z.string(),
  dedupeKey: z.string(),
  metadata: z.record(z.unknown()).optional()
});
export type MemoryEvent = z.infer<typeof MemoryEventSchema>;

// Input for creating new events (id, dedupeKey generated automatically)
export const MemoryEventInputSchema = MemoryEventSchema.omit({
  id: true,
  dedupeKey: true,
  canonicalKey: true
});
export type MemoryEventInput = z.infer<typeof MemoryEventInputSchema>;

// ============================================================
// Session
// ============================================================

export const SessionSchema = z.object({
  id: z.string(),
  startedAt: z.date(),
  endedAt: z.date().optional(),
  projectPath: z.string().optional(),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional()
});
export type Session = z.infer<typeof SessionSchema>;

// ============================================================
// Insight (L1 Structured)
// ============================================================

export const InsightTypeSchema = z.enum([
  'preference',
  'pattern',
  'expertise'
]);
export type InsightType = z.infer<typeof InsightTypeSchema>;

export const InsightSchema = z.object({
  id: z.string().uuid(),
  insightType: InsightTypeSchema,
  content: z.string(),
  canonicalKey: z.string(),
  confidence: z.number().min(0).max(1),
  sourceEvents: z.array(z.string().uuid()),
  createdAt: z.date(),
  lastUpdated: z.date()
});
export type Insight = z.infer<typeof InsightSchema>;

// ============================================================
// Memory Match (Search Result)
// ============================================================

export const MemoryMatchSchema = z.object({
  event: MemoryEventSchema,
  score: z.number().min(0).max(1),
  relevanceReason: z.string().optional()
});
export type MemoryMatch = z.infer<typeof MemoryMatchSchema>;

// ============================================================
// Match Confidence (AXIOMMIND)
// ============================================================

export const MatchConfidenceSchema = z.enum(['high', 'suggested', 'none']);
export type MatchConfidence = z.infer<typeof MatchConfidenceSchema>;

export const MatchResultSchema = z.object({
  match: MemoryMatchSchema.nullable(),
  confidence: MatchConfidenceSchema,
  gap: z.number().optional(),
  alternatives: z.array(MemoryMatchSchema).optional()
});
export type MatchResult = z.infer<typeof MatchResultSchema>;

// AXIOMMIND Matching Thresholds
export const MATCH_THRESHOLDS = {
  minCombinedScore: 0.92,
  minGap: 0.03,
  suggestionThreshold: 0.75
} as const;

// ============================================================
// Memory Level (Graduation Pipeline)
// ============================================================

export const MemoryLevelSchema = z.enum(['L0', 'L1', 'L2', 'L3', 'L4']);
export type MemoryLevel = z.infer<typeof MemoryLevelSchema>;

export const GraduationResultSchema = z.object({
  eventId: z.string().uuid(),
  fromLevel: MemoryLevelSchema,
  toLevel: MemoryLevelSchema,
  success: z.boolean(),
  reason: z.string().optional()
});
export type GraduationResult = z.infer<typeof GraduationResultSchema>;

// ============================================================
// Evidence Span (AXIOMMIND Principle 4)
// ============================================================

export const EvidenceSpanSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  confidence: z.number().min(0).max(1),
  matchType: z.enum(['exact', 'fuzzy', 'none']),
  originalQuote: z.string(),
  alignedText: z.string()
});
export type EvidenceSpan = z.infer<typeof EvidenceSpanSchema>;

// ============================================================
// Configuration
// ============================================================

export const ConfigSchema = z.object({
  storage: z.object({
    path: z.string().default('~/.claude-code/memory'),
    maxSizeMB: z.number().default(500)
  }).default({}),
  embedding: z.object({
    provider: z.enum(['local', 'openai']).default('local'),
    model: z.string().default('Xenova/all-MiniLM-L6-v2'),
    openaiModel: z.string().default('text-embedding-3-small'),
    batchSize: z.number().default(32)
  }).default({}),
  retrieval: z.object({
    topK: z.number().default(5),
    minScore: z.number().default(0.7),
    maxTokens: z.number().default(2000)
  }).default({}),
  matching: z.object({
    minCombinedScore: z.number().default(0.92),
    minGap: z.number().default(0.03),
    suggestionThreshold: z.number().default(0.75),
    weights: z.object({
      semanticSimilarity: z.number().default(0.4),
      ftsScore: z.number().default(0.25),
      recencyBonus: z.number().default(0.2),
      statusWeight: z.number().default(0.15)
    }).default({})
  }).default({}),
  privacy: z.object({
    excludePatterns: z.array(z.string()).default(['password', 'secret', 'api_key']),
    anonymize: z.boolean().default(false)
  }).default({}),
  features: z.object({
    autoSave: z.boolean().default(true),
    sessionSummary: z.boolean().default(true),
    insightExtraction: z.boolean().default(true),
    crossProjectLearning: z.boolean().default(false),
    singleWriterMode: z.boolean().default(true)
  }).default({})
});
export type Config = z.infer<typeof ConfigSchema>;

// ============================================================
// Append Result (AXIOMMIND Principle 2: Append-only)
// ============================================================

export type AppendResult =
  | { success: true; eventId: string; isDuplicate: false }
  | { success: true; eventId: string; isDuplicate: true }
  | { success: false; error: string };

// ============================================================
// Hook Input/Output Types
// ============================================================

export interface SessionStartInput {
  session_id: string;
  cwd: string;
}

export interface SessionStartOutput {
  context?: string;
}

export interface UserPromptSubmitInput {
  session_id: string;
  prompt: string;
}

export interface UserPromptSubmitOutput {
  context?: string;
}

export interface StopInput {
  session_id: string;
  stop_reason: string;
  messages: Array<{ role: string; content: string }>;
}

export interface SessionEndInput {
  session_id: string;
}

// ============================================================
// Vector Record
// ============================================================

export interface VectorRecord {
  id: string;
  eventId: string;
  sessionId: string;
  eventType: string;
  content: string;
  vector: number[];
  timestamp: string;
  metadata?: Record<string, unknown>;
}

// ============================================================
// Outbox Item (Single-Writer Pattern)
// ============================================================

export interface OutboxItem {
  id: string;
  eventId: string;
  content: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  retryCount: number;
  createdAt: Date;
  errorMessage?: string;
}
