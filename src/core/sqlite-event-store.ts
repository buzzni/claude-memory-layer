import { readIngestSourceClocks } from './ingest-source-clocks.js';
import { retrievalRollout } from './retrieval-rollout.js';
/**
 * SQLite-based EventStore implementation
 * Primary store for hooks - WAL mode enables concurrent access
 */

import { randomUUID } from 'crypto';
import {
  EventType,
  MemoryEvent,
  MemoryEventInput,
  Session,
  AppendResult,
  OutboxItem,
  OutboxStats,
  OutboxStatsOptions,
  OutboxRecoveryOptions,
  OutboxRecoveryResult,
  ProjectScopeRepairOptions,
  ProjectScopeRepairResult,
  ProjectScopeRepairSample
} from './types.js';
import { makeCanonicalKey, makeDedupeKey } from './canonical-key.js';
import { generateCitationId } from './citation-generator.js';
import * as nodePath from 'path';
import { hashProjectPath, hashProjectPathIgnoringMarker } from './registry/project-path.js';
import {
  createSQLiteDatabase,
  sqliteRun,
  sqliteAll,
  sqliteGet,
  sqliteClose,
  sqliteExec,
  toDateFromSQLite,
  toSQLiteTimestamp,
  type SQLiteDatabase,
  type SQLiteOptions
} from './sqlite-wrapper.js';
import { MarkdownMirror } from './markdown-mirror.js';
import { VectorOutbox, type OutboxConfig } from './vector-outbox.js';
import { normalizeRetrievalDebugLanes, type RetrievalDebugLane } from './retrieval-debug-lanes.js';
import { computeMemoryUsageEvidence, type EvidenceMatch } from './usefulness-evidence.js';
import {
  buildUsefulnessObservationV2,
  classifyReaskOutcome,
  parseToolOutcome,
  USEFULNESS_V2_EVALUATION_WINDOW_MS
} from './usefulness-outcome-v2.js';
import {
  CURRENT_USEFULNESS_EVALUATOR_VERSION,
  LEGACY_ASSUMED_DELIVERY_EVALUATOR_VERSIONS,
  RETRIEVAL_TELEMETRY_SCHEMA_VERSION,
  deliveredFromStatus,
  emptyUsefulnessAggregateV2,
  normalizeDeliveryEvidence,
  normalizeDeliveryStatus,
  normalizeRequestId,
  normalizeUsefulnessMinimumSample,
  presentedOutcomeReason,
  normalizeRetrievalPresentationMode,
  normalizeRetrievalOutcomeDiagnostics,
  normalizeRetrievalTriggerType,
  normalizeTelemetryClient,
  type RecordReferenceNavigationInput,
  type RecordReferenceNavigationResult,
  type RetrievalPresentationMode,
  type RetrievalOutcomeDiagnostics,
  type RetrievalTelemetryContext,
  type RetrievalTelemetryStats,
  type RetrievalTriggerType,
  type DeliveryEvidenceSource,
  type DeliveryStatus,
  type MemoryUsefulnessObservationV2,
  type RetrievalClientCoverage,
  type UsefulnessAdoption,
  type RetrievalTraceItemInput,
  type TypedSelectionSummary,
  type UsefulnessAggregateV2,
  type UsefulnessRateV2
} from './retrieval-telemetry.js';
import {
  normalizeMemoryKind,
  usefulnessRowKey,
  usefulnessRowKeySql,
  type MemoryKind
} from './memory-ref.js';
import { recordReferenceNavigationOnDb } from './retrieval-navigation.js';
import {
  backfillTraceItems,
  ensureRetrievalTraceItemsSchema,
  normalizeTraceItems,
  readTraceItems,
  resolveMemoryRefKinds,
  summarizeTypedSelections,
  writeTraceItems,
  type TraceItemBackfillResult
} from './retrieval-trace-ledger.js';

export interface SQLiteEventStoreOptions extends SQLiteOptions {
  markdownMirrorRoot?: string;
  vectorOutbox?: false | VectorOutbox | Partial<OutboxConfig>;
}

export interface DerivationLiveness {
  graduation: {
    attempts: number;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastStatus: 'success' | 'not_eligible' | 'failed' | null;
    lastErrorCategory: 'graduation_failed' | null;
  };
  sources: {
    graduatedEvents: number;
    curatedLessons: number;
  };
}

type QueryRewriteKind = 'none' | 'follow-up-context' | 'intent-rewrite';

type RetrievalTraceDetailRecord = {
  eventId: string;
  score: number;
  semanticScore?: number;
  lexicalScore?: number;
  recencyScore?: number;
  lanes?: RetrievalDebugLane[];
};

function normalizeRetrievalTraceDetails(details?: RetrievalTraceDetailRecord[]): RetrievalTraceDetailRecord[] {
  return (details || []).map((detail) => {
    const lanes = normalizeRetrievalDebugLanes((detail as { lanes?: unknown }).lanes);
    const normalized: RetrievalTraceDetailRecord = {
      eventId: detail.eventId,
      score: detail.score
    };
    if (detail.semanticScore !== undefined) normalized.semanticScore = detail.semanticScore;
    if (detail.lexicalScore !== undefined) normalized.lexicalScore = detail.lexicalScore;
    if (detail.recencyScore !== undefined) normalized.recencyScore = detail.recencyScore;
    if (lanes.length > 0) normalized.lanes = lanes;
    return normalized;
  });
}

function parseRetrievalTraceDetails(value: unknown): RetrievalTraceDetailRecord[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? normalizeRetrievalTraceDetails(parsed as RetrievalTraceDetailRecord[]) : [];
}

/**
 * Read a trace's diagnostics.
 *
 * Rows written before the honest-default migration stored `runtime_error` as a
 * fallback for "no diagnostics", not as an observed exception. They are shown
 * as `legacy_unclassified` and never rewritten in place (specs R2).
 */
function parseRetrievalOutcomeDiagnostics(row: Record<string, unknown>): RetrievalOutcomeDiagnostics {
  let value: unknown;
  try {
    value = typeof row.retrieval_diagnostics_json === 'string'
      ? JSON.parse(row.retrieval_diagnostics_json)
      : undefined;
  } catch {
    value = undefined;
  }
  const presented = presentedOutcomeReason(row.outcome_reason, row.telemetry_schema_version);
  const diagnostics = normalizeRetrievalOutcomeDiagnostics(value, presented);
  return Number(row.telemetry_schema_version) >= 2
    ? diagnostics
    : { ...diagnostics, outcomeReason: presented };
}

function normalizeQueryRewriteKind(value?: string | null): QueryRewriteKind {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'follow-up-context' || normalized === 'intent-rewrite') return normalized;
  return 'none';
}

const REWRITTEN_QUERY_REWRITE_KIND_SQL = `LOWER(TRIM(COALESCE(query_rewrite_kind, 'none'))) IN ('follow-up-context', 'intent-rewrite')`;
const DEFAULT_OUTBOX_STUCK_THRESHOLD_MS = 5 * 60 * 1000;
const DEFAULT_OUTBOX_MAX_RETRIES = 3;
// Re-exported for existing importers; the implementation moved next to the
// navigation recorder so db-only callers can reuse both.
export { REFERENCE_ATTRIBUTION_WINDOW_MS } from './retrieval-navigation.js';
// Bump when introducing an ordered migration that must run exactly once; gate
// such migrations on the persisted PRAGMA user_version.
const SQLITE_SCHEMA_VERSION = 1;

function emptyOutboxRecoveryResult(): OutboxRecoveryResult {
  return {
    embedding: { recoveredProcessing: 0, retriedFailed: 0 },
    vector: { recoveredProcessing: 0, retriedFailed: 0 }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getNestedRecord(root: Record<string, unknown> | undefined, path: string[]): Record<string, unknown> | undefined {
  let cursor: unknown = root;
  for (const key of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[key];
  }
  return isRecord(cursor) ? cursor : undefined;
}

function getNestedString(root: Record<string, unknown> | undefined, path: string[]): string | undefined {
  let cursor: unknown = root;
  for (const key of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[key];
  }
  return typeof cursor === 'string' && cursor.length > 0 ? cursor : undefined;
}

function metadataProjectHash(metadata: Record<string, unknown> | undefined): string | undefined {
  return getNestedString(metadata, ['scope', 'project', 'hash']);
}

function metadataProjectPaths(metadata: Record<string, unknown> | undefined): string[] {
  const candidates = [
    getNestedString(metadata, ['projectPath']),
    getNestedString(metadata, ['sourceProjectPath']),
    getNestedString(metadata, ['scope', 'project', 'path'])
  ];
  const paths: string[] = [];
  for (const value of candidates) {
    if (value && !paths.includes(value)) paths.push(value);
  }
  return paths;
}

function metadataProjectPath(metadata: Record<string, unknown> | undefined): string | undefined {
  return metadataProjectPaths(metadata)[0];
}

function isActiveQuarantinedMetadata(metadata: Record<string, unknown> | undefined): boolean {
  const quarantine = getNestedRecord(metadata, ['quarantine']);
  return quarantine?.status === 'active';
}

function activeQuarantineStatusExpression(column = 'metadata'): string {
  return `COALESCE(json_extract(CASE WHEN json_valid(${column}) THEN ${column} ELSE '{}' END, '$.quarantine.status'), '')`;
}

function notActiveQuarantinedSql(column = 'metadata'): string {
  return `${activeQuarantineStatusExpression(column)} != 'active'`;
}

interface QuarantineReadOptions {
  includeQuarantined?: boolean;
}

export interface RecentEventsReadOptions extends QuarantineReadOptions {
  /** Restrict to these event types. An empty/omitted list means "any type". */
  eventTypes?: EventType[];
}

function maybeQuarantinePredicate(options?: QuarantineReadOptions, column = 'metadata'): string {
  return options?.includeQuarantined ? '1=1' : notActiveQuarantinedSql(column);
}

function safeParseMetadataValue(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (typeof value === 'object') return isRecord(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isImportedOrLegacyScopedMetadata(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  return Boolean(
    metadata.importedFrom
    || metadata.sourceSessionId
    || metadata.sourceSessionHash
    || metadata.hermesSource
    || metadata.projectPath
    || metadata.sourceProjectPath
    || metadata.source === 'hermes'
    || metadata.source === 'claude'
    || metadata.source === 'codex'
  );
}

function addMetadataTag(metadata: Record<string, unknown>, tag: string): void {
  const current = Array.isArray(metadata.tags)
    ? metadata.tags.filter((value): value is string => typeof value === 'string')
    : [];
  if (!current.includes(tag)) metadata.tags = [...current, tag];
}

function buildRepairResult(projectHash: string, dryRun: boolean): ProjectScopeRepairResult {
  return {
    dryRun,
    projectHash,
    scanned: 0,
    repaired: 0,
    quarantined: 0,
    alreadyScoped: 0,
    skipped: 0,
    samples: []
  };
}

function normalizeRepoName(value: string): string {
  return value.replace(/\.git$/i, '').trim().toLowerCase();
}

function projectBasename(projectPath?: string): string | undefined {
  if (!projectPath) return undefined;
  const trimmed = projectPath.replace(/[\\/]+$/, '');
  const basename = nodePath.basename(trimmed);
  return basename ? normalizeRepoName(basename) : undefined;
}

function isProjectScopeRepairExplanation(content: string): boolean {
  const normalized = content.toLowerCase();
  const hasRepairContext = /project[- ]scope|mis[- ]scoped|quarantine|contamination|legacy|오염|격리|repair/.test(normalized);
  const hasExplanationContext = /example|detector|trap|not a .*project task|기억|메모리|설명|수정|검증/.test(normalized);
  return hasRepairContext && hasExplanationContext;
}

function hasConflictingContentProjectHint(content: string, projectPath?: string): boolean {
  const currentName = projectBasename(projectPath);
  if (!currentName) return false;
  if (isProjectScopeRepairExplanation(content)) return false;

  const githubRepoPattern = /github\.com[:/]([^/\s`'"#)]+)\/([^/\s`'"#)]+)(?:\.git)?/gi;
  let githubMatch: RegExpExecArray | null;
  while ((githubMatch = githubRepoPattern.exec(content)) !== null) {
    const repo = normalizeRepoName(githubMatch[2] || '');
    if (repo && repo !== currentName) return true;
  }

  const workspacePathPattern = /\/workspace\/([^/\s`'"#)]+)/gi;
  let workspaceMatch: RegExpExecArray | null;
  while ((workspaceMatch = workspacePathPattern.exec(content)) !== null) {
    const repo = normalizeRepoName(workspaceMatch[1] || '');
    if (repo && repo !== currentName) return true;
  }

  return false;
}

export class SQLiteEventStore {
  private db: SQLiteDatabase;
  private initialized = false;
  private readonly readOnly: boolean;
  private readonly markdownMirror: MarkdownMirror | null;
  private readonly vectorOutbox: VectorOutbox | null;

  constructor(dbPath: string, options?: SQLiteEventStoreOptions) {
    this.readOnly = options?.readonly ?? false;
    this.db = createSQLiteDatabase(dbPath, {
      readonly: this.readOnly,
      snapshot: options?.snapshot,
      snapshotDirectory: options?.snapshotDirectory,
      canonicalMemoryRoot: options?.canonicalMemoryRoot,
      walMode: !this.readOnly
    });
    this.markdownMirror = this.readOnly || !options?.markdownMirrorRoot
      ? null
      : new MarkdownMirror(options.markdownMirrorRoot);
    this.vectorOutbox = this.createVectorOutbox(options?.vectorOutbox);
  }

  private createVectorOutbox(option: SQLiteEventStoreOptions['vectorOutbox']): VectorOutbox | null {
    if (this.readOnly || option === false) return null;
    if (option instanceof VectorOutbox) return option;
    return new VectorOutbox(this.db, option ?? {});
  }

  private enqueueVectorOutboxEventSync(eventId: string, eventType: string): void {
    if (!this.vectorOutbox) return;
    if (eventType === 'tool_observation') return;
    this.vectorOutbox.enqueueSync('event', eventId);
  }

  private async enqueueVectorOutboxEvent(eventId: string, eventType: string): Promise<void> {
    this.enqueueVectorOutboxEventSync(eventId, eventType);
  }

  /**
   * Initialize database schema
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // In read-only mode, skip schema creation
    if (this.readOnly) {
      this.initialized = true;
      return;
    }

    // Create all tables in a single exec for efficiency
    sqliteExec(this.db, `
      -- L0 EventStore: Single Source of Truth (immutable, append-only)
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        content TEXT NOT NULL,
        canonical_key TEXT NOT NULL,
        dedupe_key TEXT UNIQUE,
        metadata TEXT,
        access_count INTEGER DEFAULT 0,
        last_accessed_at TEXT
      );

      -- Dedup table for idempotency
      CREATE TABLE IF NOT EXISTS event_dedup (
        dedupe_key TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Session metadata
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        project_path TEXT,
        summary TEXT,
        tags TEXT
      );

      -- Insights (derived data, rebuildable)
      CREATE TABLE IF NOT EXISTS insights (
        id TEXT PRIMARY KEY,
        insight_type TEXT NOT NULL,
        content TEXT NOT NULL,
        canonical_key TEXT NOT NULL,
        confidence REAL,
        source_events TEXT,
        created_at TEXT,
        last_updated TEXT
      );

      -- Embedding Outbox (Single-Writer Pattern)
      CREATE TABLE IF NOT EXISTS embedding_outbox (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        retry_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        processed_at TEXT,
        error_message TEXT
      );

      -- Projection offset tracking
      CREATE TABLE IF NOT EXISTS projection_offsets (
        projection_name TEXT PRIMARY KEY,
        last_event_id TEXT,
        last_timestamp TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Memory level tracking
      CREATE TABLE IF NOT EXISTS memory_levels (
        event_id TEXT PRIMARY KEY,
        level TEXT NOT NULL DEFAULT 'L0',
        promoted_at TEXT DEFAULT (datetime('now'))
      );

      -- Entries (immutable memory units)
      CREATE TABLE IF NOT EXISTS entries (
        entry_id TEXT PRIMARY KEY,
        created_ts TEXT NOT NULL,
        entry_type TEXT NOT NULL,
        title TEXT NOT NULL,
        content_json TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'raw',
        status TEXT DEFAULT 'active',
        superseded_by TEXT,
        build_id TEXT,
        evidence_json TEXT,
        canonical_key TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Entities (task/condition/artifact)
      CREATE TABLE IF NOT EXISTS entities (
        entity_id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        canonical_key TEXT NOT NULL,
        title TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'raw',
        status TEXT NOT NULL DEFAULT 'active',
        current_json TEXT NOT NULL,
        title_norm TEXT,
        search_text TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Entity aliases for canonical key lookup
      CREATE TABLE IF NOT EXISTS entity_aliases (
        entity_type TEXT NOT NULL,
        canonical_key TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        is_primary INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY(entity_type, canonical_key)
      );

      -- Edges (relationships between entries/entities) -- current-state projection
      CREATE TABLE IF NOT EXISTS edges (
        edge_id TEXT PRIMARY KEY,
        src_type TEXT NOT NULL,
        src_id TEXT NOT NULL,
        rel_type TEXT NOT NULL,
        dst_type TEXT NOT NULL,
        dst_id TEXT NOT NULL,
        meta_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Bitemporal edge history (Zep/Graphiti-inspired), see
      -- docs/graph-temporal-edge-spike.md. edges above stays the fast
      -- current-state projection; this table is the append-only source for
      -- asOf/knownAt queries and is never hard-deleted.
      CREATE TABLE IF NOT EXISTS edge_history (
        history_id TEXT PRIMARY KEY,
        edge_id TEXT NOT NULL,
        edge_key TEXT NOT NULL,
        src_type TEXT NOT NULL,
        src_id TEXT NOT NULL,
        rel_type TEXT NOT NULL,
        dst_type TEXT NOT NULL,
        dst_id TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'active',
        valid_from TEXT,
        valid_to TEXT,
        committed_at TEXT NOT NULL DEFAULT (datetime('now')),
        superseded_by_history_id TEXT,
        source_event_ids_json TEXT NOT NULL DEFAULT '[]',
        evidence_json TEXT NOT NULL DEFAULT '{}',
        meta_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_edge_history_key_commit
        ON edge_history(edge_key, committed_at DESC, history_id DESC);
      CREATE INDEX IF NOT EXISTS idx_edge_history_valid
        ON edge_history(edge_key, valid_from, valid_to);
      CREATE INDEX IF NOT EXISTS idx_edge_history_src
        ON edge_history(src_id, rel_type, committed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_edge_history_dst
        ON edge_history(dst_id, rel_type, committed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_edge_history_status
        ON edge_history(status);

      -- Vector Outbox V2 Table
      CREATE TABLE IF NOT EXISTS vector_outbox (
        job_id TEXT PRIMARY KEY,
        item_kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        embedding_version TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        retry_count INTEGER DEFAULT 0,
        error TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(item_kind, item_id, embedding_version)
      );

      -- Build Runs
      CREATE TABLE IF NOT EXISTS build_runs (
        build_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        extractor_model TEXT NOT NULL,
        extractor_prompt_hash TEXT NOT NULL,
        embedder_model TEXT NOT NULL,
        embedding_version TEXT NOT NULL,
        idris_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        error TEXT
      );

      -- Pipeline Metrics
      CREATE TABLE IF NOT EXISTS pipeline_metrics (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        stage TEXT NOT NULL,
        latency_ms REAL NOT NULL,
        success INTEGER NOT NULL,
        error TEXT,
        session_id TEXT
      );

      -- Working Set table (active memory window)
      CREATE TABLE IF NOT EXISTS working_set (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        added_at TEXT DEFAULT (datetime('now')),
        relevance_score REAL DEFAULT 1.0,
        topics TEXT,
        expires_at TEXT
      );

      -- Consolidated Memories table (long-term integrated memories)
      CREATE TABLE IF NOT EXISTS consolidated_memories (
        memory_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        topics TEXT,
        source_events TEXT,
        confidence REAL DEFAULT 0.5,
        created_at TEXT DEFAULT (datetime('now')),
        accessed_at TEXT,
        access_count INTEGER DEFAULT 0
      );

      -- Junction: consolidated memory -> source event id (indexed lookup that
      -- replaces per-event source_events LIKE scans during consolidation).
      CREATE TABLE IF NOT EXISTS consolidated_memory_events (
        memory_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        PRIMARY KEY (memory_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_cme_event ON consolidated_memory_events(event_id);

      -- Continuity Log table (tracks context transitions)
      CREATE TABLE IF NOT EXISTS continuity_log (
        log_id TEXT PRIMARY KEY,
        from_context_id TEXT,
        to_context_id TEXT,
        continuity_score REAL,
        transition_type TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Consolidated Rules table (long-term stable memory)
      CREATE TABLE IF NOT EXISTS consolidated_rules (
        rule_id TEXT PRIMARY KEY,
        rule TEXT NOT NULL,
        topics TEXT,
        source_memory_ids TEXT,
        source_events TEXT,
        confidence REAL DEFAULT 0.5,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Endless Mode Config table
      CREATE TABLE IF NOT EXISTS endless_config (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Memory Helpfulness tracking
      CREATE TABLE IF NOT EXISTS memory_helpfulness (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        retrieval_score REAL DEFAULT 0,
        query_preview TEXT,
        session_continued INTEGER DEFAULT 0,
        prompt_count_after INTEGER DEFAULT 0,
        tool_success_count INTEGER DEFAULT 0,
        tool_total_count INTEGER DEFAULT 0,
        was_reasked INTEGER DEFAULT 0,
        helpfulness_score REAL DEFAULT 0.5,
        memory_kind TEXT NOT NULL DEFAULT 'unknown',
        memory_project_id TEXT,
        delivery_status TEXT NOT NULL DEFAULT 'unknown',
        delivery_evidence TEXT NOT NULL DEFAULT 'none',
        delivered_at TEXT,
        presentation_mode TEXT NOT NULL DEFAULT 'unknown',
        trigger_type TEXT NOT NULL DEFAULT 'unknown',
        delivery_client TEXT NOT NULL DEFAULT 'unknown',
        created_at TEXT DEFAULT (datetime('now')),
        measured_at TEXT
      );

      -- Additive, versioned usefulness funnel. Raw dimensions stay separate;
      -- no unknown value is coerced to neutral or zero.
      CREATE TABLE IF NOT EXISTS memory_usefulness_observations_v2 (
        trace_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        observation_kind TEXT NOT NULL DEFAULT 'outcome',
        evaluator_version TEXT NOT NULL,
        presentation_mode TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        selected INTEGER NOT NULL,
        delivered INTEGER,
        adoption TEXT NOT NULL,
        content_overlap_score REAL,
        task_outcome TEXT NOT NULL,
        reask_outcome TEXT NOT NULL,
        explicit_feedback TEXT,
        confidence REAL NOT NULL,
        evaluated_at TEXT,
        memory_kind TEXT NOT NULL DEFAULT 'unknown',
        delivery_status TEXT NOT NULL DEFAULT 'unknown',
        delivery_evidence TEXT NOT NULL DEFAULT 'none',
        evaluation_window_ms INTEGER,
        evaluation_cutoff TEXT,
        -- Raw memory id and owning project. The event_id column holds a
        -- kind-qualified key for non-event memories (see usefulnessRowKey) so
        -- the primary key below cannot collapse a lesson onto an event that
        -- happens to share its id.
        memory_id TEXT,
        memory_project_id TEXT,
        PRIMARY KEY(trace_id, event_id, observation_kind, evaluator_version)
      );
      CREATE INDEX IF NOT EXISTS idx_usefulness_v2_evaluator_trigger
        ON memory_usefulness_observations_v2(evaluator_version, trigger_type, evaluated_at DESC);

      -- Retrieval trace log (query -> candidates -> selected for context)
      CREATE TABLE IF NOT EXISTS retrieval_traces (
        trace_id TEXT PRIMARY KEY,
        session_id TEXT,
        project_hash TEXT,
        query_text TEXT NOT NULL,
        raw_query_text TEXT,
        query_rewrite_kind TEXT,
        strategy TEXT,
        candidate_event_ids TEXT,
        selected_event_ids TEXT,
        candidate_details_json TEXT,
        selected_details_json TEXT,
        candidate_count INTEGER DEFAULT 0,
        selected_count INTEGER DEFAULT 0,
        confidence TEXT,
        fallback_trace TEXT,
        presentation_mode TEXT NOT NULL DEFAULT 'unknown',
        trigger_type TEXT NOT NULL DEFAULT 'unknown',
        delivery_client TEXT NOT NULL DEFAULT 'unknown',
        outcome_reason TEXT NOT NULL DEFAULT 'unknown',
        retrieval_diagnostics_json TEXT,
        request_id TEXT,
        evaluation_run_id TEXT,
        runtime_version TEXT,
        telemetry_schema_version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Typed references for each trace (specs R1). The legacy id arrays above
      -- stay for old readers; these rows keep the memory kind so lessons are
      -- never mistaken for events.
      CREATE TABLE IF NOT EXISTS retrieval_trace_items (
        trace_id TEXT NOT NULL,
        item_key TEXT NOT NULL,
        memory_kind TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        project_id TEXT,
        rank INTEGER,
        selected INTEGER NOT NULL DEFAULT 0,
        score REAL,
        content_hash TEXT,
        memory_version TEXT,
        deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (trace_id, item_key)
      );

      -- Privacy-safe reference navigation. Target and trace identifiers are
      -- stored without copying source or transcript content.
      CREATE TABLE IF NOT EXISTS retrieval_navigation_events (
        navigation_id TEXT PRIMARY KEY,
        target_event_id TEXT NOT NULL,
        trace_id TEXT,
        delivery_session_id TEXT,
        presentation_mode TEXT NOT NULL DEFAULT 'reference',
        trigger_type TEXT NOT NULL DEFAULT 'unknown',
        memory_kind TEXT NOT NULL DEFAULT 'event',
        navigation_action TEXT NOT NULL,
        navigation_client TEXT NOT NULL DEFAULT 'unknown',
        attribution_outcome TEXT NOT NULL,
        attribution_reason TEXT NOT NULL,
        open_count INTEGER NOT NULL DEFAULT 1,
        first_opened_at TEXT NOT NULL,
        last_opened_at TEXT NOT NULL
      );

      -- Sync position tracking (for SQLite -> DuckDB sync)
      CREATE TABLE IF NOT EXISTS sync_positions (
        target_name TEXT PRIMARY KEY,
        last_event_id TEXT,
        last_timestamp TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Memory Operations: facet assignments (derived, rebuildable projection)
      CREATE TABLE IF NOT EXISTS memory_facets (
        id TEXT PRIMARY KEY,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        dimension TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        source TEXT NOT NULL DEFAULT 'manual',
        evidence_event_ids TEXT NOT NULL DEFAULT '[]',
        project_hash TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(target_type, target_id, dimension, value, source, project_hash)
      );

      -- Memory Operations: operational action projection
      CREATE TABLE IF NOT EXISTS memory_actions (
        action_id TEXT PRIMARY KEY,
        project_hash TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        priority INTEGER NOT NULL DEFAULT 0,
        source_event_ids TEXT NOT NULL DEFAULT '[]',
        related_entity_ids TEXT NOT NULL DEFAULT '[]',
        current_checkpoint_id TEXT,
        lease_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Memory Operations: action dependency/reference edges
      CREATE TABLE IF NOT EXISTS memory_action_edges (
        edge_id TEXT PRIMARY KEY,
        src_action_id TEXT NOT NULL,
        rel_type TEXT NOT NULL,
        dst_type TEXT NOT NULL,
        dst_id TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL,
        UNIQUE(src_action_id, rel_type, dst_type, dst_id, source)
      );

      -- Memory Operations: short-lived leases for operational work
      CREATE TABLE IF NOT EXISTS memory_leases (
        lease_id TEXT PRIMARY KEY,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        holder TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        renewed_at TEXT,
        released_at TEXT
      );

      -- Memory Operations: resumable checkpoints for delegated or long-running work
      CREATE TABLE IF NOT EXISTS memory_checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        project_hash TEXT NOT NULL,
        action_id TEXT,
        session_id TEXT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        state_json TEXT NOT NULL,
        source_event_ids TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        expires_at TEXT
      );

      -- Memory Operations: retention lifecycle score projection
      CREATE TABLE IF NOT EXISTS memory_retention_scores (
        score_id TEXT PRIMARY KEY,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        project_hash TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        decision TEXT NOT NULL,
        lifecycle_score REAL NOT NULL,
        factors_json TEXT NOT NULL,
        reasons_json TEXT NOT NULL,
        dry_run_diff_json TEXT NOT NULL,
        source_event_ids TEXT NOT NULL DEFAULT '[]',
        evaluated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(target_type, target_id, project_hash, policy_version)
      );

      -- Memory Operations: procedural lessons derived from successful workflows
      CREATE TABLE IF NOT EXISTS memory_lessons (
        lesson_id TEXT PRIMARY KEY,
        project_hash TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        trigger TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        source_session_ids TEXT NOT NULL DEFAULT '[]',
        source_event_ids TEXT NOT NULL DEFAULT '[]',
        failure_modes_json TEXT NOT NULL DEFAULT '[]',
        skill_candidate INTEGER NOT NULL DEFAULT 0,
        source_class TEXT NOT NULL DEFAULT 'derived',
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_hash, name)
      );

      -- Perspective Memory: privacy-safe actors/peers
      CREATE TABLE IF NOT EXISTS memory_actors (
        actor_id TEXT PRIMARY KEY,
        project_hash TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        display_name TEXT NOT NULL,
        source TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Perspective Memory: actors participating in a session and observation policy
      CREATE TABLE IF NOT EXISTS session_actors (
        project_hash TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        role_in_session TEXT NOT NULL,
        observe_self INTEGER NOT NULL DEFAULT 1,
        observe_others INTEGER NOT NULL DEFAULT 0,
        joined_at TEXT NOT NULL,
        left_at TEXT,
        metadata_json TEXT,
        PRIMARY KEY(project_hash, session_id, actor_id)
      );

      -- Perspective Memory: compact Honcho-style actor cards
      CREATE TABLE IF NOT EXISTS actor_cards (
        card_id TEXT PRIMARY KEY,
        project_hash TEXT NOT NULL DEFAULT '',
        observer_actor_id TEXT NOT NULL,
        observed_actor_id TEXT NOT NULL,
        entries_json TEXT NOT NULL,
        source_event_ids_json TEXT NOT NULL DEFAULT '[]',
        updated_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_hash, observer_actor_id, observed_actor_id)
      );

      -- Core memory blocks: small, always-injected, agent-editable per-project
      -- resident context (Letta-style core memory), distinct from actor_cards'
      -- per-observer-pair perspective model.
      CREATE TABLE IF NOT EXISTS core_memory_blocks (
        project_hash TEXT NOT NULL DEFAULT '',
        block_key TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        source_event_ids_json TEXT NOT NULL DEFAULT '[]',
        updated_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(project_hash, block_key)
      );

      -- Perspective Memory: observer -> observed claims with evidence pointers
      CREATE TABLE IF NOT EXISTS perspective_observations (
        observation_id TEXT PRIMARY KEY,
        project_hash TEXT NOT NULL DEFAULT '',
        observer_actor_id TEXT NOT NULL,
        observed_actor_id TEXT NOT NULL,
        session_id TEXT,
        level TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL NOT NULL,
        source_event_ids_json TEXT NOT NULL DEFAULT '[]',
        source_observation_ids_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL,
        metadata_json TEXT,
        content_hash TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        UNIQUE(project_hash, observer_actor_id, observed_actor_id, level, content_hash, source_hash)
      );

      -- Memory Assets: project-scoped registry and minimal actor permissions.
      -- Asset content remains in its canonical subsystem; this table owns only
      -- lifecycle, provenance, and access-control metadata.
      CREATE TABLE IF NOT EXISTS memory_assets (
        asset_id TEXT NOT NULL,
        project_hash TEXT NOT NULL DEFAULT '',
        asset_type TEXT NOT NULL,
        title TEXT NOT NULL,
        owner_actor_id TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        visibility TEXT NOT NULL DEFAULT 'private',
        source_refs_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(project_hash, asset_id)
      );

      -- An enabled binding makes a private asset readable/injectable for one
      -- actor. It does not grant write, bind, or delegation authority.
      CREATE TABLE IF NOT EXISTS memory_asset_bindings (
        project_hash TEXT NOT NULL DEFAULT '',
        asset_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        injection_mode TEXT NOT NULL DEFAULT 'reference',
        priority INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(project_hash, asset_id, actor_id),
        FOREIGN KEY(project_hash, asset_id) REFERENCES memory_assets(project_hash, asset_id) ON DELETE CASCADE
      );

      -- Explicit grants are full replacements per asset/actor. An empty JSON
      -- permission list is therefore an auditable revocation tombstone.
      CREATE TABLE IF NOT EXISTS memory_asset_grants (
        project_hash TEXT NOT NULL DEFAULT '',
        asset_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        permissions_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(project_hash, asset_id, actor_id),
        FOREIGN KEY(project_hash, asset_id) REFERENCES memory_assets(project_hash, asset_id) ON DELETE CASCADE
      );

      -- Perspective Memory: FTS5 index for observation content queries.
      -- Use an external-content FTS table so the searchable projection stores the index,
      -- not a second raw copy of private observation text.
      CREATE VIRTUAL TABLE IF NOT EXISTS perspective_observations_fts USING fts5(
        content,
        observation_id UNINDEXED,
        content='perspective_observations',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );

      -- Backfill the FTS table for writable legacy stores that predate the FTS projection.
      INSERT OR IGNORE INTO perspective_observations_fts(rowid, content, observation_id)
      SELECT rowid, content, observation_id FROM perspective_observations;

      CREATE TRIGGER IF NOT EXISTS perspective_observations_fts_insert AFTER INSERT ON perspective_observations BEGIN
        INSERT INTO perspective_observations_fts(rowid, content, observation_id) VALUES (NEW.rowid, NEW.content, NEW.observation_id);
      END;

      CREATE TRIGGER IF NOT EXISTS perspective_observations_fts_delete AFTER DELETE ON perspective_observations BEGIN
        INSERT INTO perspective_observations_fts(perspective_observations_fts, rowid, content, observation_id) VALUES('delete', OLD.rowid, OLD.content, OLD.observation_id);
      END;

      CREATE TRIGGER IF NOT EXISTS perspective_observations_fts_update AFTER UPDATE ON perspective_observations BEGIN
        INSERT INTO perspective_observations_fts(perspective_observations_fts, rowid, content, observation_id) VALUES('delete', OLD.rowid, OLD.content, OLD.observation_id);
        INSERT INTO perspective_observations_fts(rowid, content, observation_id) VALUES (NEW.rowid, NEW.content, NEW.observation_id);
      END;

      -- Memory Operations: governance/audit trail for state-changing operations
      CREATE TABLE IF NOT EXISTS memory_governance_audit (
        audit_id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        actor TEXT NOT NULL,
        project_hash TEXT,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT,
        source_event_ids TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );

      -- Create indexes
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
      -- Serves getRecentEvents' event_type filter. Without it SQLite walks
      -- idx_events_timestamp backwards and evaluates the quarantine predicate
      -- on every visited row; a store holding fewer matching events than the
      -- limit then degrades into a full table scan on the SessionStart path.
      CREATE INDEX IF NOT EXISTS idx_events_type_timestamp ON events(event_type, timestamp);
      CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(entry_type);
      CREATE INDEX IF NOT EXISTS idx_entries_stage ON entries(stage);
      CREATE INDEX IF NOT EXISTS idx_entries_canonical ON entries(canonical_key);
      CREATE INDEX IF NOT EXISTS idx_entities_type_key ON entities(entity_type, canonical_key);
      CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(status);
      CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_id, rel_type);
      CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_id, rel_type);
      CREATE INDEX IF NOT EXISTS idx_edges_rel ON edges(rel_type);
      -- codify-lite session-file lane (Retriever.expandSessionFileLinks) filters
      -- touched_in edges by meta_json.sessionId on every retrieval; without this
      -- expression index the cost grows with total touched_in edge count.
      CREATE INDEX IF NOT EXISTS idx_edges_touched_in_session
        ON edges(json_extract(meta_json, '$.sessionId'))
        WHERE rel_type = 'touched_in';
      CREATE INDEX IF NOT EXISTS idx_outbox_status ON vector_outbox(status);
      CREATE INDEX IF NOT EXISTS idx_outbox_created ON vector_outbox(created_at);
      CREATE INDEX IF NOT EXISTS idx_working_set_expires ON working_set(expires_at);
      CREATE INDEX IF NOT EXISTS idx_working_set_relevance ON working_set(relevance_score);
      CREATE INDEX IF NOT EXISTS idx_consolidated_confidence ON consolidated_memories(confidence);
      CREATE INDEX IF NOT EXISTS idx_continuity_created ON continuity_log(created_at);
      CREATE INDEX IF NOT EXISTS idx_consolidated_rules_confidence ON consolidated_rules(confidence);
      CREATE INDEX IF NOT EXISTS idx_embedding_outbox_status ON embedding_outbox(status);
      CREATE INDEX IF NOT EXISTS idx_helpfulness_event ON memory_helpfulness(event_id);
      CREATE INDEX IF NOT EXISTS idx_helpfulness_session ON memory_helpfulness(session_id);
      CREATE INDEX IF NOT EXISTS idx_helpfulness_score ON memory_helpfulness(helpfulness_score DESC);
      CREATE INDEX IF NOT EXISTS idx_helpfulness_created_at ON memory_helpfulness(created_at);
      CREATE INDEX IF NOT EXISTS idx_helpfulness_measured_at ON memory_helpfulness(measured_at);
      CREATE INDEX IF NOT EXISTS idx_retrieval_traces_created_at ON retrieval_traces(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_retrieval_traces_project_hash ON retrieval_traces(project_hash);
      CREATE INDEX IF NOT EXISTS idx_retrieval_traces_session_id ON retrieval_traces(session_id);

      CREATE INDEX IF NOT EXISTS idx_retrieval_navigation_trace ON retrieval_navigation_events(trace_id);
      CREATE INDEX IF NOT EXISTS idx_retrieval_navigation_target_time ON retrieval_navigation_events(target_event_id, last_opened_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_facets_project_dimension_value ON memory_facets(project_hash, dimension, value);
      CREATE INDEX IF NOT EXISTS idx_memory_facets_target ON memory_facets(target_type, target_id);
      CREATE INDEX IF NOT EXISTS idx_memory_facets_dimension_value_confidence ON memory_facets(dimension, value, confidence DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_actions_project_status_priority ON memory_actions(project_hash, status, priority DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_action_edges_src ON memory_action_edges(src_action_id, rel_type);
      CREATE INDEX IF NOT EXISTS idx_memory_action_edges_dst ON memory_action_edges(dst_type, dst_id);
      CREATE INDEX IF NOT EXISTS idx_memory_leases_target_expires ON memory_leases(target_type, target_id, expires_at);
      CREATE INDEX IF NOT EXISTS idx_memory_checkpoints_project_action_created ON memory_checkpoints(project_hash, action_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_checkpoints_project_session_created ON memory_checkpoints(project_hash, session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_retention_scores_project_decision_score ON memory_retention_scores(project_hash, decision, lifecycle_score ASC, evaluated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_retention_scores_target ON memory_retention_scores(target_type, target_id, project_hash);
      CREATE INDEX IF NOT EXISTS idx_memory_retention_scores_policy_evaluated ON memory_retention_scores(policy_version, evaluated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_lessons_project_confidence ON memory_lessons(project_hash, confidence DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_lessons_skill_candidate ON memory_lessons(project_hash, skill_candidate, confidence DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_lessons_updated ON memory_lessons(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_actors_project_kind ON memory_actors(project_hash, kind, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_actors_source ON memory_actors(source, kind);
      CREATE INDEX IF NOT EXISTS idx_session_actors_session ON session_actors(project_hash, session_id, role_in_session);
      CREATE INDEX IF NOT EXISTS idx_session_actors_actor ON session_actors(actor_id, project_hash, session_id);
      CREATE INDEX IF NOT EXISTS idx_actor_cards_perspective ON actor_cards(project_hash, observer_actor_id, observed_actor_id);
      CREATE INDEX IF NOT EXISTS idx_actor_cards_updated ON actor_cards(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_perspective_observations_perspective_level ON perspective_observations(project_hash, observer_actor_id, observed_actor_id, level, confidence DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_perspective_observations_session ON perspective_observations(project_hash, session_id, level, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_perspective_observations_source_hash ON perspective_observations(project_hash, source_hash);
      CREATE INDEX IF NOT EXISTS idx_perspective_observations_deleted ON perspective_observations(deleted_at);
      CREATE INDEX IF NOT EXISTS idx_memory_assets_project_status ON memory_assets(project_hash, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_assets_owner ON memory_assets(project_hash, owner_actor_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_asset_bindings_actor ON memory_asset_bindings(project_hash, actor_id, enabled, priority DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_asset_grants_actor ON memory_asset_grants(project_hash, actor_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_governance_audit_project_operation ON memory_governance_audit(project_hash, operation, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_governance_audit_target ON memory_governance_audit(target_type, target_id, created_at DESC);

      -- FTS5 Full-Text Search for fast keyword search
      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        content,
        event_id UNINDEXED,
        tokenize='porter unicode61'
      );

      -- Triggers to keep FTS in sync with events table
      CREATE TRIGGER IF NOT EXISTS events_fts_insert AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(rowid, content, event_id) VALUES (NEW.rowid, NEW.content, NEW.id);
      END;

      CREATE TRIGGER IF NOT EXISTS events_fts_delete AFTER DELETE ON events BEGIN
        DELETE FROM events_fts WHERE rowid = OLD.rowid;
      END;

      CREATE TRIGGER IF NOT EXISTS events_fts_update AFTER UPDATE ON events BEGIN
        DELETE FROM events_fts WHERE rowid = OLD.rowid;
        INSERT INTO events_fts(rowid, content, event_id) VALUES (NEW.rowid, NEW.content, NEW.id);
      END;

      -- Reverse index for citation ids (a non-reversible hash of event id), so
      -- citation lookups are O(1) instead of scanning recent events and hashing
      -- each one. Populated lazily/self-healing by getEventByCitationId.
      CREATE TABLE IF NOT EXISTS event_citations (
        event_id TEXT PRIMARY KEY,
        citation_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_event_citations_citation ON event_citations(citation_id);
    `);


    // Best-effort forward migration for action edge source ownership
    this.addColumnIfMissing('memory_action_edges', 'source', `TEXT NOT NULL DEFAULT 'manual'`);
    try {
      const edgeIndexes = sqliteAll<{ name: string; unique: number }>(this.db, `PRAGMA index_list(memory_action_edges)`, []);
      const hasSourceAwareUnique = edgeIndexes.some((index) => {
        if (Number(index.unique) !== 1) return false;
        if (!/^[A-Za-z0-9_]+$/.test(index.name)) return false;
        const escapedName = index.name.replace(/"/g, '""');
        const columns = sqliteAll<{ name: string }>(this.db, 'PRAGMA index_info("' + escapedName + '")', [])
          .map((column) => column.name);
        return columns.length === 5
          && columns[0] === 'src_action_id'
          && columns[1] === 'rel_type'
          && columns[2] === 'dst_type'
          && columns[3] === 'dst_id'
          && columns[4] === 'source';
      });
      if (!hasSourceAwareUnique) {
        sqliteExec(this.db, `
          DROP TABLE IF EXISTS memory_action_edges_v2;
          CREATE TABLE memory_action_edges_v2 (
            edge_id TEXT PRIMARY KEY,
            src_action_id TEXT NOT NULL,
            rel_type TEXT NOT NULL,
            dst_type TEXT NOT NULL,
            dst_id TEXT NOT NULL,
            confidence REAL NOT NULL DEFAULT 1.0,
            source TEXT NOT NULL DEFAULT 'manual',
            created_at TEXT NOT NULL,
            UNIQUE(src_action_id, rel_type, dst_type, dst_id, source)
          );
          INSERT OR IGNORE INTO memory_action_edges_v2 (
            edge_id, src_action_id, rel_type, dst_type, dst_id, confidence, source, created_at
          )
          SELECT edge_id, src_action_id, rel_type, dst_type, dst_id, confidence, source, created_at
          FROM memory_action_edges;
          DROP TABLE memory_action_edges;
          ALTER TABLE memory_action_edges_v2 RENAME TO memory_action_edges;
          CREATE INDEX IF NOT EXISTS idx_memory_action_edges_src ON memory_action_edges(src_action_id, rel_type);
          CREATE INDEX IF NOT EXISTS idx_memory_action_edges_dst ON memory_action_edges(dst_type, dst_id);
        `);
      }
    } catch {
      // action edge table may not exist in partial migrations
    }

    // Best-effort forward migration for helpfulness evidence columns:
    // trace_id links each injected memory back to its retrieval_traces row
    // (question -> memory), content grounding measures whether later
    // assistant responses actually reused the memory's content.
    this.addColumnIfMissing('memory_helpfulness', 'trace_id', 'TEXT');
    this.addColumnIfMissing('memory_helpfulness', 'source', `TEXT DEFAULT 'user_prompt'`);
    this.addColumnIfMissing('memory_helpfulness', 'content_overlap_score', 'REAL');
    this.addColumnIfMissing('memory_helpfulness', 'evidence_json', 'TEXT');
    this.addColumnIfMissing('memory_helpfulness', 'injected_content', 'TEXT');
    this.addColumnIfMissing('memory_helpfulness', 'presentation_mode', `TEXT NOT NULL DEFAULT 'unknown'`);
    this.addColumnIfMissing('memory_helpfulness', 'trigger_type', `TEXT NOT NULL DEFAULT 'unknown'`);
    this.addColumnIfMissing('memory_helpfulness', 'delivery_client', `TEXT NOT NULL DEFAULT 'unknown'`);
    try {
      sqliteExec(this.db, `CREATE INDEX IF NOT EXISTS idx_helpfulness_trace ON memory_helpfulness(trace_id);`);
    } catch {
      // index/table may not exist in partial migrations
    }

    // Best-effort forward migration for retrieval trace detail columns
    this.addColumnIfMissing('retrieval_traces', 'selected_details_json', 'TEXT');
    this.addColumnIfMissing('retrieval_traces', 'candidate_details_json', 'TEXT');
    this.addColumnIfMissing('retrieval_traces', 'raw_query_text', 'TEXT');
    this.addColumnIfMissing('retrieval_traces', 'query_rewrite_kind', 'TEXT');
    this.addColumnIfMissing('retrieval_traces', 'presentation_mode', `TEXT NOT NULL DEFAULT 'unknown'`);
    this.addColumnIfMissing('retrieval_traces', 'trigger_type', `TEXT NOT NULL DEFAULT 'unknown'`);
    this.addColumnIfMissing('retrieval_traces', 'delivery_client', `TEXT NOT NULL DEFAULT 'unknown'`);
    // Legacy stores keep 'runtime_error' as the column default so their
    // existing rows are unchanged; readers present those as
    // `legacy_unclassified` instead of re-classifying them (specs R2).
    this.addColumnIfMissing('retrieval_traces', 'outcome_reason', `TEXT NOT NULL DEFAULT 'runtime_error'`);
    this.addColumnIfMissing('retrieval_traces', 'retrieval_diagnostics_json', 'TEXT');
    this.addColumnIfMissing('retrieval_traces', 'request_id', 'TEXT');
    this.addColumnIfMissing('retrieval_traces', 'evaluation_run_id', 'TEXT');
    this.addColumnIfMissing('retrieval_traces', 'runtime_version', 'TEXT');
    this.addColumnIfMissing('retrieval_traces', 'telemetry_schema_version', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('memory_helpfulness', 'memory_kind', `TEXT NOT NULL DEFAULT 'unknown'`);
    this.addColumnIfMissing('retrieval_navigation_events', 'memory_kind', `TEXT NOT NULL DEFAULT 'event'`);
    this.addColumnIfMissing('retrieval_navigation_events', 'memory_project_id', 'TEXT');
    this.addColumnIfMissing('memory_helpfulness', 'delivery_status', `TEXT NOT NULL DEFAULT 'unknown'`);
    this.addColumnIfMissing('memory_helpfulness', 'delivery_evidence', `TEXT NOT NULL DEFAULT 'none'`);
    this.addColumnIfMissing('memory_helpfulness', 'delivered_at', 'TEXT');
    this.addColumnIfMissing('memory_usefulness_observations_v2', 'memory_kind', `TEXT NOT NULL DEFAULT 'unknown'`);
    this.addColumnIfMissing('memory_usefulness_observations_v2', 'delivery_status', `TEXT NOT NULL DEFAULT 'unknown'`);
    this.addColumnIfMissing('memory_usefulness_observations_v2', 'delivery_evidence', `TEXT NOT NULL DEFAULT 'none'`);
    this.addColumnIfMissing('memory_usefulness_observations_v2', 'evaluation_window_ms', 'INTEGER');
    this.addColumnIfMissing('memory_usefulness_observations_v2', 'evaluation_cutoff', 'TEXT');
    // The raw memory id, kept beside the primary-key column. `event_id` has to
    // carry a kind-qualified key for non-event memories so an event and a
    // lesson sharing an id cannot overwrite each other on the existing primary
    // key; `memory_id` is what a reader joins on (specs R1, finding 2).
    this.addColumnIfMissing('memory_usefulness_observations_v2', 'memory_id', 'TEXT');
    this.addColumnIfMissing('memory_usefulness_observations_v2', 'memory_project_id', 'TEXT');
    this.addColumnIfMissing('memory_helpfulness', 'memory_project_id', 'TEXT');
    try {
      // Typed trace items are additive: an older store gains the table without
      // any change to the arrays its existing readers use.
      ensureRetrievalTraceItemsSchema(this.db);
      // Indexed only after the column migration above, so a legacy store that
      // predates request_id is not asked to index a column it lacks.
      sqliteExec(this.db, `CREATE INDEX IF NOT EXISTS idx_retrieval_traces_request_id ON retrieval_traces(request_id);`);
    } catch {
      // Partial migrations must not block store startup.
    }
    try {
      // One request must map to one trace even when two processes write at the
      // same moment. The partial index leaves the pre-existing rows with a NULL
      // request id untouched (specs R2, finding 9).
      sqliteExec(
        this.db,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_retrieval_traces_request_id_unique
           ON retrieval_traces(request_id) WHERE request_id IS NOT NULL;`
      );
    } catch {
      // A store that already contains duplicate request ids cannot take the
      // unique index. Leave its history intact: the transaction in
      // recordRetrievalTrace still serializes this process's own writers.
    }

    // Explicit curation reuses the existing lesson artifact while preserving
    // whether the item came from a reviewed/manual capture or a derivation.
    this.addColumnIfMissing('memory_lessons', 'source_class', `TEXT NOT NULL DEFAULT 'derived'`);
    // A lesson access used to be written against events.access_count, where it
    // matched no row and was silently lost. The typed access path now records
    // it here instead (specs R1).
    this.addColumnIfMissing('memory_lessons', 'access_count', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('memory_lessons', 'last_accessed_at', 'TEXT');
    try {
      sqliteExec(this.db, `CREATE INDEX IF NOT EXISTS idx_memory_lessons_project_source_class ON memory_lessons(project_hash, source_class, updated_at DESC);`);
    } catch {
      // index/table may not exist in partial migrations
    }
    try {
      sqliteExec(this.db, `CREATE INDEX IF NOT EXISTS idx_retrieval_traces_query_rewrite_kind ON retrieval_traces(query_rewrite_kind);`);
    } catch {
      // index/table may not exist in partial migrations
    }

    // Forward-migrate the events table columns added over time. turn_id groups
    // events within a conversation turn; access_count/last_accessed_at back
    // access analytics.
    this.addColumnIfMissing('events', 'access_count', 'INTEGER DEFAULT 0');
    this.addColumnIfMissing('events', 'last_accessed_at', 'TEXT');
    this.addColumnIfMissing('events', 'turn_id', 'TEXT');

    // Create indexes for new columns if they don't exist
    try {
      sqliteExec(this.db, `
        CREATE INDEX IF NOT EXISTS idx_events_access_count ON events(access_count DESC);
      `);
    } catch (err: any) {
      // Index may already exist, ignore
    }

    try {
      sqliteExec(this.db, `
        CREATE INDEX IF NOT EXISTS idx_events_last_accessed ON events(last_accessed_at DESC);
      `);
    } catch (err: any) {
      // Index may already exist, ignore
    }

    try {
      sqliteExec(this.db, `
        CREATE INDEX IF NOT EXISTS idx_events_turn_id ON events(turn_id);
      `);
    } catch {
      // Index may already exist, ignore
    }

    // One-time backfill of the consolidated_memory_events junction from existing
    // source_events JSON (idempotent; skipped once the junction has any rows).
    const cmeCount = sqliteGet<{ c: number }>(this.db, `SELECT COUNT(*) as c FROM consolidated_memory_events`, []);
    if ((cmeCount?.c ?? 0) === 0) {
      sqliteExec(this.db, `
        INSERT OR IGNORE INTO consolidated_memory_events (memory_id, event_id)
        SELECT cm.memory_id, je.value
        FROM consolidated_memories cm, json_each(cm.source_events) je
        WHERE json_valid(cm.source_events);
      `);
    }

    // Stamp the schema version so future ordered migrations have an anchor to
    // gate on (PRAGMA user_version persists in the DB file). The migrations
    // above remain idempotent, so this is forward-looking rather than required.
    sqliteExec(this.db, `PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);

    this.initialized = true;
  }

  /**
   * Append event to store (Append-only, Idempotent)
   */
  async append(input: MemoryEventInput): Promise<AppendResult> {
    await this.initialize();

    const canonicalKey = makeCanonicalKey(input.content);
    const dedupeKey = makeDedupeKey(input.content, input.sessionId);

    // Check for duplicate
    const existing = sqliteGet<{ event_id: string }>(
      this.db,
      `SELECT event_id FROM event_dedup WHERE dedupe_key = ?`,
      [dedupeKey]
    );

    if (existing) {
      try {
        await this.enqueueVectorOutboxEvent(existing.event_id, input.eventType);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
      return {
        success: true,
        eventId: existing.event_id,
        isDuplicate: true
      };
    }

    const id = randomUUID();
    const timestamp = toSQLiteTimestamp(input.timestamp);

    try {
      // Extract turnId from metadata if present
      const metadata = input.metadata || {};
      const turnId = (metadata.turnId as string) || null;

      // Use transaction for atomicity
      const insertEvent = this.db.prepare(`
        INSERT INTO events (id, event_type, session_id, timestamp, content, canonical_key, dedupe_key, metadata, turn_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertDedup = this.db.prepare(`
        INSERT INTO event_dedup (dedupe_key, event_id) VALUES (?, ?)
      `);

      const insertLevel = this.db.prepare(`
        INSERT INTO memory_levels (event_id, level) VALUES (?, 'L0')
      `);

      const transaction = this.db.transaction(() => {
        insertEvent.run(
          id,
          input.eventType,
          input.sessionId,
          timestamp,
          input.content,
          canonicalKey,
          dedupeKey,
          JSON.stringify(metadata),
          turnId
        );
        insertDedup.run(dedupeKey, id);
        insertLevel.run(id);
        this.enqueueVectorOutboxEventSync(id, input.eventType);
      });

      transaction();

      if (this.markdownMirror) {
        const event: MemoryEvent = {
          id,
          eventType: input.eventType,
          sessionId: input.sessionId,
          timestamp: input.timestamp,
          content: input.content,
          canonicalKey,
          dedupeKey,
          metadata
        };
        this.markdownMirror.append(event).catch((err) => {
          console.warn('[SQLiteEventStore] markdown mirror append failed:', err);
        });
      }

      return { success: true, eventId: id, isDuplicate: false };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Get session IDs that have events but no session_summary event.
   * Used to backfill summaries for sessions that ended without Stop hook.
   */
  async getSessionsWithoutSummary(currentSessionId: string, limit = 5): Promise<string[]> {
    await this.initialize();
    const rows = sqliteAll<{ session_id: string }>(
      this.db,
      `SELECT DISTINCT e.session_id
       FROM events e
       WHERE e.session_id != ?
         AND e.event_type != 'session_summary'
         AND e.session_id NOT IN (
           SELECT DISTINCT session_id FROM events WHERE event_type = 'session_summary'
         )
       GROUP BY e.session_id
       HAVING COUNT(*) >= 3
       ORDER BY MAX(e.timestamp) DESC
       LIMIT ?`,
      [currentSessionId, limit]
    );
    return rows.map((r) => r.session_id);
  }

  /**
   * Get events by session ID
   */
  async getSessionEvents(sessionId: string, options?: QuarantineReadOptions): Promise<MemoryEvent[]> {
    await this.initialize();

    const rows = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM events WHERE session_id = ? AND ${maybeQuarantinePredicate(options)} ORDER BY timestamp ASC`,
      [sessionId]
    );

    return rows.map(this.rowToEvent);
  }

  /**
   * Get recent events, optionally restricted to a set of event types.
   *
   * The type filter exists because tool_observation is the overwhelming
   * majority of a real store (~84%). Callers that only want narrative events
   * would otherwise have to over-fetch by an order of magnitude — and load
   * every large tool payload along the way — just to reach a handful of
   * summaries.
   */
  async getRecentEvents(limit: number = 100, options?: RecentEventsReadOptions): Promise<MemoryEvent[]> {
    await this.initialize();

    const eventTypes = options?.eventTypes ?? [];
    const typePredicate = eventTypes.length > 0
      ? `AND event_type IN (${eventTypes.map(() => '?').join(', ')})`
      : '';

    const rows = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM events
       WHERE ${maybeQuarantinePredicate(options)} ${typePredicate}
       ORDER BY timestamp DESC LIMIT ?`,
      [...eventTypes, limit]
    );

    return rows.map(this.rowToEvent);
  }

  /**
   * Aggregate event counts by type via SQL GROUP BY, instead of loading rows
   * into memory and counting in JS. Counts all events (the old recent-window
   * scan also under-counted stores larger than its cap).
   */
  async getEventTypeCounts(options?: QuarantineReadOptions): Promise<Array<{ eventType: string; count: number }>> {
    await this.initialize();
    const rows = sqliteAll<{ event_type: string; count: number }>(
      this.db,
      `SELECT event_type, COUNT(*) as count FROM events WHERE ${maybeQuarantinePredicate(options)} GROUP BY event_type`,
      []
    );
    return rows.map((row) => ({ eventType: row.event_type, count: row.count }));
  }

  /**
   * Fetch every event at/after an ISO timestamp (ascending), with no row cap.
   * For window-scoped analytics (KPI/usefulness) this fetches exactly the events
   * the window needs instead of an arbitrary "most recent N" slice that both
   * over-fetches sparse windows and truncates very active ones.
   */
  async getEventsAfter(sinceIso: string, options?: QuarantineReadOptions): Promise<MemoryEvent[]> {
    await this.initialize();
    const rows = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM events WHERE timestamp >= ? AND ${maybeQuarantinePredicate(options)} ORDER BY timestamp ASC`,
      [sinceIso]
    );
    return rows.map((row) => this.rowToEvent(row));
  }

  /** Count distinct sessions via SQL instead of materializing a Set in JS. */
  async getDistinctSessionCount(options?: QuarantineReadOptions): Promise<number> {
    await this.initialize();
    const row = sqliteGet<{ count: number }>(
      this.db,
      `SELECT COUNT(DISTINCT session_id) as count FROM events WHERE ${maybeQuarantinePredicate(options)}`,
      []
    );
    return row?.count ?? 0;
  }

  /**
   * Per-day event counts (with type breakdown) since an ISO timestamp, computed
   * by SQL GROUP BY on the date prefix. Timestamps are stored as ISO-8601
   * strings, so substr(...,1,10) is the UTC day and `timestamp >= ?` compares
   * lexicographically.
   */
  async getDailyEventCounts(
    sinceIso: string,
    options?: QuarantineReadOptions
  ): Promise<Array<{ day: string; total: number; prompts: number; responses: number; tools: number }>> {
    await this.initialize();
    return sqliteAll<{ day: string; total: number; prompts: number; responses: number; tools: number }>(
      this.db,
      `SELECT substr(timestamp, 1, 10) as day,
              COUNT(*) as total,
              SUM(CASE WHEN event_type = 'user_prompt' THEN 1 ELSE 0 END) as prompts,
              SUM(CASE WHEN event_type = 'agent_response' THEN 1 ELSE 0 END) as responses,
              SUM(CASE WHEN event_type = 'tool_observation' THEN 1 ELSE 0 END) as tools
       FROM events
       WHERE timestamp >= ? AND ${maybeQuarantinePredicate(options)}
       GROUP BY day
       ORDER BY day ASC`,
      [sinceIso]
    );
  }

  /**
   * Get event by ID
   */
  async getEvent(id: string, options?: QuarantineReadOptions): Promise<MemoryEvent | null> {
    await this.initialize();

    const row = sqliteGet<Record<string, unknown>>(
      this.db,
      `SELECT * FROM events WHERE id = ? AND ${maybeQuarantinePredicate(options)}`,
      [id]
    );

    if (!row) return null;
    return this.rowToEvent(row);
  }

  /**
   * Batch-fetch events by id in a single query, applying the same quarantine
   * predicate as getEvent. Lets hot paths replace N sequential round-trips with
   * one. Missing ids are simply absent from the result (order not guaranteed).
   */
  async getEvents(ids: string[], options?: QuarantineReadOptions): Promise<MemoryEvent[]> {
    await this.initialize();
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    const rows = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM events WHERE id IN (${placeholders}) AND ${maybeQuarantinePredicate(options)}`,
      ids
    );

    return rows.map((row) => this.rowToEvent(row));
  }

  /**
   * Resolve an event from its citation id via the reverse index, instead of
   * scanning recent events and hashing each one. The index is self-healing: a
   * miss triggers a one-time backfill of any events not yet indexed (covering
   * freshly appended events) before retrying.
   */
  async getEventByCitationId(citationId: string, options?: QuarantineReadOptions): Promise<MemoryEvent | null> {
    await this.initialize();
    if (!citationId) return null;

    let row = sqliteGet<{ event_id: string }>(
      this.db,
      `SELECT event_id FROM event_citations WHERE citation_id = ? LIMIT 1`,
      [citationId]
    );

    if (!row) {
      this.indexMissingCitations();
      row = sqliteGet<{ event_id: string }>(
        this.db,
        `SELECT event_id FROM event_citations WHERE citation_id = ? LIMIT 1`,
        [citationId]
      );
    }

    if (!row) return null;
    return this.getEvent(row.event_id, options);
  }

  /**
   * Backfill citation ids for any events not yet present in event_citations.
   * Gated on a cheap count comparison so the common (fully-indexed) path does no
   * work, and the scan only runs when there are genuinely new events to index.
   */
  private indexMissingCitations(): void {
    const eventCount = sqliteGet<{ c: number }>(this.db, `SELECT COUNT(*) as c FROM events`, [])?.c ?? 0;
    const indexedCount = sqliteGet<{ c: number }>(this.db, `SELECT COUNT(*) as c FROM event_citations`, [])?.c ?? 0;
    if (indexedCount >= eventCount) return;

    const unindexed = sqliteAll<{ id: string }>(
      this.db,
      `SELECT e.id FROM events e
       LEFT JOIN event_citations ec ON ec.event_id = e.id
       WHERE ec.event_id IS NULL`,
      []
    );
    if (unindexed.length === 0) return;

    const insert = this.db.prepare(`INSERT OR IGNORE INTO event_citations (event_id, citation_id) VALUES (?, ?)`);
    this.db.transaction(() => {
      for (const { id } of unindexed) {
        insert.run(id, generateCitationId(id));
      }
    })();
  }

  /**
   * Get events since a timestamp (for sync)
   */
  async getEventsSince(timestamp: string, limit: number = 1000, options?: QuarantineReadOptions): Promise<MemoryEvent[]> {
    await this.initialize();

    const rows = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM events WHERE timestamp > ? AND ${maybeQuarantinePredicate(options)} ORDER BY timestamp ASC LIMIT ?`,
      [timestamp, limit]
    );

    return rows.map(this.rowToEvent);
  }

  /**
   * Get events since a SQLite rowid (for robust incremental replication).
   * Rowid is monotonic for append-only tables, independent of client timestamps.
   */
  async getEventsSinceRowid(
    lastRowid: number,
    limit: number = 1000,
    options?: QuarantineReadOptions
  ): Promise<Array<{ rowid: number; event: MemoryEvent }>> {
    await this.initialize();

    const rows = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT rowid as _rowid, * FROM events WHERE rowid > ? AND ${maybeQuarantinePredicate(options)} ORDER BY rowid ASC LIMIT ?`,
      [lastRowid, limit]
    );

    return rows.map(row => ({
      rowid: row._rowid as number,
      event: this.rowToEvent(row)
    }));
  }

  /**
   * Import events with fixed IDs (used for cross-machine replication).
   * Idempotent: skips if event id or dedupeKey already exists.
   *
   * NOTE: This bypasses the append() id generation to preserve stable IDs.
   */
  async importEvents(events: MemoryEvent[]): Promise<{ inserted: number; skipped: number }> {
    if (events.length === 0) return { inserted: 0, skipped: 0 };
    if (this.readOnly) return { inserted: 0, skipped: events.length };

    await this.initialize();

    const getById = this.db.prepare(`SELECT id FROM events WHERE id = ?`);
    const getByDedupe = this.db.prepare(`SELECT event_id FROM event_dedup WHERE dedupe_key = ?`);

    const insertEvent = this.db.prepare(`
      INSERT INTO events (id, event_type, session_id, timestamp, content, canonical_key, dedupe_key, metadata, turn_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertDedup = this.db.prepare(`
      INSERT INTO event_dedup (dedupe_key, event_id) VALUES (?, ?)
    `);

    const insertLevel = this.db.prepare(`
      INSERT INTO memory_levels (event_id, level) VALUES (?, 'L0')
    `);

    let inserted = 0;
    let skipped = 0;
    const insertedEvents: MemoryEvent[] = [];

    const tx = this.db.transaction((batch: MemoryEvent[]) => {
      for (const ev of batch) {
        // Skip if already present by id
        const existingById = getById.get(ev.id) as { id: string } | undefined;
        if (existingById) {
          skipped++;
          continue;
        }

        const canonicalKey = ev.canonicalKey || makeCanonicalKey(ev.content);
        const dedupeKey = ev.dedupeKey || makeDedupeKey(ev.content, ev.sessionId);

        // Skip if already present by dedupe key
        const existingByDedupe = getByDedupe.get(dedupeKey) as { event_id: string } | undefined;
        if (existingByDedupe) {
          skipped++;
          continue;
        }

        const metadata = ev.metadata || {};
        const turnId = (metadata as any).turnId as string | undefined;

        insertEvent.run(
          ev.id,
          ev.eventType,
          ev.sessionId,
          toSQLiteTimestamp(ev.timestamp),
          ev.content,
          canonicalKey,
          dedupeKey,
          JSON.stringify(metadata),
          turnId ?? null
        );

        insertDedup.run(dedupeKey, ev.id);
        insertLevel.run(ev.id);
        this.enqueueVectorOutboxEventSync(ev.id, ev.eventType);
        inserted++;
        insertedEvents.push(ev);
      }
    });

    tx(events);

    if (this.markdownMirror && insertedEvents.length > 0) {
      for (const ev of insertedEvents) {
        this.markdownMirror.append(ev).catch((err) => {
          console.warn('[SQLiteEventStore] markdown mirror append failed:', err);
        });
      }
    }

    return { inserted, skipped };
  }

  /**
   * Create or update session
   */
  async upsertSession(session: Partial<Session> & { id: string }): Promise<void> {
    await this.initialize();

    const existing = sqliteGet<{ id: string }>(
      this.db,
      `SELECT id FROM sessions WHERE id = ?`,
      [session.id]
    );

    if (!existing) {
      sqliteRun(
        this.db,
        `INSERT INTO sessions (id, started_at, project_path, tags)
         VALUES (?, ?, ?, ?)`,
        [
          session.id,
          toSQLiteTimestamp(session.startedAt || new Date()),
          session.projectPath || null,
          JSON.stringify(session.tags || [])
        ]
      );
    } else {
      const updates: string[] = [];
      const values: unknown[] = [];

      if (session.endedAt) {
        updates.push('ended_at = ?');
        values.push(toSQLiteTimestamp(session.endedAt));
      }
      if (session.summary) {
        updates.push('summary = ?');
        values.push(session.summary);
      }
      if (session.tags) {
        updates.push('tags = ?');
        values.push(JSON.stringify(session.tags));
      }

      if (updates.length > 0) {
        values.push(session.id);
        sqliteRun(
          this.db,
          `UPDATE sessions SET ${updates.join(', ')} WHERE id = ?`,
          values
        );
      }
    }
  }

  /**
   * Get session by ID
   */
  async getSession(id: string): Promise<Session | null> {
    await this.initialize();

    const row = sqliteGet<Record<string, unknown>>(
      this.db,
      `SELECT * FROM sessions WHERE id = ?`,
      [id]
    );

    if (!row) return null;

    return {
      id: row.id as string,
      startedAt: toDateFromSQLite(row.started_at),
      endedAt: row.ended_at ? toDateFromSQLite(row.ended_at) : undefined,
      projectPath: row.project_path as string | undefined,
      summary: row.summary as string | undefined,
      tags: row.tags ? JSON.parse(row.tags as string) : undefined
    };
  }

  /**
   * Get all sessions
   */
  async getAllSessions(): Promise<Session[]> {
    await this.initialize();

    const rows = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM sessions ORDER BY started_at DESC`
    );

    return rows.map(row => ({
      id: row.id as string,
      startedAt: toDateFromSQLite(row.started_at),
      endedAt: row.ended_at ? toDateFromSQLite(row.ended_at) : undefined,
      projectPath: row.project_path as string | undefined,
      summary: row.summary as string | undefined,
      tags: row.tags ? JSON.parse(row.tags as string) : undefined
    }));
  }

  /**
   * Add to embedding outbox
   */
  async enqueueForEmbedding(eventId: string, content: string): Promise<string> {
    await this.initialize();

    const id = randomUUID();
    sqliteRun(
      this.db,
      `INSERT INTO embedding_outbox (id, event_id, content, status, retry_count)
       VALUES (?, ?, ?, 'pending', 0)`,
      [id, eventId, content]
    );

    return id;
  }

  /**
   * Get pending outbox items
   */
  async getPendingOutboxItems(limit: number = 32): Promise<OutboxItem[]> {
    await this.initialize();

    // Claim pending items atomically in a single UPDATE ... RETURNING. A
    // SELECT-then-UPDATE leaves a window where two concurrent workers (or a
    // worker plus processAll) both select the same rows before either marks them
    // 'processing', producing duplicate embedding work. The single statement
    // makes the claim race-free, matching VectorOutbox.claimJobs.
    const claimed = sqliteAll<Record<string, unknown>>(
      this.db,
      `UPDATE embedding_outbox
       SET status = 'processing', processed_at = datetime('now'), error_message = NULL
       WHERE id IN (
         SELECT id FROM embedding_outbox
         WHERE status = 'pending'
         ORDER BY created_at
         LIMIT ?
       )
       RETURNING *`,
      [limit]
    );

    if (claimed.length === 0) return [];

    // RETURNING does not guarantee row order; restore created_at ordering.
    claimed.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

    return claimed.map(row => ({
      id: row.id as string,
      eventId: row.event_id as string,
      content: row.content as string,
      status: 'processing' as const,
      retryCount: row.retry_count as number,
      createdAt: toDateFromSQLite(row.created_at),
      errorMessage: row.error_message as string | undefined
    }));
  }

  /**
   * Mark outbox items as done
   */
  async completeOutboxItems(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const placeholders = ids.map(() => '?').join(',');
    sqliteRun(
      this.db,
      `DELETE FROM embedding_outbox WHERE id IN (${placeholders})`,
      ids
    );
  }

  /**
   * Clear embedding outbox (used for embedding model migration)
   */
  async clearEmbeddingOutbox(): Promise<void> {
    await this.initialize();
    sqliteRun(this.db, `DELETE FROM embedding_outbox`);
  }

  /**
   * Count total events
   */
  async countEvents(options?: QuarantineReadOptions): Promise<number> {
    await this.initialize();
    const row = sqliteGet<{ count: number }>(this.db, `SELECT COUNT(*) as count FROM events WHERE ${maybeQuarantinePredicate(options)}`);
    return row?.count || 0;
  }

  /**
   * Get events page in timestamp ascending order (stable migration/reindex scans)
   */
  async getEventsPage(limit: number = 1000, offset: number = 0, options?: QuarantineReadOptions): Promise<MemoryEvent[]> {
    await this.initialize();

    const rows = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM events WHERE ${maybeQuarantinePredicate(options)} ORDER BY timestamp ASC LIMIT ? OFFSET ?`,
      [limit, offset]
    );

    return rows.map(this.rowToEvent);
  }

  /**
   * Mark outbox items as failed
   */
  async failOutboxItems(ids: string[], error: string): Promise<void> {
    if (ids.length === 0) return;

    const placeholders = ids.map(() => '?').join(',');
    sqliteRun(
      this.db,
      `UPDATE embedding_outbox
       SET status = CASE WHEN retry_count >= 3 THEN 'failed' ELSE 'pending' END,
           retry_count = retry_count + 1,
           error_message = ?
       WHERE id IN (${placeholders})`,
      [error, ...ids]
    );
  }

  /**
   * Recover abandoned outbox work after a worker/process crash.
   *
   * Rows in `processing` are claimed work. If the process exits before marking
   * them done/failed, they otherwise remain invisible to future processing.
   * Recovery is deliberately age-gated so an active worker is not disturbed.
   */
  async recoverStuckOutboxItems(options: OutboxRecoveryOptions = {}): Promise<OutboxRecoveryResult> {
    await this.initialize();

    const thresholdMs = Number.isFinite(options.stuckThresholdMs) && (options.stuckThresholdMs ?? 0) >= 0
      ? options.stuckThresholdMs!
      : DEFAULT_OUTBOX_STUCK_THRESHOLD_MS;
    const maxRetries = Number.isFinite(options.maxRetries) && (options.maxRetries ?? 0) > 0
      ? options.maxRetries!
      : DEFAULT_OUTBOX_MAX_RETRIES;
    const now = options.now ?? new Date();
    const threshold = new Date(now.getTime() - thresholdMs).toISOString();
    const result = emptyOutboxRecoveryResult();

    if (options.dryRun === true) {
      const embeddingRecovered = sqliteGet<{ count: number }>(
        this.db,
        `SELECT COUNT(*) AS count FROM embedding_outbox
         WHERE status = 'processing'
           AND datetime(COALESCE(processed_at, created_at)) < datetime(?)`,
        [threshold]
      );
      result.embedding.recoveredProcessing = Number(embeddingRecovered?.count ?? 0);

      const embeddingRetried = sqliteGet<{ count: number }>(
        this.db,
        `SELECT COUNT(*) AS count FROM embedding_outbox
         WHERE status = 'failed'
           AND retry_count < ?`,
        [maxRetries]
      );
      result.embedding.retriedFailed = Number(embeddingRetried?.count ?? 0);

      const vectorRecovered = sqliteGet<{ count: number }>(
        this.db,
        `SELECT COUNT(*) AS count FROM vector_outbox
         WHERE status = 'processing'
           AND datetime(updated_at) < datetime(?)`,
        [threshold]
      );
      result.vector.recoveredProcessing = Number(vectorRecovered?.count ?? 0);

      const vectorRetried = sqliteGet<{ count: number }>(
        this.db,
        `SELECT COUNT(*) AS count FROM vector_outbox
         WHERE status = 'failed'
           AND retry_count < ?`,
        [maxRetries]
      );
      result.vector.retriedFailed = Number(vectorRetried?.count ?? 0);

      return result;
    }

    const embeddingRecovered = sqliteRun(
      this.db,
      `UPDATE embedding_outbox
       SET status = 'pending', processed_at = NULL, error_message = NULL
       WHERE status = 'processing'
         AND datetime(COALESCE(processed_at, created_at)) < datetime(?)`,
      [threshold]
    );
    result.embedding.recoveredProcessing = Number(embeddingRecovered.changes ?? 0);

    const embeddingRetried = sqliteRun(
      this.db,
      `UPDATE embedding_outbox
       SET status = 'pending', error_message = NULL
       WHERE status = 'failed'
         AND retry_count < ?`,
      [maxRetries]
    );
    result.embedding.retriedFailed = Number(embeddingRetried.changes ?? 0);

    const vectorRecovered = sqliteRun(
      this.db,
      `UPDATE vector_outbox
       SET status = 'pending', updated_at = ?, error = NULL
       WHERE status = 'processing'
         AND datetime(updated_at) < datetime(?)`,
      [now.toISOString(), threshold]
    );
    result.vector.recoveredProcessing = Number(vectorRecovered.changes ?? 0);

    const vectorRetried = sqliteRun(
      this.db,
      `UPDATE vector_outbox
       SET status = 'pending', updated_at = ?, error = NULL
       WHERE status = 'failed'
         AND retry_count < ?`,
      [now.toISOString(), maxRetries]
    );
    result.vector.retriedFailed = Number(vectorRetried.changes ?? 0);

    return result;
  }


  /**
   * List event IDs for a given event type (used by maintenance/backfill tooling).
   */
  async listEventIdsByType(eventType: string): Promise<string[]> {
    await this.initialize();
    const rows = sqliteAll<{ id: string }>(
      this.db,
      `SELECT id FROM events WHERE event_type = ? ORDER BY timestamp ASC`,
      [eventType]
    );
    return rows.map((row) => row.id);
  }

  /**
   * Remove vector_outbox rows for the given event ids (item_kind = 'event').
   * Used after pruning already-embedded vectors so the outbox stops reporting
   * them as done work.
   */
  async removeVectorOutboxRowsForEventIds(eventIds: string[]): Promise<number> {
    if (eventIds.length === 0) return 0;
    await this.initialize();
    const placeholders = eventIds.map(() => '?').join(', ');
    const result = this.db.prepare(
      `DELETE FROM vector_outbox WHERE item_kind = 'event' AND item_id IN (${placeholders})`
    ).run(...eventIds);
    return Number(result.changes ?? 0);
  }

  /**
   * Repair legacy imported events that predate canonical project scope metadata.
   *
   * Same-project legacy rows are tagged with scope.project.hash. Rows that look
   * imported but cannot be proven to belong to this project are quarantined so
   * dashboard default reads/search do not surface cross-project contamination.
   */
  async repairLegacyProjectScope(options: ProjectScopeRepairOptions = {}): Promise<ProjectScopeRepairResult> {
    await this.initialize();

    const projectHash = options.projectHash || (options.projectPath ? hashProjectPath(options.projectPath) : undefined);
    if (!projectHash) {
      throw new Error('repairLegacyProjectScope requires projectPath or projectHash');
    }
    if (
      options.projectPath && options.projectHash
      && hashProjectPath(options.projectPath) !== options.projectHash
      // A store created before a .claude-memory-root marker was adopted is
      // keyed by the pre-marker (git-only) hash; addressing it by path + that
      // hash is consistent, not a different store.
      && hashProjectPathIgnoringMarker(options.projectPath) !== options.projectHash
    ) {
      throw new Error('repairLegacyProjectScope projectPath and projectHash refer to different project stores');
    }

    const dryRun = options.dryRun === true;
    const nowIso = (options.now || new Date()).toISOString();
    const result = buildRepairResult(projectHash, dryRun);

    const rows = sqliteAll<{
      id: string;
      content: string;
      metadata: string | null;
      session_project_path: string | null;
    }>(
      this.db,
      `SELECT e.id, e.content, e.metadata, s.project_path as session_project_path
       FROM events e
       LEFT JOIN sessions s ON s.id = e.session_id
       ORDER BY e.timestamp ASC`,
      []
    );

    const sample = (entry: ProjectScopeRepairSample) => {
      if (result.samples.length < 20) result.samples.push(entry);
    };

    for (const row of rows) {
      result.scanned++;

      let metadata: Record<string, unknown> = {};
      let metadataParseInvalid = false;
      if (row.metadata) {
        const parsed = safeParseMetadataValue(row.metadata);
        if (parsed) {
          metadata = parsed;
        } else {
          metadataParseInvalid = true;
        }
      }

      if (isActiveQuarantinedMetadata(metadata)) {
        result.skipped++;
        continue;
      }

      const currentHash = metadataProjectHash(metadata);
      const explicitPath = metadataProjectPath(metadata);
      const sessionProjectPath = typeof row.session_project_path === 'string' && row.session_project_path.length > 0
        ? row.session_project_path
        : undefined;
      const candidatePaths = metadataProjectPaths(metadata);
      if (sessionProjectPath && !candidatePaths.includes(sessionProjectPath)) {
        candidatePaths.push(sessionProjectPath);
      }
      const importedOrLegacy = metadataParseInvalid || isImportedOrLegacyScopedMetadata(metadata) || Boolean(sessionProjectPath);
      const pathHashes = candidatePaths.map((candidate) => {
        try {
          return {
            path: candidate,
            hash: hashProjectPath(candidate),
            // The hash the candidate had before any marker applied. A row
            // whose recorded path re-hashes elsewhere only because a
            // .claude-memory-root marker was adopted after the store filled
            // up is a basis shift, not cross-project contamination.
            preMarkerHash: hashProjectPathIgnoringMarker(candidate)
          };
        } catch {
          return { path: candidate, hash: undefined, preMarkerHash: undefined };
        }
      });
      const belongsToThisStore = (candidate: { hash?: string; preMarkerHash?: string }) =>
        candidate.hash === projectHash || candidate.preMarkerHash === projectHash;
      const matchingPath = pathHashes.find(belongsToThisStore);
      const foreignPath = pathHashes.find((candidate) => candidate.hash && !belongsToThisStore(candidate));

      let action: 'repaired' | 'quarantined' | 'skipped' = 'skipped';
      let reason: ProjectScopeRepairSample['reason'] | undefined;
      let observedProjectHash: string | undefined;

      if (foreignPath) {
        action = 'quarantined';
        reason = 'project-path-mismatch';
        observedProjectHash = foreignPath.hash;
      } else if (currentHash === projectHash && importedOrLegacy && hasConflictingContentProjectHint(row.content, options.projectPath)) {
        action = 'quarantined';
        reason = 'content-project-mismatch';
      } else if (currentHash === projectHash) {
        result.alreadyScoped++;
        continue;
      } else if (
        currentHash && currentHash !== projectHash
        // The stamp disagrees, but it is exactly the pre-marker hash of a
        // recorded path that provably belongs to this store: the hash basis
        // moved under the row (a .claude-memory-root marker was adopted), the
        // row did not move projects. Restamp instead of quarantining, or the
        // strict retrieval scope gate drops the row forever.
        && !(matchingPath && matchingPath.preMarkerHash === currentHash)
      ) {
        action = 'quarantined';
        reason = 'scope-hash-mismatch';
        observedProjectHash = currentHash;
      } else if (matchingPath) {
        action = 'repaired';
        reason = matchingPath.path === sessionProjectPath && matchingPath.path !== explicitPath
          ? 'session-project-path'
          : 'same-project-path';
      } else if (candidatePaths.length > 0) {
        action = 'quarantined';
        reason = 'project-path-mismatch';
      } else if (importedOrLegacy) {
        action = 'quarantined';
        reason = 'missing-project-scope';
      }

      if (action === 'skipped' || !reason) {
        result.skipped++;
        continue;
      }

      if (action === 'repaired') {
        const scope = isRecord(metadata.scope) ? { ...metadata.scope } : {};
        const project = isRecord(scope.project) ? { ...scope.project } : {};
        project.hash = projectHash;
        scope.project = project;
        metadata.scope = scope;
        metadata.repair = {
          ...(isRecord(metadata.repair) ? metadata.repair : {}),
          legacyProjectScope: {
            action,
            reason,
            repairedAt: nowIso
          }
        };
        addMetadataTag(metadata, `proj:${projectHash}`);
        result.repaired++;
      } else {
        metadata.quarantine = {
          ...(isRecord(metadata.quarantine) ? metadata.quarantine : {}),
          status: 'active',
          category: 'project-scope',
          reason,
          detectedAt: nowIso,
          expectedProjectHash: projectHash,
          ...(observedProjectHash ? { observedProjectHash } : {})
        };
        metadata.repair = {
          ...(isRecord(metadata.repair) ? metadata.repair : {}),
          legacyProjectScope: {
            action,
            reason,
            repairedAt: nowIso
          }
        };
        addMetadataTag(metadata, 'quarantine:project-scope');
        result.quarantined++;
      }

      sample({ eventId: row.id, action, reason });
      if (!dryRun) {
        sqliteRun(this.db, `UPDATE events SET metadata = ? WHERE id = ?`, [JSON.stringify(metadata), row.id]);
      }
    }

    return result;
  }

  /**
   * Get embedding/vector outbox health statistics
   */
  async getOutboxStats(options: OutboxStatsOptions = {}): Promise<OutboxStats> {
    await this.initialize();

    const thresholdMs = Number.isFinite(options.stuckThresholdMs) && (options.stuckThresholdMs ?? 0) >= 0
      ? options.stuckThresholdMs!
      : DEFAULT_OUTBOX_STUCK_THRESHOLD_MS;
    const maxRetries = Number.isFinite(options.maxRetries) && (options.maxRetries ?? 0) > 0
      ? options.maxRetries!
      : DEFAULT_OUTBOX_MAX_RETRIES;
    const now = options.now ?? new Date();
    const threshold = new Date(now.getTime() - thresholdMs).toISOString();

    const embeddingRows = sqliteAll<{ status: string; count: number }>(
      this.db,
      `SELECT status, COUNT(*) as count FROM embedding_outbox GROUP BY status`
    );
    const vectorRows = sqliteAll<{ status: string; count: number }>(
      this.db,
      `SELECT status, COUNT(*) as count FROM vector_outbox GROUP BY status`
    );

    const processingAgeMs = (value: unknown): number | null => {
      if (value === null || value === undefined) return null;
      const date = toDateFromSQLite(value);
      const time = date.getTime();
      if (!Number.isFinite(time)) return null;
      return Math.max(0, now.getTime() - time);
    };

    const fromRows = (
      rows: Array<{ status: string; count: number }>,
      stuckProcessing: number,
      oldestProcessingAgeMs: number | null,
      retryableFailed: number,
      quarantinedFailed: number
    ) => {
      const out = { pending: 0, processing: 0, failed: 0, retryableFailed, quarantinedFailed, total: 0, stuckProcessing, oldestProcessingAgeMs };
      for (const row of rows) {
        const key = row.status as 'pending' | 'processing' | 'failed' | 'done';
        if (key === 'pending' || key === 'processing' || key === 'failed') {
          out[key] += Number(row.count ?? 0);
        }
        out.total += Number(row.count ?? 0);
      }
      return out;
    };

    const embeddingStuck = sqliteGet<{ count: number }>(
      this.db,
      `SELECT COUNT(*) as count
       FROM embedding_outbox
       WHERE status = 'processing'
         AND datetime(COALESCE(processed_at, created_at)) < datetime(?)`,
      [threshold]
    );
    const embeddingOldest = sqliteGet<{ oldest: string | null }>(
      this.db,
      `SELECT MIN(datetime(COALESCE(processed_at, created_at))) as oldest
       FROM embedding_outbox
       WHERE status = 'processing'`
    );
    const embeddingRetryableFailed = sqliteGet<{ count: number }>(
      this.db,
      `SELECT COUNT(*) as count
       FROM embedding_outbox
       WHERE status = 'failed'
         AND retry_count < ?`,
      [maxRetries]
    );
    const embeddingQuarantinedFailed = sqliteGet<{ count: number }>(
      this.db,
      `SELECT COUNT(*) as count
       FROM embedding_outbox
       WHERE status = 'failed'
         AND retry_count >= ?`,
      [maxRetries]
    );

    const vectorStuck = sqliteGet<{ count: number }>(
      this.db,
      `SELECT COUNT(*) as count
       FROM vector_outbox
       WHERE status = 'processing'
         AND datetime(updated_at) < datetime(?)`,
      [threshold]
    );
    const vectorOldest = sqliteGet<{ oldest: string | null }>(
      this.db,
      `SELECT MIN(datetime(updated_at)) as oldest
       FROM vector_outbox
       WHERE status = 'processing'`
    );
    const vectorRetryableFailed = sqliteGet<{ count: number }>(
      this.db,
      `SELECT COUNT(*) as count
       FROM vector_outbox
       WHERE status = 'failed'
         AND retry_count < ?`,
      [maxRetries]
    );
    const vectorQuarantinedFailed = sqliteGet<{ count: number }>(
      this.db,
      `SELECT COUNT(*) as count
       FROM vector_outbox
       WHERE status = 'failed'
         AND retry_count >= ?`,
      [maxRetries]
    );

    return {
      embedding: fromRows(
        embeddingRows,
        Number(embeddingStuck?.count ?? 0),
        processingAgeMs(embeddingOldest?.oldest),
        Number(embeddingRetryableFailed?.count ?? 0),
        Number(embeddingQuarantinedFailed?.count ?? 0)
      ),
      vector: fromRows(
        vectorRows,
        Number(vectorStuck?.count ?? 0),
        processingAgeMs(vectorOldest?.oldest),
        Number(vectorRetryableFailed?.count ?? 0),
        Number(vectorQuarantinedFailed?.count ?? 0)
      )
    };
  }

  /**
   * Update memory level
   */
  async updateMemoryLevel(eventId: string, level: string): Promise<void> {
    await this.initialize();

    sqliteRun(
      this.db,
      `UPDATE memory_levels SET level = ?, promoted_at = datetime('now') WHERE event_id = ?`,
      [level, eventId]
    );
  }

  /**
   * Get memory level statistics
   */
  async getLevelStats(): Promise<Array<{ level: string; count: number }>> {
    await this.initialize();

    const rows = sqliteAll<{ level: string; count: number }>(
      this.db,
      `SELECT ml.level, COUNT(*) as count
       FROM memory_levels ml
       INNER JOIN events e ON e.id = ml.event_id
       WHERE ${notActiveQuarantinedSql('e.metadata')}
       GROUP BY ml.level`
    );

    return rows;
  }

  /**
   * Get events by memory level
   */
  async getEventsByLevel(level: string, options?: { limit?: number; offset?: number }): Promise<MemoryEvent[]> {
    await this.initialize();

    const limit = options?.limit || 50;
    const offset = options?.offset || 0;

    const rows = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT e.* FROM events e
       INNER JOIN memory_levels ml ON e.id = ml.event_id
       WHERE ml.level = ?
         AND ${notActiveQuarantinedSql('e.metadata')}
       ORDER BY e.timestamp DESC
       LIMIT ? OFFSET ?`,
      [level, limit, offset]
    );

    return rows.map(row => this.rowToEvent(row));
  }

  /**
   * Return bounded graduation candidates in evidence order.  Graduation only
   * benefits rows with durable access evidence, and ordering by creation time
   * would permanently starve an older memory in a busy project.
   */
  async getGraduationCandidates(level: string, options: { limit: number }): Promise<MemoryEvent[]> {
    await this.initialize();

    const rows = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT e.* FROM events e
       INNER JOIN memory_levels ml ON e.id = ml.event_id
       WHERE ml.level = ?
         AND e.access_count > 0
         AND ${notActiveQuarantinedSql('e.metadata')}
       ORDER BY e.access_count DESC,
                COALESCE(e.last_accessed_at, e.timestamp) DESC,
                e.timestamp DESC
       LIMIT ?`,
      [level, options.limit]
    );

    return rows.map(row => this.rowToEvent(row));
  }

  /** Durable access evidence used to hydrate one-shot graduation workers. */
  async getGraduationMetrics(eventIds: string[]): Promise<Array<{
    eventId: string;
    accessCount: number;
    lastAccessed: Date;
    crossSessionRefs: number;
    confidence: number;
  }>> {
    await this.initialize();
    if (eventIds.length === 0) return [];
    const placeholders = eventIds.map(() => '?').join(', ');
    const rows = sqliteAll<{ id: string; access_count: number; last_accessed_at: string | null; timestamp: string }>(
      this.db,
      `SELECT id, access_count, last_accessed_at, timestamp
       FROM events
       WHERE id IN (${placeholders})
         AND access_count > 0
         AND ${notActiveQuarantinedSql('metadata')}`,
      eventIds
    );
    const sessionRows = sqliteAll<{ event_id: string; session_count: number }>(
      this.db,
      `SELECT event_id, COUNT(DISTINCT session_id) AS session_count
       FROM memory_helpfulness
       WHERE event_id IN (${placeholders})
       GROUP BY event_id`,
      eventIds
    );
    const sessionCounts = new Map(sessionRows.map((row) => [row.event_id, Number(row.session_count)]));
    return rows.map((row) => ({
      eventId: row.id,
      accessCount: Number(row.access_count),
      lastAccessed: toDateFromSQLite(row.last_accessed_at ?? row.timestamp),
      crossSessionRefs: Math.max(0, (sessionCounts.get(row.id) ?? 0) - 1),
      // Access is recorded only after the hook's strict injection filter.
      confidence: 1
    }));
  }

  /**
   * Persist an aggregate graduation attempt.  The rows deliberately contain
   * no event content, project paths, prompt text, or underlying error text so
   * they can safely feed the productivity health report.
   */
  async recordGraduationRun(input: {
    startedAt: Date;
    finishedAt: Date;
    status: 'success' | 'not_eligible' | 'failed';
    evaluated: number;
    graduated: number;
  }): Promise<void> {
    await this.initialize();
    if (this.readOnly) return;

    const buildId = randomUUID();
    const status = input.status;
    const startedAt = input.startedAt.toISOString();
    const finishedAt = input.finishedAt.toISOString();
    const latencyMs = Math.max(0, input.finishedAt.getTime() - input.startedAt.getTime());

    sqliteRun(
      this.db,
      `INSERT INTO build_runs (
         build_id, started_at, finished_at, extractor_model, extractor_prompt_hash,
         embedder_model, embedding_version, idris_version, schema_version, status, error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
      [
        buildId,
        startedAt,
        finishedAt,
        'graduation-rules',
        'not-applicable',
        'not-applicable',
        'not-applicable',
        'graduation-worker-v1',
        String(SQLITE_SCHEMA_VERSION),
        status,
        status === 'failed' ? 'graduation_failed' : null
      ]
    );

    sqliteRun(
      this.db,
      `INSERT INTO pipeline_metrics (id, ts, stage, latency_ms, success, error, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)` ,
      [
        randomUUID(),
        finishedAt,
        'graduation',
        latencyMs,
        status === 'failed' ? 0 : 1,
        status === 'failed' ? 'graduation_failed' : null,
        null
      ]
    );
  }

  /** Aggregate-only worker liveness for health/status surfaces. */
  async getDerivationLiveness(projectHash?: string): Promise<DerivationLiveness> {
    await this.initialize();

    const attempts = sqliteGet<{ count: number }>(
      this.db,
      `SELECT COUNT(*) AS count FROM build_runs WHERE idris_version = ?`,
      ['graduation-worker-v1']
    );
    const latest = sqliteGet<{ status: string; finished_at: string | null }>(
      this.db,
      `SELECT status, finished_at FROM build_runs
       WHERE idris_version = ?
       ORDER BY started_at DESC, build_id DESC
       LIMIT 1`,
      ['graduation-worker-v1']
    );
    const latestSuccessful = sqliteGet<{ finished_at: string | null }>(
      this.db,
      `SELECT finished_at FROM build_runs
       WHERE idris_version = ? AND status IN ('success', 'not_eligible')
       ORDER BY started_at DESC, build_id DESC
       LIMIT 1`,
      ['graduation-worker-v1']
    );
    const lastStatus = latest?.status === 'success' || latest?.status === 'not_eligible' || latest?.status === 'failed'
      ? latest.status
      : null;
    const graduatedEvents = sqliteGet<{ count: number }>(
      this.db,
      `SELECT COUNT(*) AS count
       FROM memory_levels ml
       INNER JOIN events e ON e.id = ml.event_id
       WHERE ml.level != 'L0' AND ${notActiveQuarantinedSql('e.metadata')}`
    );
    let curatedLessons = 0;
    try {
      const curated = sqliteGet<{ count: number }>(
        this.db,
        projectHash
          ? `SELECT COUNT(*) AS count FROM memory_lessons WHERE source_class = 'curated' AND project_hash = ?`
          : `SELECT COUNT(*) AS count FROM memory_lessons WHERE source_class = 'curated'`,
        projectHash ? [projectHash] : []
      );
      curatedLessons = Number(curated?.count ?? 0);
    } catch {
      // Older/read-only stores may predate the source_class migration.
    }

    return {
      graduation: {
        attempts: Number(attempts?.count ?? 0),
        lastAttemptAt: latest?.finished_at ?? null,
        lastSuccessAt: latestSuccessful?.finished_at ?? null,
        lastStatus,
        lastErrorCategory: lastStatus === 'failed' ? 'graduation_failed' : null
      },
      sources: {
        graduatedEvents: Number(graduatedEvents?.count ?? 0),
        curatedLessons
      }
    };
  }

  /**
   * Get memory level for a specific event
   */
  async getEventLevel(eventId: string): Promise<string | null> {
    await this.initialize();

    const row = sqliteGet<{ level: string }>(
      this.db,
      `SELECT level FROM memory_levels WHERE event_id = ?`,
      [eventId]
    );

    return row ? row.level : null;
  }

  /**
   * Get sync position for a target
   */
  async getSyncPosition(targetName: string): Promise<{ lastEventId: string | null; lastTimestamp: string | null }> {
    await this.initialize();

    const row = sqliteGet<{ last_event_id: string | null; last_timestamp: string | null }>(
      this.db,
      `SELECT last_event_id, last_timestamp FROM sync_positions WHERE target_name = ?`,
      [targetName]
    );

    return {
      lastEventId: row?.last_event_id ?? null,
      lastTimestamp: row?.last_timestamp ?? null
    };
  }

  /**
   * Update sync position for a target
   */
  async updateSyncPosition(targetName: string, lastEventId: string, lastTimestamp: string): Promise<void> {
    await this.initialize();

    sqliteRun(
      this.db,
      `INSERT OR REPLACE INTO sync_positions (target_name, last_event_id, last_timestamp, updated_at)
       VALUES (?, ?, ?, datetime('now'))`,
      [targetName, lastEventId, lastTimestamp]
    );
  }

  /**
   * Get config value for endless mode
   */
  async getEndlessConfig(key: string): Promise<unknown | null> {
    await this.initialize();

    const row = sqliteGet<{ value: string }>(
      this.db,
      `SELECT value FROM endless_config WHERE key = ?`,
      [key]
    );

    if (!row) return null;
    return JSON.parse(row.value);
  }

  /**
   * Set config value for endless mode
   */
  async setEndlessConfig(key: string, value: unknown): Promise<void> {
    await this.initialize();

    sqliteRun(
      this.db,
      `INSERT OR REPLACE INTO endless_config (key, value, updated_at)
       VALUES (?, ?, datetime('now'))`,
      [key, JSON.stringify(value)]
    );
  }

  /**
   * Increment access count for events
   */
  /**
   * Increment access counters for injected memories.
   *
   * Accepts typed references so a lesson id can no longer be used to update
   * `events.access_count` — that write matched no row and silently lost the
   * access signal for every lesson (specs R1). Bare strings stay supported for
   * callers that only ever hold event ids.
   */
  async incrementAccessCount(refs: Array<string | { kind: MemoryKind; id: string }>): Promise<void> {
    if (refs.length === 0 || this.readOnly) return;

    await this.initialize();

    // Each reference is counted against the table that actually owns it. A
    // lesson id never matched a row in `events`, so those writes were lost
    // entirely before the kind travelled with the reference (specs R1).
    const typed = refs
      .map((ref) => (typeof ref === 'string' ? { kind: 'event' as MemoryKind, id: ref } : ref))
      .filter((ref) => Boolean(ref?.id));
    const eventIds = Array.from(new Set(typed
      .filter((ref) => normalizeMemoryKind(ref.kind) === 'event')
      .map((ref) => ref.id)));
    const lessonIds = Array.from(new Set(typed
      .filter((ref) => normalizeMemoryKind(ref.kind) === 'lesson')
      .map((ref) => ref.id)));
    const currentTime = toSQLiteTimestamp(new Date());

    if (eventIds.length > 0) {
      sqliteRun(
        this.db,
        `UPDATE events
         SET access_count = access_count + 1,
             last_accessed_at = ?
         WHERE id IN (${eventIds.map(() => '?').join(',')})`,
        [currentTime, ...eventIds]
      );
    }
    if (lessonIds.length > 0 && this.hasTableColumn('memory_lessons', 'access_count')) {
      sqliteRun(
        this.db,
        `UPDATE memory_lessons
         SET access_count = access_count + 1,
             last_accessed_at = ?
         WHERE lesson_id IN (${lessonIds.map(() => '?').join(',')})`,
        [currentTime, ...lessonIds]
      );
    }
  }

  /**
   * Get most accessed memories (falls back to recent events if none accessed)
   */
  async getMostAccessed(limit: number = 10, options?: QuarantineReadOptions): Promise<MemoryEvent[]> {
    await this.initialize();

    // First try events with access_count > 0
    let rows = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM events
       WHERE access_count > 0
         AND ${maybeQuarantinePredicate(options)}
       ORDER BY access_count DESC, last_accessed_at DESC
       LIMIT ?`,
      [limit]
    );

    // Fallback: if no accessed events, show recent events
    if (rows.length === 0) {
      rows = sqliteAll<Record<string, unknown>>(
        this.db,
        `SELECT * FROM events
         WHERE ${maybeQuarantinePredicate(options)}
         ORDER BY timestamp DESC
         LIMIT ?`,
        [limit]
      );
    }

    return rows.map(row => this.rowToEvent(row));
  }

  /**
   * Record a memory retrieval for helpfulness tracking
   */
  async recordRetrieval(
    eventId: string,
    sessionId: string,
    score: number,
    query: string,
    options?: {
      traceId?: string;
      source?: string;
      injectedContent?: string;
      /** Typed kind of the recorded memory. Defaults to `event`. */
      memoryKind?: MemoryKind;
      memoryProjectId?: string | null;
      /**
       * Delivery is not assumed. Selection records `formatted`; only a caller
       * with output evidence upgrades it via recordDeliveryOutcome (specs R3).
       */
      deliveryStatus?: DeliveryStatus;
      deliveryEvidence?: DeliveryEvidenceSource;
    } & RetrievalTelemetryContext
  ): Promise<void> {
    if (this.readOnly) return;
    await this.initialize();

    const id = randomUUID();
    // created_at needs millisecond precision: datetime('now') is second-only,
    // so the triggering prompt (stored moments earlier with an ISO ms
    // timestamp in the same second) would count as "after" the retrieval.
    sqliteRun(
      this.db,
      `INSERT INTO memory_helpfulness (
         id, event_id, session_id, retrieval_score, query_preview, trace_id, source,
         injected_content, memory_kind, delivery_status, delivery_evidence,
         presentation_mode, trigger_type, delivery_client, created_at, memory_project_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, eventId, sessionId, score, query.slice(0, 200),
        options?.traceId || null,
        options?.source || 'user_prompt',
        options?.injectedContent ? options.injectedContent.slice(0, 2000) : null,
        normalizeMemoryKind(options?.memoryKind ?? 'event'),
        normalizeDeliveryStatus(options?.deliveryStatus ?? 'formatted'),
        normalizeDeliveryEvidence(options?.deliveryEvidence ?? 'context_formatted'),
        normalizeRetrievalPresentationMode(options?.presentationMode),
        normalizeRetrievalTriggerType(options?.triggerType),
        normalizeTelemetryClient(options?.deliveryClient),
        new Date().toISOString(),
        options?.memoryProjectId?.trim() || null
      ]
    );
  }

  /**
   * Record what actually happened to a delivery after selection (specs R3).
   *
   * Selection alone never sets delivered=true. A hook that successfully wrote
   * its context to stdout reports `emitted`; a write failure reports `failed`;
   * anything unobserved stays `unknown`. "Emitted" is not "the model read it" —
   * only an explicit consumer acknowledgement is `acknowledged`.
   */
  async recordDeliveryOutcome(input: {
    traceId: string;
    status: DeliveryStatus;
    evidence: DeliveryEvidenceSource;
    deliveredAt?: Date;
    /** Omitted updates the whole trace; an empty list updates no items. */
    refs?: Array<{ kind: MemoryKind; id: string; projectId?: string | null }>;
  }): Promise<number> {
    if (input.refs?.length === 0) return 0;
    if (this.readOnly) return 0;
    await this.initialize();
    const traceId = input.traceId?.trim();
    if (!traceId) return 0;
    const status = normalizeDeliveryStatus(input.status);
    const evidence = normalizeDeliveryEvidence(input.evidence);
    const deliveredAt = (input.deliveredAt ?? new Date()).toISOString();
    const hasPositiveDelivery = deliveredFromStatus(status) === true;

    // A ref filter matches on kind *and* id. Filtering by id alone would move
    // the delivery status of an event that merely shares an id with the lesson
    // the caller actually delivered (finding 3).
    const hasHelpfulnessKind = this.hasTableColumn('memory_helpfulness', 'memory_kind');
    const params: unknown[] = [status, evidence, hasPositiveDelivery ? 1 : 0, deliveredAt, traceId];
    let refFilter = '';
    if (input.refs && input.refs.length > 0) {
      if (hasHelpfulnessKind) {
        refFilter = ` AND (${input.refs.map(() => `(event_id = ? AND COALESCE(memory_kind, 'event') = ? AND memory_project_id IS ?)`).join(' OR ')})`;
        for (const ref of input.refs) params.push(ref.id, normalizeMemoryKind(ref.kind), ref.projectId ?? null);
      } else {
        refFilter = ` AND event_id IN (${input.refs.map(() => '?').join(',')})`;
        params.push(...input.refs.map((ref) => ref.id));
      }
    }
    // Keep any already-evaluated observation consistent with the new evidence
    // rather than leaving a stale assumed value behind. The same ref scope
    // applies: updating every row of the trace would rewrite the delivery state
    // of items this call says nothing about.
    const delivered = deliveredFromStatus(status);
    const observationParams: unknown[] = [
      status, evidence, delivered === null ? null : delivered ? 1 : 0,
      traceId, CURRENT_USEFULNESS_EVALUATOR_VERSION
    ];
    let observationFilter = '';
    if (input.refs && input.refs.length > 0) {
      observationFilter = ` AND event_id IN (${input.refs.map(() => '?').join(',')})`;
      observationParams.push(...input.refs.map((ref) => usefulnessRowKey(normalizeMemoryKind(ref.kind), ref.id, ref.projectId)));
    }
    // Commit both representations together so a failed observation update
    // cannot leave navigation and usefulness reporting different delivery states.
    return this.runInImmediateTransaction(() => {
      if (retrievalRollout().usefulnessV3Write) {
        const deliveredValue = delivered === null ? null : delivered ? 1 : 0;
        // An evaluation based on different delivery evidence is stale, even
        // after its old window closed. Queue it for normal session evaluation
        // and clear derived claims until that evaluation has run.
        sqliteRun(this.db,
          `UPDATE memory_helpfulness SET measured_at = NULL
           WHERE trace_id = ?${refFilter} AND EXISTS (
             SELECT 1 FROM memory_usefulness_observations_v2 o
             WHERE o.trace_id = memory_helpfulness.trace_id
               AND o.event_id = ${usefulnessRowKeySql('memory_helpfulness')}
               AND o.evaluator_version = ? AND o.delivered IS NOT ?
           )`,
          [traceId, ...params.slice(5), CURRENT_USEFULNESS_EVALUATOR_VERSION, deliveredValue]);
        sqliteRun(this.db,
          `UPDATE memory_usefulness_observations_v2
           SET adoption = ?, task_outcome = 'unknown', content_overlap_score = NULL,
               reask_outcome = 'unknown', confidence = 0, evaluated_at = NULL, evaluation_cutoff = NULL
           WHERE trace_id = ? AND evaluator_version = ?${observationFilter} AND delivered IS NOT ?`,
          [delivered === false ? 'not_observed' : 'unknown', traceId,
            CURRENT_USEFULNESS_EVALUATOR_VERSION, ...observationParams.slice(5), deliveredValue]);
      }
      const result = sqliteRun(
        this.db,
        `UPDATE memory_helpfulness
         SET delivery_status = ?, delivery_evidence = ?,
             delivered_at = CASE WHEN ? = 1 THEN COALESCE(delivered_at, ?) ELSE delivered_at END
         WHERE trace_id = ?${refFilter}`,
        params
      );
      if (retrievalRollout().usefulnessV3Write) {
        sqliteRun(
          this.db,
          `UPDATE memory_usefulness_observations_v2
           SET delivery_status = ?, delivery_evidence = ?, delivered = ?
           WHERE trace_id = ? AND evaluator_version = ?${observationFilter}`,
          observationParams
        );
      }
      return Number(result?.changes ?? 0);
    });
  }

  /**
   * Get session IDs that have unevaluated retrievals (measured_at IS NULL).
   * Excludes the current session. Used to backfill sessions that ended without Stop hook.
   */
  async getUnevaluatedSessions(currentSessionId: string, limit = 5): Promise<string[]> {
    await this.initialize();
    const rows = sqliteAll<{ session_id: string }>(
      this.db,
      `SELECT DISTINCT session_id FROM memory_helpfulness
       WHERE measured_at IS NULL AND session_id != ?
       ORDER BY created_at DESC LIMIT ?`,
      [currentSessionId, limit]
    );
    return rows.map((r) => r.session_id);
  }

  /**
   * Evaluate helpfulness for all retrievals in a session
   * Called at session end - uses behavioral signals to compute score
   */
  async evaluateSessionHelpfulness(sessionId: string): Promise<void> {
    if (this.readOnly) return;
    await this.initialize();

    // Get all retrieval records for this session
    const retrievals = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM memory_helpfulness WHERE session_id = ? AND measured_at IS NULL`,
      [sessionId]
    );

    if (retrievals.length === 0) return;
    await this.evaluateRetrievalRows(sessionId, retrievals);
  }

  /**
   * Re-evaluate deliveries whose observation window had not closed yet when the
   * session was first evaluated (specs R3).
   *
   * A session that ends immediately after an injection is evaluated with only
   * the responses that existed at that moment; the 30-minute adoption window is
   * still open. This bounded pass revisits exactly those rows once the window
   * has actually elapsed, so a late response is not permanently recorded as
   * "not observed". It never widens the window and never re-scores a delivery
   * whose window was already complete.
   */
  async reevaluateBoundedUsefulness(options: {
    limit?: number;
    now?: Date;
    windowMs?: number;
  } = {}): Promise<{ sessionsReevaluated: number; rowsReevaluated: number; windowMs: number; cutoff: string }> {
    const windowMs = options.windowMs ?? USEFULNESS_V2_EVALUATION_WINDOW_MS;
    const now = options.now ?? new Date();
    const summary = { sessionsReevaluated: 0, rowsReevaluated: 0, windowMs, cutoff: now.toISOString() };
    if (this.readOnly) return summary;
    await this.initialize();
    if (!this.hasTableColumn('memory_usefulness_observations_v2', 'evaluation_cutoff')) return summary;

    const limit = Math.min(Math.max(options.limit ?? 200, 1), 5_000);
    const rows = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT mh.* ${this.boundedReevaluationFromWhereSql()}
       ORDER BY mh.created_at ASC
       LIMIT ?`,
      [CURRENT_USEFULNESS_EVALUATOR_VERSION, now.toISOString(), limit]
    );
    if (rows.length === 0) return summary;

    const bySession = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
      const sessionId = String(row.session_id || '');
      if (!sessionId) continue;
      const list = bySession.get(sessionId) ?? [];
      list.push(row);
      bySession.set(sessionId, list);
    }
    for (const [sessionId, sessionRows] of bySession) {
      await this.evaluateRetrievalRows(sessionId, sessionRows, { evaluatedAt: now });
      summary.sessionsReevaluated += 1;
      summary.rowsReevaluated += sessionRows.length;
    }
    return summary;
  }

  /**
   * Shared FROM/WHERE for the bounded re-evaluation pass: rows evaluated before
   * their adoption window closed, whose window has since elapsed.
   *
   * The window opens when the memory was actually delivered, not when it was
   * selected: a delivery recorded late (or never emitted) must not have its
   * adoption window measured from the selection instant (specs R3, finding 4).
   * Parameters, in order: evaluator version, "now".
   */
  private boundedReevaluationFromWhereSql(): string {
    const anchorSql = this.hasTableColumn('memory_helpfulness', 'delivered_at')
      ? `COALESCE(mh.delivered_at, mh.created_at)`
      : `mh.created_at`;
    return `FROM memory_helpfulness mh
       JOIN memory_usefulness_observations_v2 o
         ON o.trace_id = COALESCE(mh.trace_id, 'legacy:' || mh.id)
        AND o.event_id = ${usefulnessRowKeySql('mh')}
        AND o.evaluator_version = ?
       WHERE mh.measured_at IS NOT NULL
         AND o.evaluation_cutoff IS NOT NULL
         AND o.evaluation_window_ms IS NOT NULL
         -- window was still open at evaluation time ... (the 1ms slack keeps
         -- julianday's floating-point rounding from re-queuing a row whose
         -- cutoff already sits exactly on the window end)
         AND julianday(o.evaluation_cutoff) < julianday(${anchorSql}) + ((o.evaluation_window_ms - 1) / 86400000.0)
         -- ... and it has since elapsed
         AND julianday(?) >= julianday(${anchorSql}) + (o.evaluation_window_ms / 86400000.0)`;
  }

  /**
   * How many rows the bounded pass would revisit right now. Read-only, so a
   * scheduled job can preview its work without writing anything (specs R3).
   */
  async countPendingBoundedUsefulness(options: { now?: Date } = {}): Promise<{ pendingRows: number; cutoff: string }> {
    await this.initialize();
    const now = options.now ?? new Date();
    const cutoff = now.toISOString();
    if (!this.hasTable('memory_usefulness_observations_v2')
      || !this.hasTableColumn('memory_usefulness_observations_v2', 'evaluation_cutoff')) {
      return { pendingRows: 0, cutoff };
    }
    const row = sqliteGet<{ pending: number }>(
      this.db,
      `SELECT COUNT(*) AS pending ${this.boundedReevaluationFromWhereSql()}`,
      [CURRENT_USEFULNESS_EVALUATOR_VERSION, cutoff]
    );
    return { pendingRows: Number(row?.pending ?? 0), cutoff };
  }

  private async evaluateRetrievalRows(
    sessionId: string,
    retrievals: Record<string, unknown>[],
    options: { evaluatedAt?: Date } = {}
  ): Promise<void> {
    // Get session events to analyze behavior after retrieval
    const sessionEvents = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC`,
      [sessionId]
    );

    const promptEvents = sessionEvents.filter((e: any) => e.event_type === 'user_prompt');
    const toolEvents = sessionEvents.filter((e: any) => e.event_type === 'tool_observation');
    const responseEvents = sessionEvents.filter((e: any) => e.event_type === 'agent_response');

    // Look up the injected memories' content once so each retrieval can be
    // checked for content grounding against the responses that followed it.
    // Only event-kind rows can be hydrated from the events table; a lesson row
    // relies on its stored injected excerpt (specs R1).
    const retrievedEventIds = Array.from(new Set(retrievals
      .filter((r) => normalizeMemoryKind(r.memory_kind ?? 'event') === 'event')
      .map((r) => r.event_id as string)
      .filter(Boolean)));
    const memoryContentById = new Map<string, string>();
    for (let i = 0; i < retrievedEventIds.length; i += 100) {
      const chunk = retrievedEventIds.slice(i, i + 100);
      const rows = sqliteAll<{ id: string; content: string }>(
        this.db,
        `SELECT id, content FROM events WHERE id IN (${chunk.map(() => '?').join(',')})`,
        chunk
      );
      for (const row of rows) memoryContentById.set(row.id, row.content);
    }

    // Events store ISO timestamps while memory_helpfulness.created_at uses
    // SQLite datetime('now') ("YYYY-MM-DD HH:MM:SS", UTC). Comparing the raw
    // strings marks any same-day event as "after", so compare epoch millis.
    const toEpochMs = (value: unknown): number => {
      const raw = String(value || '');
      const iso = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
      const ms = new Date(iso).getTime();
      return Number.isFinite(ms) ? ms : 0;
    };

    for (const retrieval of retrievals) {
      // Adoption is measured from the moment the memory was actually delivered.
      // Before that instant nothing could have used it, and a delivery that was
      // never emitted has no anchor at all (specs R3, finding 4).
      const selectedAtMs = toEpochMs(retrieval.created_at);
      const deliveredAtMs = retrieval.delivered_at ? toEpochMs(retrieval.delivered_at) : 0;
      const retrievalTimeMs = deliveredAtMs > 0 ? deliveredAtMs : selectedAtMs;

      // 1. Session continued after retrieval?
      const eventsAfter = sessionEvents.filter((e: any) => toEpochMs(e.timestamp) > retrievalTimeMs);
      const sessionContinued = eventsAfter.length > 0 ? 1 : 0;

      // 2. How many prompts came after?
      const promptsAfter = promptEvents.filter((e: any) => toEpochMs(e.timestamp) > retrievalTimeMs);
      const promptCountAfter = promptsAfter.length;
      const toolOutcomesAfter = toolEvents
        .filter((e: any) => toEpochMs(e.timestamp) > retrievalTimeMs)
        .map((event) => parseToolOutcome(event.content));
      const measuredToolOutcomes = toolOutcomesAfter.filter((outcome) => outcome !== 'unknown');
      const toolSuccessCount = measuredToolOutcomes.filter((outcome) => outcome === 'success').length;
      const toolTotalCount = measuredToolOutcomes.length;
      const toolSuccessRatio = toolTotalCount > 0 ? toolSuccessCount / toolTotalCount : 0.5;

      // 3. Was a similar query asked again? (simple word overlap check)
      const queryWords = new Set((retrieval.query_preview as string || '').toLowerCase().split(/\s+/).filter(w => w.length > 2));
      let wasReasked = 0;
      for (const p of promptsAfter) {
        const pWords = new Set((p.content as string).toLowerCase().split(/\s+/).filter((w: string) => w.length > 2));
        let overlap = 0;
        for (const w of queryWords) {
          if (pWords.has(w)) overlap++;
        }
        if (queryWords.size > 0 && overlap / queryWords.size > 0.5) {
          wasReasked = 1;
          break;
        }
      }

      // 4. Content grounding: did the assistant responses after this
      //    retrieval actually reuse the memory's content? This is the most
      //    direct usefulness signal we have — the behavioral signals below
      //    only approximate it.
      const responsesAfter = responseEvents
        .filter((e: any) => toEpochMs(e.timestamp) > retrievalTimeMs)
        .map((e: any) => ({ id: e.id as string, content: e.content as string, timestamp: e.timestamp }));
      // Grounding must be checked against what was actually injected into the
      // prompt (hooks truncate memories), not the full stored event — otherwise
      // facts the model never saw would count as "used". Full content is the
      // fallback for legacy rows recorded before the snapshot column existed.
      const memoryContent = (retrieval.injected_content as string)
        || memoryContentById.get(retrieval.event_id as string)
        || '';
      const presentationMode = normalizeRetrievalPresentationMode(retrieval.presentation_mode);
      let contentOverlapScore: number | null = null;
      let evidenceMatches: EvidenceMatch[] = [];
      if (presentationMode !== 'reference' && responsesAfter.length > 0 && memoryContent) {
        const evidence = computeMemoryUsageEvidence(memoryContent, responsesAfter);
        contentOverlapScore = evidence.contentOverlapScore;
        evidenceMatches = evidence.matches;
      }

      const v2WindowEndMs = retrievalTimeMs + USEFULNESS_V2_EVALUATION_WINDOW_MS;
      const evaluatedAt = options.evaluatedAt ?? new Date();
      const evaluationCutoffMs = Math.min(evaluatedAt.getTime(), v2WindowEndMs);
      const v2PromptsAfter = promptsAfter.filter((event) => toEpochMs(event.timestamp) <= evaluationCutoffMs);
      const v2ToolOutcomesAfter = toolEvents
        .filter((event) => {
          const eventTimeMs = toEpochMs(event.timestamp);
          return eventTimeMs > retrievalTimeMs && eventTimeMs <= evaluationCutoffMs;
        })
        .map((event) => parseToolOutcome(event.content));
      const v2ResponsesAfter = responsesAfter.filter((event) => toEpochMs(event.timestamp) <= evaluationCutoffMs);
      const v2Evidence = presentationMode !== 'reference' && v2ResponsesAfter.length > 0 && memoryContent
        ? computeMemoryUsageEvidence(memoryContent, v2ResponsesAfter)
        : null;
      const v2ContentOverlapScore = v2Evidence?.contentOverlapScore ?? null;

      // Kind-aware: an open of lesson X must not count as an open of the event
      // that happens to share its id (specs R1). A row whose own kind is
      // `unknown` (written before the typed columns existed) cannot narrow
      // anything, so it matches on id alone rather than excluding itself.
      const retrievalKind = normalizeMemoryKind(retrieval.memory_kind);
      const navigationKindClause = retrievalKind !== 'unknown'
        && this.hasTableColumn('retrieval_navigation_events', 'memory_kind')
        ? ` AND COALESCE(memory_kind, 'event') = ? AND memory_project_id IS ?`
        : '';
      const referenceOpened = presentationMode === 'reference' && Boolean(retrieval.trace_id) && Boolean(
        sqliteGet<{ opened: number }>(
          this.db,
          `SELECT 1 AS opened
           FROM retrieval_navigation_events
           WHERE trace_id = ? AND target_event_id = ? AND attribution_outcome = 'attributed'${navigationKindClause}
             AND julianday(first_opened_at) >= julianday(?)
             AND julianday(first_opened_at) <= julianday(?)
           LIMIT 1`,
          [...(navigationKindClause
            ? [retrieval.trace_id, retrieval.event_id, retrievalKind, retrieval.memory_project_id ?? null]
            : [retrieval.trace_id, retrieval.event_id]),
          new Date(retrievalTimeMs).toISOString(), new Date(evaluationCutoffMs).toISOString()]
        )
      );
      // Distinguish "the reference was not opened" from "we cannot attribute
      // opens at all": without a trace link no navigation can ever be
      // attributed to this delivery, so absence proves nothing (specs R3).
      const referenceAttributable = presentationMode === 'reference' && Boolean(retrieval.trace_id);

      // Calculate helpfulness score
      // Weights tuned for shopping-assistant-like corpora where sessions
      // continue on the same topic (was_reasked was over-penalising normal conversation flow)
      const retrievalScore = retrieval.retrieval_score as number || 0;
      // More prompts after retrieval = memory was actually useful to the conversation
      const promptNorm = Math.min(promptCountAfter / 2, 1.0);
      // When content grounding is measurable it dominates the score; the
      // legacy behavioral-only formula remains the fallback (e.g. session
      // ended right after retrieval, so no responses followed).
      // A reference index is navigation, not evidence. Absence of copied text
      // must not make it unhelpful: a deterministic open is positive and an
      // unopened reference remains neutral. Citation use is not inferred.
      const helpfulnessScore = presentationMode === 'reference'
        ? (referenceOpened ? 1 : 0.5)
        : contentOverlapScore !== null
        ? (
          0.45 * contentOverlapScore +
          0.20 * Math.min(retrievalScore, 1.0) +
          0.15 * promptNorm +
          0.10 * toolSuccessRatio +
          0.10 * (sessionContinued ? 1.0 : 0.0)
        )
        : (
          0.40 * Math.min(retrievalScore, 1.0) +
          0.30 * promptNorm +
          0.20 * toolSuccessRatio +
          0.10 * (sessionContinued ? 1.0 : 0.0)
        );

      sqliteRun(
        this.db,
        `UPDATE memory_helpfulness
         SET session_continued = ?, prompt_count_after = ?,
             tool_success_count = ?, tool_total_count = ?,
             was_reasked = ?, helpfulness_score = ?,
             content_overlap_score = ?, evidence_json = ?,
             measured_at = datetime('now')
         WHERE id = ?`,
        [sessionContinued, promptCountAfter, toolSuccessCount, toolTotalCount,
         wasReasked, helpfulnessScore,
         contentOverlapScore,
         evidenceMatches.length > 0 ? JSON.stringify(evidenceMatches) : null,
         retrieval.id]
      );

      const triggerType = normalizeRetrievalTriggerType(retrieval.trigger_type ?? retrieval.source);
      const adoption = presentationMode === 'reference'
        ? (referenceOpened ? 'navigated' : referenceAttributable ? 'not_observed' : 'unknown')
        : presentationMode === 'evidence'
          ? (v2ContentOverlapScore === null ? 'unknown' : v2ContentOverlapScore >= 0.3 ? 'grounded' : 'not_observed')
          : 'unknown';
      // Delivery comes from recorded evidence only. A selection that was
      // formatted but never observed leaving the process stays unknown.
      const deliveryStatus = normalizeDeliveryStatus(retrieval.delivery_status);
      const deliveryEvidence = normalizeDeliveryEvidence(retrieval.delivery_evidence);
      const delivered = deliveredFromStatus(deliveryStatus);
      // Adoption requires delivery evidence. Text overlap in a later response
      // cannot be attributed to a memory that was only formatted, or whose
      // write failed: the model never saw it. Those stay `unknown` rather than
      // becoming grounded (or a "task success") on an assumption (specs R3,
      // finding 11). A `failed` delivery is a real observation of non-adoption.
      const evidencedAdoption: UsefulnessAdoption = delivered === true
        ? adoption
        : delivered === false
          ? 'not_observed'
          : 'unknown';
      await this.upsertUsefulnessObservationV2(buildUsefulnessObservationV2({
        traceId: String(retrieval.trace_id || `legacy:${retrieval.id}`),
        eventId: String(retrieval.event_id),
        memoryKind: normalizeMemoryKind(retrieval.memory_kind),
        memoryProjectId: (retrieval.memory_project_id as string | null | undefined) ?? null,
        presentationMode,
        triggerType,
        delivered,
        deliveryStatus,
        deliveryEvidence,
        adoption: evidencedAdoption,
        contentOverlapScore: presentationMode === 'evidence' ? v2ContentOverlapScore : null,
        toolOutcomes: v2ToolOutcomesAfter,
        reaskOutcome: classifyReaskOutcome(
          retrieval.query_preview,
          v2PromptsAfter.map((event) => event.content)
        ),
        evaluatedAt: evaluatedAt.toISOString(),
        evaluationWindowMs: USEFULNESS_V2_EVALUATION_WINDOW_MS,
        // The cutoff is what this evaluation could actually see. When it falls
        // short of the window end, reevaluateBoundedUsefulness revisits the row.
        evaluationCutoff: new Date(Math.min(evaluatedAt.getTime(), v2WindowEndMs)).toISOString()
      }));
    }
  }

  async upsertUsefulnessObservationV2(input: MemoryUsefulnessObservationV2): Promise<void> {
    if (this.readOnly) return;
    if (input.evaluatorVersion === CURRENT_USEFULNESS_EVALUATOR_VERSION && !retrievalRollout().usefulnessV3Write) return;
    await this.initialize();
    const delivered = input.delivered === null ? null : input.delivered ? 1 : 0;
    const overlapValue = input.contentOverlapScore === null ? null : Number(input.contentOverlapScore);
    const confidenceValue = Number(input.confidence);
    if ((overlapValue !== null && !Number.isFinite(overlapValue)) || !Number.isFinite(confidenceValue)) {
      throw new Error('v2 usefulness observation scores must be finite numbers');
    }
    const overlap = overlapValue === null ? null : Math.max(0, Math.min(1, overlapValue));
    const confidence = Math.max(0, Math.min(1, confidenceValue));
    if (!input.traceId.trim() || !input.eventId.trim() || !input.evaluatorVersion.trim()) {
      throw new Error('v2 usefulness observation requires trace, event, and evaluator version');
    }
    const hasTypedColumns = this.hasTableColumn('memory_usefulness_observations_v2', 'memory_kind');
    const hasMemoryIdColumn = this.hasTableColumn('memory_usefulness_observations_v2', 'memory_id');
    const memoryKind = normalizeMemoryKind(input.memoryKind ?? 'event');
    // Non-event memories are stored under a kind-qualified key. The primary key
    // is (trace_id, event_id, observation_kind, evaluator_version), so a lesson
    // and an event that share an id would otherwise overwrite one another —
    // and an event-table join would claim the lesson row as a dangling event.
    const rowKey = hasTypedColumns && input.evaluatorVersion !== 'v2'
      ? usefulnessRowKey(memoryKind, input.eventId.trim(), input.memoryProjectId)
      : input.eventId.trim();
    const typedColumns = hasTypedColumns
      ? ', memory_kind, delivery_status, delivery_evidence, evaluation_window_ms, evaluation_cutoff'
        + (hasMemoryIdColumn ? ', memory_id, memory_project_id' : '')
      : '';
    const typedPlaceholders = hasTypedColumns
      ? ', ?, ?, ?, ?, ?' + (hasMemoryIdColumn ? ', ?, ?' : '')
      : '';
    const typedUpdates = hasTypedColumns
      ? `,
         memory_kind = excluded.memory_kind,
         delivery_status = excluded.delivery_status,
         delivery_evidence = excluded.delivery_evidence,
         evaluation_window_ms = excluded.evaluation_window_ms,
         evaluation_cutoff = excluded.evaluation_cutoff`
        + (hasMemoryIdColumn
          ? `,
         memory_id = excluded.memory_id,
         memory_project_id = excluded.memory_project_id`
          : '')
      : '';
    const typedValues = hasTypedColumns
      ? [
        memoryKind,
        normalizeDeliveryStatus(input.deliveryStatus),
        normalizeDeliveryEvidence(input.deliveryEvidence),
        typeof input.evaluationWindowMs === 'number' && Number.isFinite(input.evaluationWindowMs)
          ? Math.max(0, Math.floor(input.evaluationWindowMs))
          : null,
        input.evaluationCutoff ?? null,
        ...(hasMemoryIdColumn ? [input.eventId.trim(), input.memoryProjectId ?? null] : [])
      ]
      : [];
    sqliteRun(
      this.db,
      `INSERT INTO memory_usefulness_observations_v2 (
         trace_id, event_id, observation_kind, evaluator_version,
         presentation_mode, trigger_type, selected, delivered, adoption,
         content_overlap_score, task_outcome, reask_outcome, explicit_feedback,
         confidence, evaluated_at${typedColumns}
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${typedPlaceholders})
       ON CONFLICT(trace_id, event_id, observation_kind, evaluator_version) DO UPDATE SET
         presentation_mode = excluded.presentation_mode,
         trigger_type = excluded.trigger_type,
         selected = excluded.selected,
         delivered = excluded.delivered,
         adoption = excluded.adoption,
         content_overlap_score = excluded.content_overlap_score,
         task_outcome = excluded.task_outcome,
         reask_outcome = excluded.reask_outcome,
         explicit_feedback = excluded.explicit_feedback,
         confidence = excluded.confidence,
         evaluated_at = excluded.evaluated_at${typedUpdates}`,
      [
        input.traceId.trim(), rowKey, 'outcome', input.evaluatorVersion.trim(),
        normalizeRetrievalPresentationMode(input.presentationMode),
        normalizeRetrievalTriggerType(input.triggerType),
        input.selected ? 1 : 0, delivered, input.adoption, overlap,
        input.taskOutcome, input.reaskOutcome, input.explicitFeedback, confidence,
        input.evaluatedAt, ...typedValues
      ]
    );
  }

  async getUsefulnessAggregateV2(options: {
    since?: Date;
    until?: Date;
    minimumSample?: number;
    evaluatorVersion?: string;
    includeSessionStart?: boolean;
  } = {}): Promise<UsefulnessAggregateV2> {
    await this.initialize();
    const minimumSample = normalizeUsefulnessMinimumSample(options.minimumSample);
    // Default to the delivery-evidence evaluator. v2 rows assumed delivery, so
    // they are readable on request but never averaged in by default (specs R3).
    const evaluatorVersion = options.evaluatorVersion?.trim() || CURRENT_USEFULNESS_EVALUATOR_VERSION;
    const base = emptyUsefulnessAggregateV2({
      minimumSample,
      evaluatorVersion,
      includeSessionStart: options.includeSessionStart,
      since: options.since,
      until: options.until,
      evaluationWindowMs: USEFULNESS_V2_EVALUATION_WINDOW_MS
    });
    if (!this.hasTable('memory_usefulness_observations_v2')) return base;
    const clauses = ['o.evaluator_version = ?'];
    const params: unknown[] = [evaluatorVersion];
    if (!options.includeSessionStart) clauses.push(`o.trigger_type != 'session_start'`);
    if (options.since) {
      clauses.push('datetime(COALESCE(t.created_at, o.evaluated_at)) >= datetime(?)');
      params.push(options.since.toISOString());
    }
    if (options.until) {
      clauses.push('datetime(COALESCE(t.created_at, o.evaluated_at)) < datetime(?)');
      params.push(options.until.toISOString());
    }
    const hasTypedColumns = this.hasTableColumn('memory_usefulness_observations_v2', 'memory_kind');
    const typedSelect = hasTypedColumns ? ', o.memory_kind, o.delivery_status' : '';
    const rows = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT o.selected, o.delivered, o.presentation_mode, o.trigger_type, o.adoption, o.task_outcome,
              o.reask_outcome, o.explicit_feedback${typedSelect}
       FROM memory_usefulness_observations_v2 o
       LEFT JOIN retrieval_traces t ON t.trace_id = o.trace_id
       WHERE ${clauses.join(' AND ')}`,
      params
    );
    // Rows written by an evaluator generation that assumed delivery. Counted
    // and shown, never merged into this aggregate's rates.
    const legacyAssumedDeliveryRows = LEGACY_ASSUMED_DELIVERY_EVALUATOR_VERSIONS.includes(
      evaluatorVersion as typeof LEGACY_ASSUMED_DELIVERY_EVALUATOR_VERSIONS[number]
    )
      ? rows.length
      : Number(sqliteGet<{ count: number }>(
        this.db,
        `SELECT COUNT(*) AS count FROM memory_usefulness_observations_v2 o
         LEFT JOIN retrieval_traces t ON t.trace_id = o.trace_id
         WHERE ${clauses.join(' AND ')}`,
        ['v2', ...params.slice(1)]
      )?.count ?? 0);
    const traceClauses: string[] = [];
    const traceParams: unknown[] = [];
    if (!options.includeSessionStart) traceClauses.push(`trigger_type != 'session_start'`);
    if (options.since) {
      traceClauses.push('datetime(created_at) >= datetime(?)');
      traceParams.push(options.since.toISOString());
    }
    if (options.until) {
      traceClauses.push('datetime(created_at) < datetime(?)');
      traceParams.push(options.until.toISOString());
    }
    const traceTotals = this.hasTable('retrieval_traces')
      ? sqliteGet<{ eligible: number; selected: number }>(
        this.db,
        `SELECT COALESCE(SUM(candidate_count), 0) AS eligible,
                COALESCE(SUM(selected_count), 0) AS selected
         FROM retrieval_traces${traceClauses.length > 0 ? ` WHERE ${traceClauses.join(' AND ')}` : ''}`,
        traceParams
      )
      : undefined;
    const observedSelections = rows.filter((row) => Number(row.selected) === 1).length;
    const eligible = Number(traceTotals?.eligible ?? 0) > 0 ? Number(traceTotals?.eligible) : rows.length;
    const selected = Number(traceTotals?.eligible ?? 0) > 0 ? Number(traceTotals?.selected) : observedSelections;
    if (rows.length === 0) {
      return {
        ...base,
        legacyAssumedDeliveryRows,
        eligible,
        selected,
        rates: {
          ...base.rates,
          selectionYield: {
            numerator: selected,
            denominator: eligible,
            unknown: 0,
            value: eligible > 0 ? Math.round((selected / eligible) * 10_000) / 10_000 : null
          }
        }
      };
    }

    const observationCount = rows.length;
    const delivered = rows.filter((row) => Number(row.delivered) === 1).length;
    const deliveryUnknown = rows.filter((row) => row.delivered === null || row.delivered === undefined).length;
    // The headline grounding metric is deliberately narrow: evidence-mode
    // injections triggered by a user prompt. session_start has a different
    // delivery shape, and explicit_search / context_pack are tool calls whose
    // "adoption" means something else — averaging them together produced the
    // 9.1% figure the spec rejects in favour of 18.8% (specs §3.4, R3).
    const allEvidenceRows = rows.filter((row) => row.presentation_mode === 'evidence');
    const evidenceRows = allEvidenceRows.filter((row) => row.trigger_type === 'user_prompt');
    const isEvaluatedAdoption = (row: Record<string, unknown>) =>
      row.adoption === 'grounded' || row.adoption === 'not_observed';
    const evidenceEvaluated = evidenceRows.filter(isEvaluatedAdoption).length;
    const evidenceGrounded = evidenceRows.filter((row) => row.adoption === 'grounded').length;
    const evidenceAllTriggersEvaluated = allEvidenceRows.filter(isEvaluatedAdoption).length;
    const evidenceAllTriggersGrounded = allEvidenceRows.filter((row) => row.adoption === 'grounded').length;
    const references = rows.filter((row) => row.presentation_mode === 'reference');
    const referencesNavigated = references.filter((row) => row.adoption === 'navigated').length;
    const referenceUnknown = references.filter((row) => row.adoption === 'unknown').length;
    const referencesEvaluated = references.length - referenceUnknown;
    const taskEvaluated = rows.filter((row) => row.task_outcome !== 'unknown').length;
    const taskSuccessful = rows.filter((row) => row.task_outcome === 'success').length;
    const explicitPositive = rows.filter((row) => row.explicit_feedback === 'positive').length;
    const explicitNegative = rows.filter((row) => row.explicit_feedback === 'negative').length;
    const feedbackEvaluated = explicitPositive + explicitNegative;
    const unknownByDimension = {
      delivery: deliveryUnknown,
      adoption: rows.filter((row) => row.adoption === 'unknown').length,
      taskOutcome: rows.filter((row) => row.task_outcome === 'unknown').length,
      reaskOutcome: rows.filter((row) => row.reask_outcome === 'unknown').length,
      explicitFeedback: observationCount - feedbackEvaluated
    };
    const rate = (numerator: number, denominator: number, unknown: number): UsefulnessRateV2 => ({
      numerator,
      denominator,
      unknown,
      value: denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : null
    });
    const deliveryStatusCounts = { ...base.deliveryStatusCounts };
    const selectedByKind = { ...base.selectedByKind };
    for (const row of rows) {
      deliveryStatusCounts[normalizeDeliveryStatus(row.delivery_status)] += 1;
      if (Number(row.selected) === 1) selectedByKind[normalizeMemoryKind(row.memory_kind ?? 'event')] += 1;
    }
    return {
      ...base,
      deliveryStatusCounts,
      selectedByKind,
      legacyAssumedDeliveryRows,
      eligible,
      selected,
      delivered,
      evidenceEvaluated,
      evidenceGrounded,
      evidenceAllTriggers: {
        evaluated: evidenceAllTriggersEvaluated,
        grounded: evidenceAllTriggersGrounded,
        unknown: allEvidenceRows.length - evidenceAllTriggersEvaluated
      },
      referencesEligible: references.length,
      referencesNavigated,
      taskOutcomesEvaluated: taskEvaluated,
      taskOutcomesSuccessful: taskSuccessful,
      explicitPositive,
      explicitNegative,
      unknown: Object.values(unknownByDimension).reduce((sum, count) => sum + count, 0),
      unknownByDimension,
      rates: {
        selectionYield: rate(selected, eligible, 0),
        deliveryRate: rate(delivered, observationCount - deliveryUnknown, deliveryUnknown),
        evidenceGrounding: rate(evidenceGrounded, evidenceEvaluated, evidenceRows.length - evidenceEvaluated),
        referenceNavigation: rate(referencesNavigated, referencesEvaluated, referenceUnknown),
        taskSuccess: rate(taskSuccessful, taskEvaluated, unknownByDimension.taskOutcome),
        explicitPositive: rate(explicitPositive, feedbackEvaluated, unknownByDimension.explicitFeedback)
      },
      sampleState: observationCount >= minimumSample ? 'sufficient' : 'insufficient_sample'
    };
  }

  /**
   * Get most helpful memories ranked by helpfulness score
   */
  async getHelpfulMemories(limit: number = 10): Promise<Array<{
    eventId: string;
    summary: string;
    helpfulnessScore: number;
    accessCount: number;
    evaluationCount: number;
  }>> {
    await this.initialize();

    const rows = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT
         mh.event_id,
         AVG(mh.helpfulness_score) as avg_score,
         COUNT(*) as eval_count,
         e.content,
         e.access_count
       FROM memory_helpfulness mh
       JOIN events e ON e.id = mh.event_id
       WHERE mh.measured_at IS NOT NULL
         AND ${notActiveQuarantinedSql('e.metadata')}
       GROUP BY mh.event_id
       ORDER BY avg_score DESC
       LIMIT ?`,
      [limit]
    );

    return rows.map(r => ({
      eventId: r.event_id as string,
      summary: (r.content as string).substring(0, 200) + ((r.content as string).length > 200 ? '...' : ''),
      helpfulnessScore: Math.round((r.avg_score as number) * 100) / 100,
      accessCount: (r.access_count as number) || 0,
      evaluationCount: r.eval_count as number
    }));
  }

  /**
   * Get helpfulness statistics for dashboard
   */
  async getHelpfulnessStats(since?: Date, until?: Date): Promise<{
    avgScore: number;
    totalEvaluated: number;
    totalRetrievals: number;
    helpful: number;
    neutral: number;
    unhelpful: number;
    contentEvaluated: number;
    avgContentOverlap: number;
    groundedCount: number;
  }> {
    await this.initialize();

    const sinceIso = since?.toISOString();
    const untilIso = until?.toISOString();
    const timeClauses: string[] = [];
    const timeParams: string[] = [];
    if (sinceIso) {
      timeClauses.push('datetime(created_at) >= datetime(?)');
      timeParams.push(sinceIso);
    }
    if (untilIso) {
      timeClauses.push('datetime(created_at) < datetime(?)');
      timeParams.push(untilIso);
    }
    const timeWhere = timeClauses.length > 0 ? `WHERE ${timeClauses.join(' AND ')}` : '';
    const evaluatedWhere = timeClauses.length > 0
      ? `WHERE measured_at IS NOT NULL AND ${timeClauses.join(' AND ')}`
      : 'WHERE measured_at IS NOT NULL';

    // Read-only dashboards can open legacy DBs where the grounding-column
    // migration never ran; degrade to zeros instead of failing the query.
    const hasGroundingColumns = this.hasTableColumn('memory_helpfulness', 'content_overlap_score');
    const groundingSelect = hasGroundingColumns
      ? `COUNT(content_overlap_score) as content_evaluated,
         AVG(content_overlap_score) as avg_content_overlap,
         SUM(CASE WHEN content_overlap_score >= 0.3 THEN 1 ELSE 0 END) as grounded_count`
      : `0 as content_evaluated, 0 as avg_content_overlap, 0 as grounded_count`;

    const stats = sqliteGet<Record<string, unknown>>(
      this.db,
      `SELECT
         AVG(helpfulness_score) as avg_score,
         COUNT(*) as total_evaluated,
         SUM(CASE WHEN helpfulness_score >= 0.7 THEN 1 ELSE 0 END) as helpful,
         SUM(CASE WHEN helpfulness_score >= 0.4 AND helpfulness_score < 0.7 THEN 1 ELSE 0 END) as neutral,
         SUM(CASE WHEN helpfulness_score < 0.4 THEN 1 ELSE 0 END) as unhelpful,
         ${groundingSelect}
       FROM memory_helpfulness
       ${evaluatedWhere}`,
      timeParams
    );

    const totalRow = sqliteGet<Record<string, unknown>>(
      this.db,
      `SELECT COUNT(*) as total FROM memory_helpfulness ${timeWhere}`,
      timeParams
    );

    return {
      avgScore: Math.round(((stats?.avg_score as number) || 0) * 100) / 100,
      totalEvaluated: (stats?.total_evaluated as number) || 0,
      totalRetrievals: (totalRow?.total as number) || 0,
      helpful: (stats?.helpful as number) || 0,
      neutral: (stats?.neutral as number) || 0,
      unhelpful: (stats?.unhelpful as number) || 0,
      contentEvaluated: (stats?.content_evaluated as number) || 0,
      avgContentOverlap: Math.round(((stats?.avg_content_overlap as number) || 0) * 100) / 100,
      groundedCount: (stats?.grounded_count as number) || 0
    };
  }

  /**
   * Aggregate helpfulness by UTC day with one range scan.
   *
   * Both legacy SQLite timestamps (`YYYY-MM-DD HH:mm:ss`) and current ISO
   * timestamps share a sortable `YYYY-MM-DD` prefix. Date-only boundaries
   * therefore preserve compatibility while allowing idx_helpfulness_created_at
   * to serve the range predicate (unlike datetime(created_at)).
   */
  async getHelpfulnessStatsByDay(since: Date, until: Date): Promise<Array<{
    date: string;
    avgScore: number;
    totalEvaluated: number;
    totalRetrievals: number;
    helpful: number;
    neutral: number;
    unhelpful: number;
  }>> {
    await this.initialize();
    const sinceDay = since.toISOString().slice(0, 10);
    const untilDay = until.toISOString().slice(0, 10);
    const rows = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT
         substr(created_at, 1, 10) AS date,
         AVG(CASE WHEN measured_at IS NOT NULL THEN helpfulness_score END) AS avg_score,
         SUM(CASE WHEN measured_at IS NOT NULL THEN 1 ELSE 0 END) AS total_evaluated,
         COUNT(*) AS total_retrievals,
         SUM(CASE WHEN measured_at IS NOT NULL AND helpfulness_score >= 0.7 THEN 1 ELSE 0 END) AS helpful,
         SUM(CASE WHEN measured_at IS NOT NULL AND helpfulness_score >= 0.4 AND helpfulness_score < 0.7 THEN 1 ELSE 0 END) AS neutral,
         SUM(CASE WHEN measured_at IS NOT NULL AND helpfulness_score < 0.4 THEN 1 ELSE 0 END) AS unhelpful
       FROM memory_helpfulness
       WHERE created_at >= ? AND created_at < ?
       GROUP BY substr(created_at, 1, 10)
       ORDER BY date ASC`,
      [sinceDay, untilDay]
    );

    return rows.map((row) => ({
      date: String(row.date || ''),
      avgScore: Math.round(((row.avg_score as number) || 0) * 100) / 100,
      totalEvaluated: (row.total_evaluated as number) || 0,
      totalRetrievals: (row.total_retrievals as number) || 0,
      helpful: (row.helpful as number) || 0,
      neutral: (row.neutral as number) || 0,
      unhelpful: (row.unhelpful as number) || 0
    }));
  }

  /**
   * Per-question usefulness history: each retrieval query (or session-start
   * injection batch) with the memories it injected, their measured
   * helpfulness, content grounding, and evidence snippets. Powers the
   * dashboard's evidence-history drill-down.
   */
  async getUsefulnessHistory(options: {
    limit?: number;
    offset?: number;
    sessionId?: string;
    withSelectionsOnly?: boolean;
  } = {}): Promise<Array<{
    traceId: string | null;
    kind: 'query' | 'session_start';
    sessionId: string | null;
    question: string;
    queryText: string | null;
    strategy: string | null;
    confidence: string | null;
    candidateCount: number;
    selectedCount: number;
    createdAt: Date;
    memories: Array<{
      eventId: string;
      eventType: string | null;
      summary: string;
      retrievalScore: number;
      helpfulnessScore: number | null;
      contentOverlapScore: number | null;
      evidence: EvidenceMatch[];
      measuredAt: string | null;
      source: string;
      presentationMode: RetrievalPresentationMode;
    }>;
    presentationMode: RetrievalPresentationMode;
  }>> {
    await this.initialize();

    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const offset = Math.max(options.offset ?? 0, 0);

    // Read-only dashboards can open legacy DBs where the trace-link migration
    // (trace_id/source columns) never ran; fall back to trace-only history.
    const hasTraceLink = this.hasTableColumn('memory_helpfulness', 'trace_id');
    const hasTraceTrigger = this.hasTableColumn('retrieval_traces', 'trigger_type');
    const hasTracePresentation = this.hasTableColumn('retrieval_traces', 'presentation_mode');
    const traceKindSql = hasTraceTrigger
      ? `CASE WHEN trigger_type = 'session_start' THEN 'session_start' ELSE 'query' END`
      : `'query'`;

    const sessionFilterTrace = options.sessionId ? `AND session_id = ?` : '';
    const selectionFilter = options.withSelectionsOnly ? `AND selected_count > 0` : '';
    const params: unknown[] = [];
    if (options.sessionId) params.push(options.sessionId);
    if (hasTraceLink && options.sessionId) params.push(options.sessionId);
    params.push(limit, offset);

    // Unified, paginated timeline of "questions": retrieval traces plus
    // session-start injection batches (which have no retrieval_traces row).
    const sessionStartBranch = hasTraceLink
      ? `UNION ALL
         SELECT 'session_start' AS kind,
                COALESCE(trace_id, 'ss-' || session_id) AS id,
                session_id,
                MIN(created_at) AS created_at
         FROM memory_helpfulness
         WHERE source = 'session_start'
           AND (trace_id IS NULL OR NOT EXISTS (
             SELECT 1 FROM retrieval_traces rt WHERE rt.trace_id = memory_helpfulness.trace_id
           )) ${sessionFilterTrace}
         GROUP BY COALESCE(trace_id, 'ss-' || session_id), session_id`
      : '';
    const heads = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM (
         SELECT ${traceKindSql} AS kind, trace_id AS id, session_id, created_at
         FROM retrieval_traces
         WHERE 1=1 ${sessionFilterTrace} ${selectionFilter}
         ${sessionStartBranch}
       )
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      params
    );

    const entries: Array<{
      traceId: string | null;
      kind: 'query' | 'session_start';
      sessionId: string | null;
      question: string;
      queryText: string | null;
      strategy: string | null;
      confidence: string | null;
      candidateCount: number;
      selectedCount: number;
      createdAt: Date;
      memories: Array<{
        eventId: string;
        eventType: string | null;
        summary: string;
        retrievalScore: number;
        helpfulnessScore: number | null;
        contentOverlapScore: number | null;
        evidence: EvidenceMatch[];
        measuredAt: string | null;
        source: string;
        presentationMode: RetrievalPresentationMode;
      }>;
      presentationMode: RetrievalPresentationMode;
    }> = [];

    for (const head of heads) {
      const kind = head.kind as 'query' | 'session_start';
      const headId = head.id as string;

      let trace: Record<string, unknown> | undefined;
      if (!headId.startsWith('ss-')) {
        trace = sqliteGet<Record<string, unknown>>(
          this.db,
          `SELECT * FROM retrieval_traces WHERE trace_id = ?`,
          [headId]
        );
        if (!trace && kind === 'query') continue;
      }

      // Helpfulness rows for this head: primary link via trace_id; legacy
      // fallback matches by session + selected event id within ±3 minutes.
      let helpRows: Record<string, unknown>[] = hasTraceLink
        ? sqliteAll<Record<string, unknown>>(
          this.db,
          `SELECT * FROM memory_helpfulness WHERE trace_id = ? ORDER BY created_at ASC`,
          [headId]
        )
        : [];
      if (helpRows.length === 0 && trace) {
        const selectedIds: string[] = (() => {
          try { return JSON.parse((trace.selected_event_ids as string) || '[]'); } catch { return []; }
        })();
        if (selectedIds.length > 0 && trace.session_id) {
          const legacyOnlyFilter = hasTraceLink ? `AND trace_id IS NULL` : '';
          helpRows = sqliteAll<Record<string, unknown>>(
            this.db,
            `SELECT * FROM memory_helpfulness
             WHERE session_id = ? ${legacyOnlyFilter}
               AND event_id IN (${selectedIds.map(() => '?').join(',')})
               AND ABS(strftime('%s', created_at) - strftime('%s', ?)) <= 180
             ORDER BY created_at ASC`,
            [trace.session_id, ...selectedIds, trace.created_at]
          );
        }
      }
      if (kind === 'session_start' && helpRows.length === 0 && !trace) {
        helpRows = sqliteAll<Record<string, unknown>>(
          this.db,
          `SELECT * FROM memory_helpfulness
           WHERE source = 'session_start' AND trace_id IS NULL AND session_id = ?
           ORDER BY created_at ASC`,
          [head.session_id]
        );
      }

      // Hydrate memory summaries. Lessons are not events: joining every id
      // against `events` rendered each injected lesson as "no longer
      // available", which is what made lesson selections look like data loss.
      const hasHelpfulnessKind = this.hasTableColumn('memory_helpfulness', 'memory_kind');
      const kindOf = (row: Record<string, unknown>): MemoryKind =>
        hasHelpfulnessKind ? normalizeMemoryKind(row.memory_kind) : 'event';
      const eventIds = Array.from(new Set(helpRows
        .filter((row) => kindOf(row) === 'event' || kindOf(row) === 'unknown')
        .map((row) => row.event_id as string)
        .filter(Boolean)));
      const lessonIds = Array.from(new Set(helpRows
        .filter((row) => kindOf(row) === 'lesson')
        .map((row) => row.event_id as string)
        .filter(Boolean)));
      const eventById = new Map<string, { content: string; event_type: string }>();
      if (eventIds.length > 0) {
        const rows = sqliteAll<{ id: string; content: string; event_type: string }>(
          this.db,
          `SELECT id, content, event_type FROM events WHERE id IN (${eventIds.map(() => '?').join(',')})`,
          eventIds
        );
        for (const row of rows) eventById.set(row.id, row);
      }
      if (lessonIds.length > 0 && this.hasTable('memory_lessons')) {
        const rows = sqliteAll<{ lesson_id: string; name: string; trigger: string }>(
          this.db,
          `SELECT lesson_id, name, trigger FROM memory_lessons WHERE lesson_id IN (${lessonIds.map(() => '?').join(',')})`,
          lessonIds
        );
        for (const row of rows) {
          eventById.set(row.lesson_id, {
            content: [row.name, row.trigger].filter(Boolean).join(' — '),
            event_type: 'lesson'
          });
        }
      }

      const memories = helpRows.map((row) => {
        const event = eventById.get(row.event_id as string);
        let evidence: EvidenceMatch[] = [];
        try {
          const parsed = JSON.parse((row.evidence_json as string) || '[]');
          if (Array.isArray(parsed)) evidence = parsed;
        } catch { /* legacy/corrupt rows have no evidence */ }
        const summary = event
          ? event.content.substring(0, 240) + (event.content.length > 240 ? '…' : '')
          : '(event no longer available)';
        return {
          eventId: row.event_id as string,
          eventType: event?.event_type ?? null,
          summary,
          retrievalScore: (row.retrieval_score as number) ?? 0,
          helpfulnessScore: row.measured_at ? ((row.helpfulness_score as number) ?? null) : null,
          contentOverlapScore: (row.content_overlap_score as number) ?? null,
          evidence,
          measuredAt: (row.measured_at as string) ?? null,
          source: (row.source as string) || 'user_prompt',
          presentationMode: normalizeRetrievalPresentationMode(row.presentation_mode)
        };
      });

      if (trace) {
        entries.push({
          traceId: headId,
          kind,
          sessionId: (trace.session_id as string) ?? null,
          question: kind === 'session_start'
            ? (normalizeRetrievalPresentationMode(trace.presentation_mode) === 'core'
              ? 'Session start — core memory injected'
              : 'Session start — recent project context injected')
            : (trace.raw_query_text as string) || (trace.query_text as string) || '',
          queryText: (trace.query_text as string) ?? null,
          strategy: (trace.strategy as string) ?? null,
          confidence: (trace.confidence as string) ?? null,
          candidateCount: (trace.candidate_count as number) ?? 0,
          selectedCount: (trace.selected_count as number) ?? 0,
          createdAt: toDateFromSQLite(trace.created_at as string),
          presentationMode: hasTracePresentation
            ? normalizeRetrievalPresentationMode(trace.presentation_mode)
            : 'unknown',
          memories
        });
      } else {
        entries.push({
          traceId: headId.startsWith('ss-') ? null : headId,
          kind: 'session_start',
          sessionId: (head.session_id as string) ?? null,
          question: 'Session start — recent project context injected',
          queryText: null,
          strategy: 'session-start',
          confidence: null,
          candidateCount: memories.length,
          selectedCount: memories.length,
          createdAt: toDateFromSQLite(head.created_at as string),
          presentationMode: 'unknown',
          memories
        });
      }
    }

    return entries;
  }

  /**
   * Fast keyword search using FTS5
   * Returns events matching the search query, ranked by relevance
   */
  async keywordSearch(
    query: string,
    limit: number = 10,
    options?: { includeToolObservations?: boolean }
  ): Promise<Array<{event: MemoryEvent; rank: number}>> {
    await this.initialize();

    // tool_observation events typically outnumber prompts/answers several-fold
    // (they are kept as events but excluded from embedding), so an unfiltered
    // FTS query returns mostly raw tool output and crowds answer-type events
    // out of the limit window. Excluded by default to mirror the embedding
    // policy; callers that intentionally want tool evidence (episode seeding,
    // explicit eventType filters) opt in.
    const includeToolObservations = options?.includeToolObservations === true;
    const toolObservationSql = includeToolObservations ? '' : `AND e.event_type != 'tool_observation'`;

    // Escape special FTS5 characters and prepare search terms
    const searchTerms = query
      .replace(/['"(){}[\]^~*?:\\/-]/g, ' ')  // Remove special chars
      .split(/\s+/)
      .filter(term => term.length > 1)  // Filter short terms
      .map(term => `"${term}"*`)  // Prefix matching
      .join(' OR ');

    if (!searchTerms) {
      return [];
    }

    try {
      const rows = sqliteAll<Record<string, unknown>>(
        this.db,
        `SELECT e.*, fts.rank
         FROM events_fts fts
         JOIN events e ON e.id = fts.event_id
         WHERE events_fts MATCH ?
           AND ${notActiveQuarantinedSql('e.metadata')}
           ${toolObservationSql}
         ORDER BY fts.rank
         LIMIT ?`,
        [searchTerms, limit]
      );

      return rows.map(row => ({
        event: this.rowToEvent(row),
        rank: row.rank as number
      }));
    } catch (error: any) {
      // FTS table might not exist yet (old database)
      // Fallback to LIKE search
      const likePattern = `%${query}%`;
      const rows = sqliteAll<Record<string, unknown>>(
        this.db,
        `SELECT *, 0 as rank FROM events
         WHERE content LIKE ?
           AND ${notActiveQuarantinedSql()}
           ${includeToolObservations ? '' : `AND event_type != 'tool_observation'`}
         ORDER BY timestamp DESC
         LIMIT ?`,
        [likePattern, limit]
      );

      return rows.map(row => ({
        event: this.rowToEvent(row),
        rank: 0
      }));
    }
  }

  /**
   * Dedicated L1+ answer-evidence lane.  Graduation alone is not sufficient:
   * prompts and raw tool output can be promoted for continuity, but only final
   * responses/summaries are allowed to compete as direct answer evidence.
   */
  async searchGraduatedEvidence(
    query: string,
    limit: number = 10
  ): Promise<Array<{ event: MemoryEvent; rank: number; level: string; accessCount: number }>> {
    await this.initialize();
    const searchTerms = query
      .replace(/['"(){}[\]^~*?:\\/-]/g, ' ')
      .split(/\s+/)
      .filter(term => term.length > 1)
      .map(term => `"${term}"*`)
      .join(' OR ');
    if (!searchTerms) return [];

    try {
      const rows = sqliteAll<Record<string, unknown>>(
        this.db,
        `SELECT e.*, fts.rank, ml.level
         FROM events_fts fts
         JOIN events e ON e.id = fts.event_id
         JOIN memory_levels ml ON ml.event_id = e.id
         WHERE events_fts MATCH ?
           AND ml.level != 'L0'
           AND e.event_type IN ('user_prompt', 'agent_response', 'session_summary')
           AND ${notActiveQuarantinedSql('e.metadata')}
         ORDER BY fts.rank, ml.level DESC, e.access_count DESC
         LIMIT ?`,
        [searchTerms, limit]
      );
      return rows.map((row) => ({
        event: this.rowToEvent(row),
        rank: Number(row.rank),
        level: String(row.level),
        accessCount: Number(row.access_count ?? 0)
      }));
    } catch {
      return [];
    }
  }

  /**
   * Rebuild FTS index from existing events
   * Call this once after upgrading to FTS5
   */
  /**
   * Drop and recreate the events_fts virtual table + sync triggers, repopulating
   * from the current events table. Recreating the table (instead of issuing
   * DELETEs against it) sidesteps a quirk where older migrated FTS5 tables fail
   * with `no such column: T.event_id` on synthetic deletes. Safe to call inside
   * a transaction (pure DDL + INSERT...SELECT, no transaction control).
   */
  private recreateEventsFtsTable(): void {
    sqliteExec(this.db, `
      DROP TRIGGER IF EXISTS events_fts_insert;
      DROP TRIGGER IF EXISTS events_fts_delete;
      DROP TRIGGER IF EXISTS events_fts_update;
      DROP TABLE IF EXISTS events_fts;

      CREATE VIRTUAL TABLE events_fts USING fts5(
        content,
        event_id UNINDEXED,
        tokenize='porter unicode61'
      );

      INSERT INTO events_fts(rowid, content, event_id)
      SELECT rowid, content, id FROM events;

      CREATE TRIGGER events_fts_insert AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(rowid, content, event_id) VALUES (NEW.rowid, NEW.content, NEW.id);
      END;

      CREATE TRIGGER events_fts_delete AFTER DELETE ON events BEGIN
        DELETE FROM events_fts WHERE rowid = OLD.rowid;
      END;

      CREATE TRIGGER events_fts_update AFTER UPDATE ON events BEGIN
        DELETE FROM events_fts WHERE rowid = OLD.rowid;
        INSERT INTO events_fts(rowid, content, event_id) VALUES (NEW.rowid, NEW.content, NEW.id);
      END;
    `);
  }

  async rebuildFtsIndex(): Promise<number> {
    await this.initialize();

    // Get count of events to index
    const countRow = sqliteGet<{count: number}>(this.db, 'SELECT COUNT(*) as count FROM events', []);
    const totalEvents = countRow?.count ?? 0;

    this.recreateEventsFtsTable();

    return totalEvents;
  }

  /**
   * Get database instance for direct access
   */
  getDatabase(): SQLiteDatabase {
    return this.db;
  }

  private hasTableColumn(tableName: string, columnName: string): boolean {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) return false;
    try {
      const rows = sqliteAll<{ name: string }>(this.db, `PRAGMA table_info("${tableName}")`, []);
      return rows.some((row) => row.name === columnName);
    } catch {
      return false;
    }
  }

  private hasTable(tableName: string): boolean {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) return false;
    try {
      const rows = sqliteAll<{ name: string }>(
        this.db,
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
        [tableName]
      );
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Add a column only when its table exists and the column is missing.
   *
   * Unlike a blind `try { ALTER } catch {}`, this distinguishes "already
   * migrated" / "table not present yet" (both safely skipped) from a genuine
   * failure (disk full, corruption), which is allowed to surface instead of
   * being silently swallowed as if the migration had succeeded.
   */
  private addColumnIfMissing(table: string, column: string, definition: string): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
      throw new Error(`Invalid identifier in migration: ${table}.${column}`);
    }
    if (!this.hasTable(table)) return;
    if (this.hasTableColumn(table, column)) return;
    sqliteExec(this.db, `ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }


  async recordRetrievalTrace(input: {
    traceId?: string;
    sessionId?: string;
    projectHash?: string;
    queryText: string;
    rawQueryText?: string;
    queryRewriteKind?: string;
    strategy?: string;
    candidateEventIds: string[];
    selectedEventIds: string[];
    candidateDetails?: Array<{
      eventId: string;
      score: number;
      semanticScore?: number;
      lexicalScore?: number;
      recencyScore?: number;
      lanes?: RetrievalDebugLane[];
    }>;
    selectedDetails?: Array<{
      eventId: string;
      score: number;
      semanticScore?: number;
      lexicalScore?: number;
      recencyScore?: number;
      lanes?: RetrievalDebugLane[];
    }>;
    confidence?: string;
    fallbackTrace?: string[];
    presentationMode?: RetrievalPresentationMode;
    triggerType?: RetrievalTriggerType;
    deliveryClient?: string;
    outcomeDiagnostics?: RetrievalOutcomeDiagnostics;
    /** Typed references (specs R1). Preferred over the id arrays by new readers. */
    items?: RetrievalTraceItemInput[];
    /** Stable id of the caller request; a repeat write updates instead of duplicating. */
    requestId?: string;
    evaluationRunId?: string;
    runtimeVersion?: string;
  }): Promise<string | undefined> {
    if (this.readOnly) return undefined;
    await this.initialize();

    const requestId = normalizeRequestId(input.requestId);
    const queryRewriteKind = normalizeQueryRewriteKind(input.queryRewriteKind);
    const candidateDetails = normalizeRetrievalTraceDetails(input.candidateDetails);
    const selectedDetails = normalizeRetrievalTraceDetails(input.selectedDetails);
    // No diagnostics and no selection is "we did not classify this", not a
    // runtime failure. `runtime_error` is now written only by a caller that
    // actually caught an exception (specs R2).
    const outcomeDiagnostics = normalizeRetrievalOutcomeDiagnostics(
      input.outcomeDiagnostics,
      input.selectedEventIds.length > 0 ? 'selected' : 'unknown'
    );
    const values = [
      input.sessionId || null,
      input.projectHash || null,
      input.queryText,
      input.rawQueryText || null,
      queryRewriteKind,
      input.strategy || null,
      JSON.stringify(input.candidateEventIds || []),
      JSON.stringify(input.selectedEventIds || []),
      JSON.stringify(candidateDetails),
      JSON.stringify(selectedDetails),
      (input.candidateEventIds || []).length,
      (input.selectedEventIds || []).length,
      input.confidence || null,
      JSON.stringify(input.fallbackTrace || []),
      normalizeRetrievalPresentationMode(input.presentationMode),
      normalizeRetrievalTriggerType(input.triggerType),
      normalizeTelemetryClient(input.deliveryClient),
      outcomeDiagnostics.outcomeReason,
      JSON.stringify(outcomeDiagnostics),
      requestId,
      normalizeRequestId(input.evaluationRunId),
      input.runtimeVersion?.slice(0, 64) || null,
      RETRIEVAL_TELEMETRY_SCHEMA_VERSION
    ];

    const updateSql = `UPDATE retrieval_traces SET
           session_id = ?, project_hash = ?, query_text = ?, raw_query_text = ?,
           query_rewrite_kind = ?, strategy = ?, candidate_event_ids = ?, selected_event_ids = ?,
           candidate_details_json = ?, selected_details_json = ?, candidate_count = ?,
           selected_count = ?, confidence = ?, fallback_trace = ?, presentation_mode = ?,
           trigger_type = ?, delivery_client = ?, outcome_reason = ?, retrieval_diagnostics_json = ?,
           request_id = ?, evaluation_run_id = ?, runtime_version = ?, telemetry_schema_version = ?
         WHERE trace_id = ?`;
    const insertSql = `INSERT INTO retrieval_traces (
          session_id, project_hash, query_text, raw_query_text, query_rewrite_kind, strategy,
          candidate_event_ids, selected_event_ids, candidate_details_json, selected_details_json,
          candidate_count, selected_count, confidence, fallback_trace,
          presentation_mode, trigger_type, delivery_client, outcome_reason, retrieval_diagnostics_json,
          request_id, evaluation_run_id, runtime_version, telemetry_schema_version, trace_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    // The same request can be traced twice (the orchestrator's automatic trace
    // plus an explicit hook trace). Collapsing on requestId keeps one request
    // equal to one row so client coverage is not double-counted.
    //
    // The lookup and the write run inside one immediate transaction and the
    // request id carries a unique index where the store allows one, so a
    // concurrent writer in another process cannot slip a second row in between
    // the SELECT and the INSERT (finding 9). Where the index could not be
    // created (a store that already holds duplicate request ids), the
    // transaction still serializes this process's own writers.
    const write = (): { traceId: string; replacedExisting: boolean } => {
      const existing = requestId
        ? sqliteGet<{ trace_id: string }>(
          this.db,
          `SELECT trace_id FROM retrieval_traces WHERE request_id = ? LIMIT 1`,
          [requestId]
        )
        : undefined;
      const resolvedTraceId = existing?.trace_id || input.traceId || randomUUID();
      if (existing) {
        sqliteRun(this.db, updateSql, [...values, resolvedTraceId]);
        return { traceId: resolvedTraceId, replacedExisting: true };
      }
      try {
        sqliteRun(this.db, insertSql, [...values, resolvedTraceId]);
        return { traceId: resolvedTraceId, replacedExisting: false };
      } catch (error) {
        // Lost the race against another writer holding the same request id:
        // adopt its row instead of creating a duplicate.
        if (!requestId) throw error;
        const raced = sqliteGet<{ trace_id: string }>(
          this.db,
          `SELECT trace_id FROM retrieval_traces WHERE request_id = ? LIMIT 1`,
          [requestId]
        );
        if (!raced) throw error;
        sqliteRun(this.db, updateSql, [...values, raced.trace_id]);
        return { traceId: raced.trace_id, replacedExisting: true };
      }
    };

    return this.runInImmediateTransaction(() => {
      const result = write();
      const hasExistingTypedItems = result.replacedExisting
        && readTraceItems(this.db, result.traceId).length > 0;
      if (retrievalRollout().typedTraceWrite || hasExistingTypedItems) {
        this.writeTypedTraceItems(result.traceId, input, { replaceExisting: result.replacedExisting });
      }
      return result.traceId;
    });
  }

  /**
   * Run `fn` inside an IMMEDIATE transaction when the connection allows it.
   *
   * A read-then-write that must stay atomic across processes needs the write
   * lock taken up front. Reuse an existing transaction, but never bypass a
   * failed lock acquisition: the arrays and typed ledger must commit together.
   */
  private runInImmediateTransaction<T>(fn: () => T): T {
    if (this.db.inTransaction) return fn();
    sqliteExec(this.db, 'BEGIN IMMEDIATE');
    try {
      const result = fn();
      sqliteExec(this.db, 'COMMIT');
      return result;
    } catch (error) {
      try {
        sqliteExec(this.db, 'ROLLBACK');
      } catch { /* the transaction was already resolved */ }
      throw error;
    }
  }

  /**
   * Persist the typed item rows for a trace. Callers that pass explicit items
   * keep their kinds; otherwise ids are resolved read-only against the local
   * tables so an untyped caller still produces correct rows instead of
   * defaulting every reference to "event".
   */
  private writeTypedTraceItems(
    traceId: string,
    input: {
      projectHash?: string;
      candidateEventIds: string[];
      selectedEventIds: string[];
      items?: RetrievalTraceItemInput[];
    },
    options: { replaceExisting?: boolean } = {}
  ): void {
    try {
      const projectId = input.projectHash || null;
      let items: RetrievalTraceItemInput[];
      if (input.items && input.items.length > 0) {
        items = input.items;
      } else {
        const selected = new Set(input.selectedEventIds || []);
        const all = Array.from(new Set([...(input.candidateEventIds || []), ...(input.selectedEventIds || [])]));
        const resolved = resolveMemoryRefKinds(this.db, all, { projectId });
        items = all.map((id, index) => {
          const ref = resolved.get(id);
          return {
            kind: ref?.resolution === 'resolved' ? ref.kind : 'unknown',
            id,
            projectId: ref?.projectId ?? projectId,
            rank: index,
            selected: selected.has(id),
            // Unresolved is not deleted: the row may predate a table or live in
            // a store this process cannot read. `deleted` records an observed
            // deletion only (specs R1).
            deleted: false
          };
        });
      }
      const normalized = normalizeTraceItems(items, { projectId });
      if (options.replaceExisting) {
        // A request-id replay replaces the legacy arrays wholesale. Replace
        // the typed rows wholesale too: the regular UPSERT intentionally keeps
        // selected/deleted monotonic and therefore cannot represent a selected
        // item becoming only a candidate on a corrected replay.
        sqliteRun(this.db, 'DELETE FROM retrieval_trace_items WHERE trace_id = ?', [traceId]);
      }
      writeTraceItems(this.db, traceId, normalized);
    } catch (error) {
      // Let the caller roll back both representations on any ledger failure.
      throw error;
    }
  }

  /** Typed references recorded for a trace (specs R1). */
  async getRetrievalTraceItems(traceId: string) {
    await this.initialize();
    return readTraceItems(this.db, traceId);
  }

  /**
   * Typed selection totals for a window. Traces written before the typed ledger
   * are resolved read-only; nothing is written by this call.
   */
  async getTypedSelectionSummary(options: { since?: Date; until?: Date; resolveLegacy?: boolean } = {}): Promise<TypedSelectionSummary> {
    await this.initialize();
    return summarizeTypedSelections(this.db, options);
  }

  /**
   * Explicit backfill of typed items for legacy traces. Defaults to a dry run;
   * read-only reports never call it.
   */
  async backfillRetrievalTraceItems(options: { dryRun?: boolean; limit?: number; since?: Date } = {}): Promise<TraceItemBackfillResult> {
    await this.initialize();
    if (this.readOnly && options.dryRun === false) {
      throw new Error('retrieval trace item backfill cannot run against a read-only store');
    }
    return options.dryRun === false
      ? this.runInImmediateTransaction(() => backfillTraceItems(this.db, options))
      : backfillTraceItems(this.db, options);
  }

  /**
   * Attribute a reference open to a recent reference delivery only when one
   * trace is the unique candidate. The 15-minute window is deliberately
   * bounded; an optional current session makes the boundary stricter. Client
   * labels are recorded for diagnostics but never used to guess attribution.
   * Repeated opens collapse into one row with an incremented count.
   */
  async recordReferenceNavigation(
    input: RecordReferenceNavigationInput
  ): Promise<RecordReferenceNavigationResult> {
    if (this.readOnly) {
      return { outcome: 'unattributed', traceId: null, repeated: false };
    }
    await this.initialize();
    return recordReferenceNavigationOnDb(this.db, input);
  }

  /**
   * Per-client instrumentation coverage (specs R2).
   *
   * Only requests this store actually saw can be counted. A client that never
   * writes telemetry has no row here at all, and a client whose rows lack a
   * request id reports coverage `unknown` — reporting 0% would assert an
   * observation we do not have.
   */
  async getRetrievalClientCoverage(options: { since?: Date; until?: Date } = {}): Promise<RetrievalClientCoverage[]> {
    await this.initialize();
    if (!this.hasTable('retrieval_traces')) return [];
    const hasRequestId = this.hasTableColumn('retrieval_traces', 'request_id');
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.since) {
      clauses.push('julianday(created_at) >= julianday(?)');
      params.push(options.since.toISOString());
    }
    if (options.until) {
      clauses.push('julianday(created_at) < julianday(?)');
      params.push(options.until.toISOString());
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const instrumentedSql = hasRequestId
      ? `COUNT(DISTINCT CASE WHEN request_id IS NOT NULL THEN request_id END)`
      : '0';
    const observedSql = hasRequestId
      ? `COUNT(DISTINCT COALESCE(request_id, trace_id))`
      : `COUNT(DISTINCT trace_id)`;
    const rows = sqliteAll<{ client: string; observed: number; instrumented: number; unknown_client: number }>(
      this.db,
      `SELECT COALESCE(delivery_client, 'unknown') AS client,
              ${observedSql} AS observed,
              ${instrumentedSql} AS instrumented,
              SUM(CASE WHEN delivery_client IS NULL OR delivery_client = 'unknown' THEN 1 ELSE 0 END) AS unknown_client
       FROM retrieval_traces${where}
       GROUP BY COALESCE(delivery_client, 'unknown')
       ORDER BY observed DESC`,
      params
    );
    return rows.map((row) => {
      const observed = Number(row.observed || 0);
      const instrumented = Number(row.instrumented || 0);
      const unobserved = Number(row.unknown_client || 0);
      return {
        client: String(row.client || 'unknown'),
        observedRequests: observed,
        instrumentedRequests: instrumented,
        unobservedOrUnknown: unobserved,
        coverage: observed > 0 && instrumented > 0
          ? Math.round((instrumented / observed) * 10_000) / 10_000
          : null,
        coverageState: observed > 0 && instrumented > 0 ? 'measured' : 'unknown'
      };
    });
  }

  /**
   * Per-source ingest clocks and lag (specs R4).
   *
   * `timestamp` is when this store wrote the row; importers additionally keep
   * the original conversation instant. Reporting them per source is what makes
   * an importer backlog visible instead of looking like "old memories". Rows
   * whose original instant is unknown are counted, never assumed lag-free.
   */
  async getIngestSourceClocks(options: { since?: Date; until?: Date } = {}): Promise<Array<{
    source: string;
    events: number;
    withSourceClock: number;
    unknownSourceClock: number;
    latestOccurredAt: string | null;
    latestIngestedAt: string | null;
    maxLagMs: number | null;
    medianLagMs: number | null;
  }>> {
    await this.initialize();
    if (!this.hasTable('events')) return [];
    return readIngestSourceClocks(this.db, options);
  }

  async getRetrievalTelemetryStats(): Promise<RetrievalTelemetryStats> {
    await this.initialize();

    const hasTracePresentation = this.hasTableColumn('retrieval_traces', 'presentation_mode');
    const hasTraceTrigger = this.hasTableColumn('retrieval_traces', 'trigger_type');
    const hasHelpfulnessTable = Boolean(sqliteGet<{ name: string }>(
      this.db,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_helpfulness'`
    ));
    const hasHelpfulnessPresentation = hasHelpfulnessTable
      && this.hasTableColumn('memory_helpfulness', 'presentation_mode');
    const hasNavigationTable = Boolean(sqliteGet<{ name: string }>(
      this.db,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'retrieval_navigation_events'`
    ));
    const presentationSql = hasTracePresentation
      ? "COALESCE(NULLIF(TRIM(presentation_mode), ''), 'unknown')"
      : "'unknown'";
    const triggerSql = hasTraceTrigger
      ? "COALESCE(NULLIF(TRIM(trigger_type), ''), 'unknown')"
      : "'unknown'";

    const presentationRows = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT ${presentationSql} AS label, COUNT(*) AS trace_count,
              COALESCE(SUM(selected_count), 0) AS item_count
       FROM retrieval_traces GROUP BY ${presentationSql} ORDER BY label ASC`
    );
    const triggerRows = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT ${triggerSql} AS label, COUNT(*) AS trace_count,
              COALESCE(SUM(selected_count), 0) AS item_count
       FROM retrieval_traces GROUP BY ${triggerSql} ORDER BY label ASC`
    );
    const deliveryTotals = sqliteGet<Record<string, unknown>>(
      this.db,
      `SELECT COUNT(*) AS trace_count, COALESCE(SUM(selected_count), 0) AS item_count FROM retrieval_traces`
    );
    const legacyUnknownRows = hasHelpfulnessTable
      ? sqliteGet<{ count: number }>(
          this.db,
          hasHelpfulnessPresentation
            ? `SELECT COUNT(*) AS count FROM memory_helpfulness WHERE presentation_mode = 'unknown' OR presentation_mode IS NULL`
            : `SELECT COUNT(*) AS count FROM memory_helpfulness`
        )?.count ?? 0
      : 0;

    const evidence = hasHelpfulnessPresentation
      ? sqliteGet<Record<string, unknown>>(
          this.db,
          `SELECT COUNT(content_overlap_score) AS evaluated,
                  SUM(CASE WHEN content_overlap_score >= 0.3 THEN 1 ELSE 0 END) AS grounded,
                  AVG(content_overlap_score) AS average_overlap
           FROM memory_helpfulness
           WHERE presentation_mode = 'evidence'`
        )
      : undefined;
    const referenceEligible = hasTracePresentation
      ? Number(sqliteGet<{ count: number }>(
          this.db,
          `SELECT COUNT(*) AS count FROM retrieval_traces
           WHERE presentation_mode = 'reference' AND selected_count > 0`
        )?.count ?? 0)
      : 0;
    const navigation = hasNavigationTable
      ? sqliteGet<Record<string, unknown>>(
          this.db,
          `SELECT
             COUNT(DISTINCT CASE WHEN attribution_outcome = 'attributed' THEN trace_id END) AS navigated_traces,
             SUM(CASE WHEN attribution_outcome = 'attributed' THEN open_count ELSE 0 END) AS attributed_opens,
             SUM(CASE WHEN attribution_outcome = 'ambiguous' THEN open_count ELSE 0 END) AS ambiguous_opens,
             SUM(CASE WHEN attribution_outcome = 'unattributed' THEN open_count ELSE 0 END) AS unattributed_opens
           FROM retrieval_navigation_events`
        )
      : undefined;
    const evidenceEvaluated = Number(evidence?.evaluated || 0);
    const evidenceGrounded = Number(evidence?.grounded || 0);
    const navigatedTraces = Number(navigation?.navigated_traces || 0);

    return {
      deliveries: {
        totalTraces: Number(deliveryTotals?.trace_count || 0),
        totalItems: Number(deliveryTotals?.item_count || 0),
        byPresentation: presentationRows.map((row) => ({
          presentationMode: normalizeRetrievalPresentationMode(row.label),
          traceCount: Number(row.trace_count || 0),
          deliveredItemCount: Number(row.item_count || 0)
        })),
        byTrigger: triggerRows.map((row) => ({
          triggerType: normalizeRetrievalTriggerType(row.label),
          traceCount: Number(row.trace_count || 0),
          deliveredItemCount: Number(row.item_count || 0)
        })),
        legacyUnknownRows: Number(legacyUnknownRows)
      },
      evidenceGrounding: {
        evaluatedDeliveries: evidenceEvaluated,
        groundedDeliveries: evidenceGrounded,
        groundingRate: evidenceEvaluated > 0 ? evidenceGrounded / evidenceEvaluated : 0,
        averageContentOverlap: Number(evidence?.average_overlap || 0)
      },
      referenceNavigation: {
        eligibleTraces: referenceEligible,
        navigatedTraces,
        navigationRate: referenceEligible > 0 ? navigatedTraces / referenceEligible : 0,
        attributedOpenCount: Number(navigation?.attributed_opens || 0),
        ambiguousOpenCount: Number(navigation?.ambiguous_opens || 0),
        unattributedOpenCount: Number(navigation?.unattributed_opens || 0)
      }
    };
  }

  async getRecentRetrievalTraces(limit: number = 50): Promise<Array<{
    traceId: string;
    sessionId?: string;
    projectHash?: string;
    queryText: string;
    rawQueryText?: string;
    queryRewriteKind?: string;
    strategy?: string;
    candidateEventIds: string[];
    selectedEventIds: string[];
    candidateDetails: Array<{
      eventId: string;
      score: number;
      semanticScore?: number;
      lexicalScore?: number;
      recencyScore?: number;
      lanes?: RetrievalDebugLane[];
    }>;
    selectedDetails: Array<{
      eventId: string;
      score: number;
      semanticScore?: number;
      lexicalScore?: number;
      recencyScore?: number;
      lanes?: RetrievalDebugLane[];
    }>;
    candidateCount: number;
    selectedCount: number;
    confidence?: string;
    fallbackTrace: string[];
    presentationMode: RetrievalPresentationMode;
    triggerType: RetrievalTriggerType;
    deliveryClient: string;
    outcomeDiagnostics: RetrievalOutcomeDiagnostics;
    createdAt: Date;
  }>> {
    await this.initialize();

    try {
      const userQueryWhere = this.hasTableColumn('retrieval_traces', 'trigger_type')
        ? `WHERE COALESCE(trigger_type, 'unknown') != 'session_start'`
        : '';
      const rows = sqliteAll<Record<string, unknown>>(
        this.db,
        `SELECT * FROM retrieval_traces ${userQueryWhere} ORDER BY created_at DESC LIMIT ?`,
        [limit]
      );

      return rows.map((row) => ({
        traceId: row.trace_id as string,
        sessionId: (row.session_id as string) || undefined,
        projectHash: (row.project_hash as string) || undefined,
        queryText: row.query_text as string,
        rawQueryText: (row.raw_query_text as string) || undefined,
        queryRewriteKind: normalizeQueryRewriteKind(row.query_rewrite_kind as string | null),
        strategy: (row.strategy as string) || undefined,
        candidateEventIds: row.candidate_event_ids ? JSON.parse(row.candidate_event_ids as string) : [],
        selectedEventIds: row.selected_event_ids ? JSON.parse(row.selected_event_ids as string) : [],
        candidateDetails: parseRetrievalTraceDetails(row.candidate_details_json),
        selectedDetails: parseRetrievalTraceDetails(row.selected_details_json),
        candidateCount: Number(row.candidate_count || 0),
        selectedCount: Number(row.selected_count || 0),
        confidence: (row.confidence as string) || undefined,
        fallbackTrace: row.fallback_trace ? JSON.parse(row.fallback_trace as string) : [],
        presentationMode: normalizeRetrievalPresentationMode(row.presentation_mode),
        triggerType: normalizeRetrievalTriggerType(row.trigger_type),
        deliveryClient: normalizeTelemetryClient(row.delivery_client),
        outcomeDiagnostics: parseRetrievalOutcomeDiagnostics(row),
        createdAt: toDateFromSQLite(row.created_at),
      }));
    } catch (err: any) {
      if (err?.message?.includes('no such table')) return [];
      throw err;
    }
  }

  async getRetrievalTraceStats(): Promise<{
    totalQueries: number;
    avgCandidateCount: number;
    avgSelectedCount: number;
    selectionRate: number;
    rewrittenQueries: number;
    rewriteRate: number;
    rewrittenQueriesWithSelection: number;
    rawQueriesWithSelection: number;
    rewrittenSelectionRate: number;
    rawSelectionRate: number;
    avgSelectedCountForRewrittenQueries: number;
    avgSelectedCountForRawQueries: number;
    strategyBreakdown: Array<{
      strategy: string;
      totalQueries: number;
      queriesWithSelection: number;
      rewrittenQueries: number;
      rewriteRate: number;
      totalCandidateCount: number;
      totalSelectedCount: number;
      avgCandidateCount: number;
      avgSelectedCount: number;
      selectionRate: number;
      queryYieldRate: number;
    }>;
  }> {
    await this.initialize();

    try {
      const rewrittenQueryRewriteKindSql = this.hasTableColumn('retrieval_traces', 'query_rewrite_kind')
        ? REWRITTEN_QUERY_REWRITE_KIND_SQL
        : '0';
      const userQueryWhere = this.hasTableColumn('retrieval_traces', 'trigger_type')
        ? `WHERE COALESCE(trigger_type, 'unknown') != 'session_start'`
        : '';
      const row = sqliteGet<Record<string, unknown>>(
        this.db,
        `SELECT
          COUNT(*) as total_queries,
          AVG(candidate_count) as avg_candidate_count,
          AVG(selected_count) as avg_selected_count,
          SUM(CASE WHEN ${rewrittenQueryRewriteKindSql} THEN 1 ELSE 0 END) as rewritten_queries,
          SUM(CASE WHEN ${rewrittenQueryRewriteKindSql} AND selected_count > 0 THEN 1 ELSE 0 END) as rewritten_queries_with_selection,
          SUM(CASE WHEN NOT (${rewrittenQueryRewriteKindSql}) AND selected_count > 0 THEN 1 ELSE 0 END) as raw_queries_with_selection,
          AVG(CASE WHEN ${rewrittenQueryRewriteKindSql} THEN selected_count END) as avg_selected_count_for_rewritten_queries,
          AVG(CASE WHEN NOT (${rewrittenQueryRewriteKindSql}) THEN selected_count END) as avg_selected_count_for_raw_queries,
          CASE
            WHEN SUM(candidate_count) > 0 THEN (SUM(selected_count) * 1.0 / SUM(candidate_count))
            ELSE 0
          END as selection_rate
         FROM retrieval_traces
         ${userQueryWhere}`,
        []
      );

      const strategyColumnSql = this.hasTableColumn('retrieval_traces', 'strategy')
        ? "COALESCE(NULLIF(TRIM(strategy), ''), 'unknown')"
        : "'unknown'";
      const strategyRows = sqliteAll<Record<string, unknown>>(
        this.db,
        `SELECT
          ${strategyColumnSql} as strategy,
          COUNT(*) as total_queries,
          SUM(CASE WHEN selected_count > 0 THEN 1 ELSE 0 END) as queries_with_selection,
          SUM(CASE WHEN ${rewrittenQueryRewriteKindSql} THEN 1 ELSE 0 END) as rewritten_queries,
          SUM(candidate_count) as total_candidate_count,
          SUM(selected_count) as total_selected_count,
          AVG(candidate_count) as avg_candidate_count,
          AVG(selected_count) as avg_selected_count,
          CASE
            WHEN SUM(candidate_count) > 0 THEN (SUM(selected_count) * 1.0 / SUM(candidate_count))
            ELSE 0
          END as selection_rate
         FROM retrieval_traces
         ${userQueryWhere}
         GROUP BY ${strategyColumnSql}
         ORDER BY total_queries DESC, strategy ASC`,
        []
      );

      const strategyBreakdown = strategyRows.map((strategyRow) => {
        const strategyTotalQueries = Number(strategyRow.total_queries || 0);
        const strategyQueriesWithSelection = Number(strategyRow.queries_with_selection || 0);
        const strategyRewrittenQueries = Number(strategyRow.rewritten_queries || 0);
        return {
          strategy: String(strategyRow.strategy || 'unknown'),
          totalQueries: strategyTotalQueries,
          queriesWithSelection: strategyQueriesWithSelection,
          rewrittenQueries: strategyRewrittenQueries,
          rewriteRate: strategyTotalQueries > 0 ? strategyRewrittenQueries / strategyTotalQueries : 0,
          totalCandidateCount: Number(strategyRow.total_candidate_count || 0),
          totalSelectedCount: Number(strategyRow.total_selected_count || 0),
          avgCandidateCount: Number(strategyRow.avg_candidate_count || 0),
          avgSelectedCount: Number(strategyRow.avg_selected_count || 0),
          selectionRate: Number(strategyRow.selection_rate || 0),
          queryYieldRate: strategyTotalQueries > 0 ? strategyQueriesWithSelection / strategyTotalQueries : 0,
        };
      });

      const totalQueries = Number(row?.total_queries || 0);
      const rewrittenQueries = Number(row?.rewritten_queries || 0);
      const rawQueries = Math.max(0, totalQueries - rewrittenQueries);
      const rewrittenQueriesWithSelection = Number(row?.rewritten_queries_with_selection || 0);
      const rawQueriesWithSelection = Number(row?.raw_queries_with_selection || 0);

      return {
        totalQueries,
        avgCandidateCount: Number(row?.avg_candidate_count || 0),
        avgSelectedCount: Number(row?.avg_selected_count || 0),
        selectionRate: Number(row?.selection_rate || 0),
        rewrittenQueries,
        rewriteRate: totalQueries > 0 ? rewrittenQueries / totalQueries : 0,
        rewrittenQueriesWithSelection,
        rawQueriesWithSelection,
        rewrittenSelectionRate: rewrittenQueries > 0 ? rewrittenQueriesWithSelection / rewrittenQueries : 0,
        rawSelectionRate: rawQueries > 0 ? rawQueriesWithSelection / rawQueries : 0,
        avgSelectedCountForRewrittenQueries: Number(row?.avg_selected_count_for_rewritten_queries || 0),
        avgSelectedCountForRawQueries: Number(row?.avg_selected_count_for_raw_queries || 0),
        strategyBreakdown,
      };
    } catch (err: any) {
      if (err?.message?.includes('no such table')) {
        return {
          totalQueries: 0,
          avgCandidateCount: 0,
          avgSelectedCount: 0,
          selectionRate: 0,
          rewrittenQueries: 0,
          rewriteRate: 0,
          rewrittenQueriesWithSelection: 0,
          rawQueriesWithSelection: 0,
          rewrittenSelectionRate: 0,
          rawSelectionRate: 0,
          avgSelectedCountForRewrittenQueries: 0,
          avgSelectedCountForRawQueries: 0,
          strategyBreakdown: [],
        };
      }
      throw err;
    }
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    sqliteClose(this.db);
  }

  /**
   * Get events grouped by turn_id for a session
   * Returns turns ordered by first event timestamp (newest first)
   */
  async getSessionTurns(sessionId: string, options?: { limit?: number; offset?: number } & QuarantineReadOptions): Promise<Array<{
    turnId: string;
    events: MemoryEvent[];
    startedAt: Date;
    promptPreview: string;
    eventCount: number;
    toolCount: number;
    hasResponse: boolean;
  }>> {
    await this.initialize();

    const limit = options?.limit || 20;
    const offset = options?.offset || 0;

    // Get distinct turn_ids for this session, ordered by first event timestamp
    const turnRows = sqliteAll<{ turn_id: string; min_ts: string }>(
      this.db,
      `SELECT turn_id, MIN(timestamp) as min_ts
       FROM events
       WHERE session_id = ? AND turn_id IS NOT NULL
         AND ${maybeQuarantinePredicate(options)}
       GROUP BY turn_id
       ORDER BY min_ts DESC
       LIMIT ? OFFSET ?`,
      [sessionId, limit, offset]
    );

    const turns: Array<{
      turnId: string;
      events: MemoryEvent[];
      startedAt: Date;
      promptPreview: string;
      eventCount: number;
      toolCount: number;
      hasResponse: boolean;
    }> = [];

    for (const turnRow of turnRows) {
      const events = await this.getEventsByTurn(turnRow.turn_id, options);

      const promptEvent = events.find(e => e.eventType === 'user_prompt');
      const toolEvents = events.filter(e => e.eventType === 'tool_observation');
      const hasResponse = events.some(e => e.eventType === 'agent_response');

      turns.push({
        turnId: turnRow.turn_id,
        events,
        startedAt: toDateFromSQLite(turnRow.min_ts),
        promptPreview: promptEvent
          ? promptEvent.content.slice(0, 200) + (promptEvent.content.length > 200 ? '...' : '')
          : '(no prompt)',
        eventCount: events.length,
        toolCount: toolEvents.length,
        hasResponse
      });
    }

    return turns;
  }

  /**
   * Get all events for a specific turn_id
   */
  async getEventsByTurn(turnId: string, options?: QuarantineReadOptions): Promise<MemoryEvent[]> {
    await this.initialize();

    const rows = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM events WHERE turn_id = ? AND ${maybeQuarantinePredicate(options)} ORDER BY timestamp ASC`,
      [turnId]
    );

    return rows.map(this.rowToEvent);
  }

  /**
   * Count total turns for a session
   */
  async countSessionTurns(sessionId: string, options?: QuarantineReadOptions): Promise<number> {
    await this.initialize();

    const row = sqliteGet<{ count: number }>(
      this.db,
      `SELECT COUNT(DISTINCT turn_id) as count
       FROM events
       WHERE session_id = ? AND turn_id IS NOT NULL
         AND ${maybeQuarantinePredicate(options)}`,
      [sessionId]
    );

    return row?.count || 0;
  }

  /**
   * Migrate existing events: backfill turn_id for events that have turnId in metadata
   * but no turn_id column value (for events stored before this migration)
   */
  async backfillTurnIds(): Promise<number> {
    await this.initialize();

    // Find events with turnId in metadata JSON but no turn_id column value
    const rows = sqliteAll<{ id: string; metadata: string }>(
      this.db,
      `SELECT id, metadata FROM events
       WHERE turn_id IS NULL AND metadata IS NOT NULL AND metadata LIKE '%turnId%'`
    );

    let updated = 0;
    for (const row of rows) {
      try {
        const metadata = JSON.parse(row.metadata);
        if (metadata.turnId) {
          sqliteRun(
            this.db,
            `UPDATE events SET turn_id = ? WHERE id = ?`,
            [metadata.turnId, row.id]
          );
          updated++;
        }
      } catch {
        // Skip rows with invalid JSON
      }
    }

    return updated;
  }

  /**
   * Delete a single event and everything keyed to it.
   *
   * Deliberately NOT sharing an implementation with `deleteSessionEvents`: that one deletes
   * by `session_id` so it is independent of how many events the session holds, while this one
   * keys on the id. Folding them into one id-list delete would expose the session path to the
   * SQL variable limit and break large sessions.
   *
   * The trigger-drop -> delete -> FTS-rebuild sequence is the same as the session delete and
   * for the same reason: the synthetic FTS delete can fail (`no such column: T.event_id`) on
   * older migrated tables and risks SQLITE_CORRUPT_VTAB. Running it inside a transaction means
   * a failure rolls back instead of leaving the index permanently desynced from its triggers.
   *
   * Returns whether a row was actually removed, so callers can answer 404 for unknown ids.
   * Vectors live in LanceDB and are not touched here — callers that need them gone must also
   * call `VectorStore.deleteEventEverywhere` (see the CLI redact path).
   */
  async deleteEventById(eventId: string): Promise<boolean> {
    await this.initialize();

    const relatedTables = ['event_dedup', 'memory_levels', 'embedding_queue', 'embedding_outbox', 'vector_outbox', 'event_citations']
      .filter((table) => this.hasTable(table) && this.hasTableColumn(table, 'event_id'));

    const runDelete = this.db.transaction((): number => {
      for (const triggerName of ['events_fts_delete', 'events_fts_update', 'events_fts_insert']) {
        sqliteRun(this.db, `DROP TRIGGER IF EXISTS ${triggerName}`);
      }

      for (const table of relatedTables) {
        sqliteRun(this.db, `DELETE FROM ${table} WHERE event_id = ?`, [eventId]);
      }

      const result = sqliteRun(this.db, `DELETE FROM events WHERE id = ?`, [eventId]);

      this.recreateEventsFtsTable();

      return result.changes || 0;
    });

    return runDelete() > 0;
  }

  /**
   * Delete all events for a session (for force reimport)
   */
  async deleteSessionEvents(sessionId: string): Promise<number> {
    await this.initialize();

    // Get event IDs first for cascading deletes
    const events = sqliteAll<{ id: string }>(
      this.db,
      `SELECT id FROM events WHERE session_id = ?`,
      [sessionId]
    );

    if (events.length === 0) return 0;

    const eventIds = events.map(e => e.id);
    const placeholders = eventIds.map(() => '?').join(',');

    // Run the trigger-drop -> delete -> FTS-rebuild -> trigger-recreate sequence
    // atomically. Outside a transaction, a crash or error after the triggers are
    // dropped would permanently desync the FTS index, so keyword search would
    // silently return stale results forever. Inside a transaction any failure
    // rolls back and the triggers/index stay consistent. We pre-check optional
    // table existence (instead of swallowing per-statement errors) so a genuine
    // failure is never mistaken for a benign "table does not exist".
    // Only the tables that both exist and key cascades on event_id. (vector_outbox
    // keys on item_id, not event_id; the previous code swallowed the resulting
    // error, so it was never cleaned here either — behavior preserved.)
    const relatedTables = ['event_dedup', 'memory_levels', 'embedding_queue', 'embedding_outbox', 'vector_outbox', 'event_citations']
      .filter((table) => this.hasTable(table) && this.hasTableColumn(table, 'event_id'));

    const runDelete = this.db.transaction((): number => {
      // Drop FTS sync triggers before the bulk delete so the synthetic FTS
      // delete (which can fail with `no such column: T.event_id` on older
      // migrated tables, and risks SQLITE_CORRUPT_VTAB) never fires mid-delete.
      for (const triggerName of ['events_fts_delete', 'events_fts_update', 'events_fts_insert']) {
        sqliteRun(this.db, `DROP TRIGGER IF EXISTS ${triggerName}`);
      }

      // Delete from related tables first.
      for (const table of relatedTables) {
        sqliteRun(this.db, `DELETE FROM ${table} WHERE event_id IN (${placeholders})`, eventIds);
      }

      // Delete events.
      const result = sqliteRun(this.db, `DELETE FROM events WHERE session_id = ?`, [sessionId]);

      // Recreate the FTS table + triggers from the remaining events. A failure
      // here aborts the whole transaction rather than leaving the index desynced
      // with its triggers permanently dropped.
      this.recreateEventsFtsTable();

      return result.changes || 0;
    });

    return runDelete();
  }

  /**
   * Convert database row to MemoryEvent
   */
  private rowToEvent(row: Record<string, unknown>): MemoryEvent {
    const event: any = {
      id: row.id as string,
      eventType: row.event_type as 'user_prompt' | 'agent_response' | 'session_summary',
      sessionId: row.session_id as string,
      timestamp: toDateFromSQLite(row.timestamp),
      content: row.content as string,
      canonicalKey: row.canonical_key as string,
      dedupeKey: row.dedupe_key as string,
      metadata: safeParseMetadataValue(row.metadata)
    };

    // Include access tracking fields if present
    if (row.access_count !== undefined) {
      event.access_count = row.access_count;
    }
    if (row.last_accessed_at !== undefined) {
      event.last_accessed_at = row.last_accessed_at;
    }
    // Include turn_id if present
    if (row.turn_id !== undefined && row.turn_id !== null) {
      event.turn_id = row.turn_id;
    }

    return event;
  }
}
