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
  'session_summary',
  'tool_observation'
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
    excludePatterns: z.array(z.string()).default(['password', 'secret', 'api_key', 'token', 'bearer']),
    anonymize: z.boolean().default(false),
    privateTags: z.object({
      enabled: z.boolean().default(true),
      marker: z.enum(['[PRIVATE]', '[REDACTED]', '']).default('[PRIVATE]'),
      preserveLineCount: z.boolean().default(false),
      supportedFormats: z.array(z.enum(['xml', 'bracket', 'comment'])).default(['xml'])
    }).default({})
  }).default({}),
  toolObservation: z.object({
    enabled: z.boolean().default(true),
    excludedTools: z.array(z.string()).default(['TodoWrite', 'TodoRead']),
    maxOutputLength: z.number().default(10000),
    maxOutputLines: z.number().default(100),
    storeOnlyOnSuccess: z.boolean().default(false)
  }).default({}),
  features: z.object({
    autoSave: z.boolean().default(true),
    sessionSummary: z.boolean().default(true),
    insightExtraction: z.boolean().default(true),
    crossProjectLearning: z.boolean().default(false),
    singleWriterMode: z.boolean().default(true),
    sharedStore: z.object({
      enabled: z.boolean().default(true),
      autoPromote: z.boolean().default(true),
      searchShared: z.boolean().default(true),
      minConfidenceForPromotion: z.number().default(0.8),
      sharedStoragePath: z.string().default('~/.claude-code/memory/shared')
    }).default({})
  }).default({}),
  mode: z.enum(['session', 'endless']).default('session'),
  endless: z.object({
    enabled: z.boolean().default(false),
    workingSet: z.object({
      maxEvents: z.number().default(100),
      timeWindowHours: z.number().default(24),
      minRelevanceScore: z.number().default(0.5)
    }).default({}),
    consolidation: z.object({
      triggerIntervalMs: z.number().default(3600000),
      triggerEventCount: z.number().default(100),
      triggerIdleMs: z.number().default(1800000),
      useLLMSummarization: z.boolean().default(false)
    }).default({}),
    continuity: z.object({
      minScoreForSeamless: z.number().default(0.7),
      topicDecayHours: z.number().default(48)
    }).default({})
  }).optional()
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

// PostToolUse Hook Input
export interface PostToolUseInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_output: string;
  tool_error?: string;
  session_id: string;
  started_at: string;
  ended_at: string;
}

// ============================================================
// Tool Observation Types
// ============================================================

export const ToolMetadataSchema = z.object({
  filePath: z.string().optional(),
  fileType: z.string().optional(),
  lineCount: z.number().optional(),
  command: z.string().optional(),
  exitCode: z.number().optional(),
  pattern: z.string().optional(),
  matchCount: z.number().optional(),
  url: z.string().optional(),
  statusCode: z.number().optional()
});
export type ToolMetadata = z.infer<typeof ToolMetadataSchema>;

export const ToolObservationPayloadSchema = z.object({
  toolName: z.string(),
  toolInput: z.record(z.unknown()),
  toolOutput: z.string(),
  durationMs: z.number(),
  success: z.boolean(),
  errorMessage: z.string().optional(),
  metadata: ToolMetadataSchema.optional()
});
export type ToolObservationPayload = z.infer<typeof ToolObservationPayloadSchema>;

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

// ============================================================
// Entity Types (Task, Condition, Artifact)
// ============================================================

export const EntityTypeSchema = z.enum(['task', 'condition', 'artifact']);
export type EntityType = z.infer<typeof EntityTypeSchema>;

export const TaskStatusSchema = z.enum([
  'pending',
  'in_progress',
  'blocked',
  'done',
  'cancelled'
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskPrioritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const EntityStageSchema = z.enum([
  'raw',
  'working',
  'candidate',
  'verified',
  'certified'
]);
export type EntityStage = z.infer<typeof EntityStageSchema>;

export const EntityStatusSchema = z.enum([
  'active',
  'contested',
  'deprecated',
  'superseded'
]);
export type EntityStatus = z.infer<typeof EntityStatusSchema>;

// Base Entity schema
export const EntitySchema = z.object({
  entityId: z.string(),
  entityType: EntityTypeSchema,
  canonicalKey: z.string(),
  title: z.string(),
  stage: EntityStageSchema,
  status: EntityStatusSchema,
  currentJson: z.record(z.unknown()),
  titleNorm: z.string().optional(),
  searchText: z.string().optional(),
  createdAt: z.date(),
  updatedAt: z.date()
});
export type Entity = z.infer<typeof EntitySchema>;

// Task-specific current_json structure
export const TaskCurrentJsonSchema = z.object({
  status: TaskStatusSchema,
  priority: TaskPrioritySchema.optional(),
  blockers: z.array(z.string()).optional(),
  blockerSuggestions: z.array(z.string()).optional(),
  description: z.string().optional(),
  project: z.string().optional()
});
export type TaskCurrentJson = z.infer<typeof TaskCurrentJsonSchema>;

// Entity alias for canonical key lookup
export const EntityAliasSchema = z.object({
  entityType: EntityTypeSchema,
  canonicalKey: z.string(),
  entityId: z.string(),
  isPrimary: z.boolean()
});
export type EntityAlias = z.infer<typeof EntityAliasSchema>;

// ============================================================
// Edge Types (Relationships)
// ============================================================

export const NodeTypeSchema = z.enum(['entry', 'entity', 'event']);
export type NodeType = z.infer<typeof NodeTypeSchema>;

export const RelationTypeSchema = z.enum([
  'evidence_of',
  'blocked_by',
  'blocked_by_suggested',
  'resolves_to',
  'derived_from',
  'supersedes',
  'source_of'
]);
export type RelationType = z.infer<typeof RelationTypeSchema>;

export const EdgeSchema = z.object({
  edgeId: z.string(),
  srcType: NodeTypeSchema,
  srcId: z.string(),
  relType: RelationTypeSchema,
  dstType: NodeTypeSchema,
  dstId: z.string(),
  metaJson: z.record(z.unknown()).optional(),
  createdAt: z.date()
});
export type Edge = z.infer<typeof EdgeSchema>;

// ============================================================
// Task Event Types (SoT for Task Entity)
// ============================================================

export const TaskEventTypeSchema = z.enum([
  'task_created',
  'task_status_changed',
  'task_priority_changed',
  'task_blockers_set',
  'task_transition_rejected',
  'condition_declared',
  'artifact_declared',
  'condition_resolved_to'
]);
export type TaskEventType = z.infer<typeof TaskEventTypeSchema>;

export const BlockerModeSchema = z.enum(['replace', 'suggest']);
export type BlockerMode = z.infer<typeof BlockerModeSchema>;

export const BlockerKindSchema = z.enum(['task', 'condition', 'artifact']);
export type BlockerKind = z.infer<typeof BlockerKindSchema>;

export const BlockerRefSchema = z.object({
  kind: BlockerKindSchema,
  entityId: z.string(),
  rawText: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  candidates: z.array(z.string()).optional()
});
export type BlockerRef = z.infer<typeof BlockerRefSchema>;

// Task event payloads
export const TaskCreatedPayloadSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  canonicalKey: z.string(),
  initialStatus: TaskStatusSchema,
  priority: TaskPrioritySchema.optional(),
  description: z.string().optional(),
  project: z.string().optional()
});
export type TaskCreatedPayload = z.infer<typeof TaskCreatedPayloadSchema>;

export const TaskStatusChangedPayloadSchema = z.object({
  taskId: z.string(),
  fromStatus: TaskStatusSchema,
  toStatus: TaskStatusSchema,
  reason: z.string().optional()
});
export type TaskStatusChangedPayload = z.infer<typeof TaskStatusChangedPayloadSchema>;

export const TaskBlockersSetPayloadSchema = z.object({
  taskId: z.string(),
  mode: BlockerModeSchema,
  blockers: z.array(BlockerRefSchema),
  sourceEntryId: z.string().optional()
});
export type TaskBlockersSetPayload = z.infer<typeof TaskBlockersSetPayloadSchema>;

// ============================================================
// Entry Types (Immutable memory units)
// ============================================================

export const EntryTypeSchema = z.enum([
  'fact',
  'decision',
  'insight',
  'task_note',
  'reference',
  'preference',
  'pattern',
  'troubleshooting'
]);
export type EntryType = z.infer<typeof EntryTypeSchema>;

export const EntrySchema = z.object({
  entryId: z.string(),
  createdTs: z.date(),
  entryType: EntryTypeSchema,
  title: z.string(),
  contentJson: z.record(z.unknown()),
  stage: EntityStageSchema,
  status: EntityStatusSchema,
  supersededBy: z.string().optional(),
  buildId: z.string().optional(),
  evidenceJson: z.record(z.unknown()).optional(),
  canonicalKey: z.string()
});
export type Entry = z.infer<typeof EntrySchema>;

// ============================================================
// Evidence Aligner V2 Types
// ============================================================

export const ExtractedEvidenceSchema = z.object({
  messageIndex: z.number().int().nonnegative(),
  quote: z.string()
});
export type ExtractedEvidence = z.infer<typeof ExtractedEvidenceSchema>;

export const AlignedEvidenceSchema = z.object({
  messageIndex: z.number().int().nonnegative(),
  quote: z.string(),
  spanStart: z.number().int().nonnegative(),
  spanEnd: z.number().int().positive(),
  quoteHash: z.string(),
  confidence: z.number().min(0).max(1),
  matchMethod: z.enum(['exact', 'normalized', 'fuzzy'])
});
export type AlignedEvidence = z.infer<typeof AlignedEvidenceSchema>;

export const FailedEvidenceSchema = z.object({
  messageIndex: z.number().int().nonnegative(),
  quote: z.string(),
  failureReason: z.enum(['not_found', 'below_threshold', 'ambiguous', 'empty_quote', 'invalid_index'])
});
export type FailedEvidence = z.infer<typeof FailedEvidenceSchema>;

export const EvidenceAlignResultSchema = z.discriminatedUnion('aligned', [
  z.object({ aligned: z.literal(true), evidence: AlignedEvidenceSchema }),
  z.object({ aligned: z.literal(false), evidence: FailedEvidenceSchema })
]);
export type EvidenceAlignResult = z.infer<typeof EvidenceAlignResultSchema>;

// ============================================================
// Vector Outbox V2 Types
// ============================================================

export const OutboxStatusSchema = z.enum(['pending', 'processing', 'done', 'failed']);
export type OutboxStatus = z.infer<typeof OutboxStatusSchema>;

export const OutboxItemKindSchema = z.enum(['entry', 'task_title', 'event']);
export type OutboxItemKind = z.infer<typeof OutboxItemKindSchema>;

export const OutboxJobSchema = z.object({
  jobId: z.string(),
  itemKind: OutboxItemKindSchema,
  itemId: z.string(),
  embeddingVersion: z.string(),
  status: OutboxStatusSchema,
  retryCount: z.number().int().nonnegative(),
  error: z.string().optional(),
  createdAt: z.date(),
  updatedAt: z.date()
});
export type OutboxJob = z.infer<typeof OutboxJobSchema>;

// Valid state transitions for outbox
export const VALID_OUTBOX_TRANSITIONS: Array<{ from: OutboxStatus; to: OutboxStatus }> = [
  { from: 'pending', to: 'processing' },
  { from: 'processing', to: 'done' },
  { from: 'processing', to: 'failed' },
  { from: 'failed', to: 'pending' }
];

// ============================================================
// Build Runs (Pipeline metadata)
// ============================================================

export const BuildRunSchema = z.object({
  buildId: z.string(),
  startedAt: z.date(),
  finishedAt: z.date().optional(),
  extractorModel: z.string(),
  extractorPromptHash: z.string(),
  embedderModel: z.string(),
  embeddingVersion: z.string(),
  idrisVersion: z.string(),
  schemaVersion: z.string(),
  status: z.enum(['running', 'success', 'failed']),
  error: z.string().optional()
});
export type BuildRun = z.infer<typeof BuildRunSchema>;

// ============================================================
// Pipeline Metrics
// ============================================================

export const PipelineMetricSchema = z.object({
  id: z.string(),
  ts: z.date(),
  stage: z.string(),
  latencyMs: z.number(),
  success: z.boolean(),
  error: z.string().optional(),
  sessionId: z.string().optional()
});
export type PipelineMetric = z.infer<typeof PipelineMetricSchema>;

// ============================================================
// Progressive Disclosure Types
// ============================================================

// Layer 1: Search Index (lightweight)
export const SearchIndexItemSchema = z.object({
  id: z.string(),
  summary: z.string().max(100),
  score: z.number(),
  type: z.enum(['user_prompt', 'agent_response', 'session_summary', 'tool_observation']),
  timestamp: z.date(),
  sessionId: z.string()
});
export type SearchIndexItem = z.infer<typeof SearchIndexItemSchema>;

// Layer 2: Timeline
export const TimelineItemSchema = z.object({
  id: z.string(),
  timestamp: z.date(),
  type: z.enum(['user_prompt', 'agent_response', 'session_summary', 'tool_observation']),
  preview: z.string().max(200),
  isTarget: z.boolean()
});
export type TimelineItem = z.infer<typeof TimelineItemSchema>;

// Layer 3: Full Detail
export const FullDetailSchema = z.object({
  id: z.string(),
  content: z.string(),
  type: z.enum(['user_prompt', 'agent_response', 'session_summary', 'tool_observation']),
  timestamp: z.date(),
  sessionId: z.string(),
  citationId: z.string().optional(),
  metadata: z.object({
    tokenCount: z.number(),
    hasCode: z.boolean(),
    files: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional()
  })
});
export type FullDetail = z.infer<typeof FullDetailSchema>;

// Progressive Search Result
export const ProgressiveSearchResultSchema = z.object({
  index: z.array(SearchIndexItemSchema),
  timeline: z.array(TimelineItemSchema).optional(),
  details: z.array(FullDetailSchema).optional(),
  meta: z.object({
    totalMatches: z.number(),
    expandedCount: z.number(),
    estimatedTokens: z.number(),
    expansionReason: z.string().optional()
  })
});
export type ProgressiveSearchResult = z.infer<typeof ProgressiveSearchResultSchema>;

// Progressive Disclosure Config
export const ProgressiveDisclosureConfigSchema = z.object({
  enabled: z.boolean().default(true),
  layer1: z.object({
    topK: z.number().default(10),
    minScore: z.number().default(0.7)
  }).default({}),
  autoExpand: z.object({
    enabled: z.boolean().default(true),
    highConfidenceThreshold: z.number().default(0.92),
    scoreGapThreshold: z.number().default(0.1),
    maxAutoExpandCount: z.number().default(3)
  }).default({}),
  tokenBudget: z.object({
    maxTotalTokens: z.number().default(2000),
    layer1PerItem: z.number().default(50),
    layer2PerItem: z.number().default(40),
    layer3PerItem: z.number().default(500)
  }).default({})
});
export type ProgressiveDisclosureConfig = z.infer<typeof ProgressiveDisclosureConfigSchema>;

// ============================================================
// Citation Types
// ============================================================

export const CitationSchema = z.object({
  citationId: z.string().length(6),
  eventId: z.string(),
  createdAt: z.date()
});
export type Citation = z.infer<typeof CitationSchema>;

export const CitationUsageSchema = z.object({
  usageId: z.string(),
  citationId: z.string(),
  sessionId: z.string(),
  usedAt: z.date(),
  context: z.string().optional()
});
export type CitationUsage = z.infer<typeof CitationUsageSchema>;

export interface CitedSearchResult {
  event: MemoryEvent;
  citation: Citation;
  score: number;
}

export interface CitationStats {
  usageCount: number;
  lastUsed: Date | null;
}

// ============================================================
// Endless Mode Types
// ============================================================

export const MemoryModeSchema = z.enum(['session', 'endless']);
export type MemoryMode = z.infer<typeof MemoryModeSchema>;

export const EndlessModeConfigSchema = z.object({
  enabled: z.boolean().default(false),

  workingSet: z.object({
    maxEvents: z.number().default(100),
    timeWindowHours: z.number().default(24),
    minRelevanceScore: z.number().default(0.5)
  }).default({}),

  consolidation: z.object({
    triggerIntervalMs: z.number().default(3600000), // 1 hour
    triggerEventCount: z.number().default(100),
    triggerIdleMs: z.number().default(1800000), // 30 minutes
    useLLMSummarization: z.boolean().default(false)
  }).default({}),

  continuity: z.object({
    minScoreForSeamless: z.number().default(0.7),
    topicDecayHours: z.number().default(48)
  }).default({})
});
export type EndlessModeConfig = z.infer<typeof EndlessModeConfigSchema>;

// Working Set Item
export const WorkingSetItemSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  addedAt: z.date(),
  relevanceScore: z.number(),
  topics: z.array(z.string()).optional(),
  expiresAt: z.date()
});
export type WorkingSetItem = z.infer<typeof WorkingSetItemSchema>;

// Working Set
export interface WorkingSet {
  recentEvents: MemoryEvent[];
  lastActivity: Date;
  continuityScore: number;
}

// Consolidated Memory
export const ConsolidatedMemorySchema = z.object({
  memoryId: z.string(),
  summary: z.string(),
  topics: z.array(z.string()),
  sourceEvents: z.array(z.string()),
  confidence: z.number(),
  createdAt: z.date(),
  accessedAt: z.date().optional(),
  accessCount: z.number().default(0)
});
export type ConsolidatedMemory = z.infer<typeof ConsolidatedMemorySchema>;

// Consolidated Memory Input (for creation)
export interface ConsolidatedMemoryInput {
  summary: string;
  topics: string[];
  sourceEvents: string[];
  confidence: number;
}

// Event Group (for consolidation)
export interface EventGroup {
  topics: string[];
  events: MemoryEvent[];
}

// Context Snapshot (for continuity calculation)
export interface ContextSnapshot {
  id: string;
  timestamp: number;
  topics: string[];
  files: string[];
  entities: string[];
}

// Transition Type
export const TransitionTypeSchema = z.enum(['seamless', 'topic_shift', 'break']);
export type TransitionType = z.infer<typeof TransitionTypeSchema>;

// Continuity Score Result
export interface ContinuityScore {
  score: number;
  transitionType: TransitionType;
}

// Continuity Log
export const ContinuityLogSchema = z.object({
  logId: z.string(),
  fromContextId: z.string().optional(),
  toContextId: z.string().optional(),
  continuityScore: z.number(),
  transitionType: TransitionTypeSchema,
  createdAt: z.date()
});
export type ContinuityLog = z.infer<typeof ContinuityLogSchema>;

// Endless Mode Status
export interface EndlessModeStatus {
  mode: MemoryMode;
  workingSetSize: number;
  continuityScore: number;
  consolidatedCount: number;
  lastConsolidation: Date | null;
}

// ============================================================
// Shared Store Types (Cross-Project Knowledge)
// ============================================================

export const SharedEntryTypeSchema = z.enum([
  'troubleshooting',
  'best_practice',
  'common_error'
]);
export type SharedEntryType = z.infer<typeof SharedEntryTypeSchema>;

export const SharedTroubleshootingEntrySchema = z.object({
  entryId: z.string(),
  sourceProjectHash: z.string(),
  sourceEntryId: z.string(),
  title: z.string(),
  symptoms: z.array(z.string()),
  rootCause: z.string(),
  solution: z.string(),
  topics: z.array(z.string()),
  technologies: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1),
  usageCount: z.number().default(0),
  lastUsedAt: z.date().optional(),
  promotedAt: z.date(),
  createdAt: z.date()
});
export type SharedTroubleshootingEntry = z.infer<typeof SharedTroubleshootingEntrySchema>;

export interface SharedTroubleshootingInput {
  sourceProjectHash: string;
  sourceEntryId: string;
  title: string;
  symptoms: string[];
  rootCause: string;
  solution: string;
  topics: string[];
  technologies?: string[];
  confidence: number;
}

export const SharedStoreConfigSchema = z.object({
  enabled: z.boolean().default(true),
  autoPromote: z.boolean().default(true),
  searchShared: z.boolean().default(true),
  minConfidenceForPromotion: z.number().default(0.8),
  sharedStoragePath: z.string().default('~/.claude-code/memory/shared')
});
export type SharedStoreConfig = z.infer<typeof SharedStoreConfigSchema>;

// Shared search result
export interface SharedSearchResult {
  id: string;
  entryId: string;
  content: string;
  score: number;
  entryType: SharedEntryType;
}
