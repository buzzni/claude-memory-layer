/**
 * SQLite-based EventStore implementation
 * Primary store for hooks - WAL mode enables concurrent access
 */

import { randomUUID } from 'crypto';
import {
  MemoryEvent,
  MemoryEventInput,
  Session,
  AppendResult,
  OutboxItem,
  OutboxRecoveryOptions,
  OutboxRecoveryResult,
  ProjectScopeRepairOptions,
  ProjectScopeRepairResult,
  ProjectScopeRepairSample
} from './types.js';
import { makeCanonicalKey, makeDedupeKey } from './canonical-key.js';
import * as nodePath from 'path';
import { hashProjectPath } from './registry/project-path.js';
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

export interface SQLiteEventStoreOptions extends SQLiteOptions {
  markdownMirrorRoot?: string;
}

type QueryRewriteKind = 'none' | 'follow-up-context' | 'intent-rewrite';

function normalizeQueryRewriteKind(value?: string | null): QueryRewriteKind {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'follow-up-context' || normalized === 'intent-rewrite') return normalized;
  return 'none';
}

const REWRITTEN_QUERY_REWRITE_KIND_SQL = `LOWER(TRIM(COALESCE(query_rewrite_kind, 'none'))) IN ('follow-up-context', 'intent-rewrite')`;
const DEFAULT_OUTBOX_STUCK_THRESHOLD_MS = 5 * 60 * 1000;
const DEFAULT_OUTBOX_MAX_RETRIES = 3;

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

  constructor(dbPath: string, options?: SQLiteEventStoreOptions) {
    this.readOnly = options?.readonly ?? false;
    this.db = createSQLiteDatabase(dbPath, {
      readonly: this.readOnly,
      walMode: !this.readOnly
    });
    this.markdownMirror = this.readOnly || !options?.markdownMirrorRoot
      ? null
      : new MarkdownMirror(options.markdownMirrorRoot);
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

      -- Edges (relationships between entries/entities)
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
        created_at TEXT DEFAULT (datetime('now')),
        measured_at TEXT
      );

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
        created_at TEXT DEFAULT (datetime('now'))
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_hash, name)
      );

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
      CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(entry_type);
      CREATE INDEX IF NOT EXISTS idx_entries_stage ON entries(stage);
      CREATE INDEX IF NOT EXISTS idx_entries_canonical ON entries(canonical_key);
      CREATE INDEX IF NOT EXISTS idx_entities_type_key ON entities(entity_type, canonical_key);
      CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(status);
      CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_id, rel_type);
      CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_id, rel_type);
      CREATE INDEX IF NOT EXISTS idx_edges_rel ON edges(rel_type);
      CREATE INDEX IF NOT EXISTS idx_outbox_status ON vector_outbox(status);
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
    `);


    // Best-effort forward migration for action edge source ownership
    try {
      sqliteExec(this.db, `ALTER TABLE memory_action_edges ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';`);
    } catch {
      // column may already exist
    }
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

    // Best-effort forward migration for retrieval trace detail column
    try {
      sqliteExec(this.db, `ALTER TABLE retrieval_traces ADD COLUMN selected_details_json TEXT;`);
    } catch {
      // column may already exist
    }
    try {
      sqliteExec(this.db, `ALTER TABLE retrieval_traces ADD COLUMN candidate_details_json TEXT;`);
    } catch {
      // column may already exist
    }
    try {
      sqliteExec(this.db, `ALTER TABLE retrieval_traces ADD COLUMN raw_query_text TEXT;`);
    } catch {
      // column may already exist
    }
    try {
      sqliteExec(this.db, `ALTER TABLE retrieval_traces ADD COLUMN query_rewrite_kind TEXT;`);
    } catch {
      // column may already exist
    }
    try {
      sqliteExec(this.db, `CREATE INDEX IF NOT EXISTS idx_retrieval_traces_query_rewrite_kind ON retrieval_traces(query_rewrite_kind);`);
    } catch {
      // index/table may not exist in partial migrations
    }

    // Migrate existing events table to add new columns if they don't exist
    // Check if columns exist before trying to add them
    const tableInfo = sqliteAll(this.db, "PRAGMA table_info(events)", []);
    const columnNames = tableInfo.map((col: any) => col.name);

    if (!columnNames.includes('access_count')) {
      try {
        sqliteExec(this.db, `
          ALTER TABLE events ADD COLUMN access_count INTEGER DEFAULT 0;
        `);
      } catch (err: any) {
        console.error('Error adding access_count column:', err);
      }
    }

    if (!columnNames.includes('last_accessed_at')) {
      try {
        sqliteExec(this.db, `
          ALTER TABLE events ADD COLUMN last_accessed_at TEXT;
        `);
      } catch (err: any) {
        console.error('Error adding last_accessed_at column:', err);
      }
    }

    // Add turn_id column for grouping events within a conversation turn
    if (!columnNames.includes('turn_id')) {
      try {
        sqliteExec(this.db, `
          ALTER TABLE events ADD COLUMN turn_id TEXT;
        `);
      } catch (err: any) {
        console.error('Error adding turn_id column:', err);
      }
    }

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
    } catch (err: any) {
      // Index may already exist, ignore
    }

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
   * Get recent events
   */
  async getRecentEvents(limit: number = 100, options?: QuarantineReadOptions): Promise<MemoryEvent[]> {
    await this.initialize();

    const rows = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM events WHERE ${maybeQuarantinePredicate(options)} ORDER BY timestamp DESC LIMIT ?`,
      [limit]
    );

    return rows.map(this.rowToEvent);
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

    const pending = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM embedding_outbox
       WHERE status = 'pending'
       ORDER BY created_at
       LIMIT ?`,
      [limit]
    );

    if (pending.length === 0) return [];

    // Update status to processing and stamp the claim time so abandoned workers can be recovered safely.
    const ids = pending.map(r => r.id as string);
    const placeholders = ids.map(() => '?').join(',');
    sqliteRun(
      this.db,
      `UPDATE embedding_outbox
       SET status = 'processing', processed_at = datetime('now'), error_message = NULL
       WHERE id IN (${placeholders})`,
      ids
    );

    return pending.map(row => ({
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
    if (options.projectPath && options.projectHash && hashProjectPath(options.projectPath) !== options.projectHash) {
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
          return { path: candidate, hash: hashProjectPath(candidate) };
        } catch {
          return { path: candidate, hash: undefined };
        }
      });
      const matchingPath = pathHashes.find((candidate) => candidate.hash === projectHash);
      const foreignPath = pathHashes.find((candidate) => candidate.hash && candidate.hash !== projectHash);

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
      } else if (currentHash && currentHash !== projectHash) {
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
  async getOutboxStats(): Promise<{
    embedding: { pending: number; processing: number; failed: number; total: number };
    vector: { pending: number; processing: number; failed: number; total: number };
  }> {
    await this.initialize();

    const embeddingRows = sqliteAll<{ status: string; count: number }>(
      this.db,
      `SELECT status, COUNT(*) as count FROM embedding_outbox GROUP BY status`
    );
    const vectorRows = sqliteAll<{ status: string; count: number }>(
      this.db,
      `SELECT status, COUNT(*) as count FROM vector_outbox GROUP BY status`
    );

    const fromRows = (rows: Array<{ status: string; count: number }>) => {
      const out = { pending: 0, processing: 0, failed: 0, total: 0 };
      for (const row of rows) {
        const key = row.status as 'pending' | 'processing' | 'failed' | 'done';
        if (key === 'pending' || key === 'processing' || key === 'failed') {
          out[key] += row.count;
        }
        out.total += row.count;
      }
      return out;
    };

    return {
      embedding: fromRows(embeddingRows),
      vector: fromRows(vectorRows)
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
  async incrementAccessCount(eventIds: string[]): Promise<void> {
    if (eventIds.length === 0 || this.readOnly) return;

    await this.initialize();

    const placeholders = eventIds.map(() => '?').join(',');
    const currentTime = toSQLiteTimestamp(new Date());

    sqliteRun(
      this.db,
      `UPDATE events
       SET access_count = access_count + 1,
           last_accessed_at = ?
       WHERE id IN (${placeholders})`,
      [currentTime, ...eventIds]
    );
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
  async recordRetrieval(eventId: string, sessionId: string, score: number, query: string): Promise<void> {
    if (this.readOnly) return;
    await this.initialize();

    const id = randomUUID();
    sqliteRun(
      this.db,
      `INSERT INTO memory_helpfulness (id, event_id, session_id, retrieval_score, query_preview, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      [id, eventId, sessionId, score, query.slice(0, 100)]
    );
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

    // Get session events to analyze behavior after retrieval
    const sessionEvents = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC`,
      [sessionId]
    );

    const promptEvents = sessionEvents.filter((e: any) => e.event_type === 'user_prompt');
    const toolEvents = sessionEvents.filter((e: any) => e.event_type === 'tool_observation');

    // Count successful vs failed tools
    let toolSuccessCount = 0;
    let toolTotalCount = toolEvents.length;
    for (const t of toolEvents) {
      try {
        const content = JSON.parse(t.content as string);
        if (content.success !== false) toolSuccessCount++;
      } catch {
        toolSuccessCount++; // Assume success if can't parse
      }
    }
    const toolSuccessRatio = toolTotalCount > 0 ? toolSuccessCount / toolTotalCount : 0.5;

    for (const retrieval of retrievals) {
      const retrievalTime = retrieval.created_at as string;

      // 1. Session continued after retrieval?
      const eventsAfter = sessionEvents.filter((e: any) => e.timestamp > retrievalTime);
      const sessionContinued = eventsAfter.length > 0 ? 1 : 0;

      // 2. How many prompts came after?
      const promptsAfter = promptEvents.filter((e: any) => e.timestamp > retrievalTime);
      const promptCountAfter = promptsAfter.length;

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

      // Calculate helpfulness score
      // Weights tuned for shopping-assistant-like corpora where sessions
      // continue on the same topic (was_reasked was over-penalising normal conversation flow)
      const retrievalScore = retrieval.retrieval_score as number || 0;
      // More prompts after retrieval = memory was actually useful to the conversation
      const promptNorm = Math.min(promptCountAfter / 2, 1.0);
      const helpfulnessScore = (
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
             measured_at = datetime('now')
         WHERE id = ?`,
        [sessionContinued, promptCountAfter, toolSuccessCount, toolTotalCount,
         wasReasked, helpfulnessScore, retrieval.id]
      );
    }
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
  async getHelpfulnessStats(since?: Date): Promise<{
    avgScore: number;
    totalEvaluated: number;
    totalRetrievals: number;
    helpful: number;
    neutral: number;
    unhelpful: number;
  }> {
    await this.initialize();

    const sinceIso = since?.toISOString();
    const evaluatedWhere = sinceIso
      ? `WHERE measured_at IS NOT NULL AND datetime(created_at) >= datetime(?)`
      : `WHERE measured_at IS NOT NULL`;
    const totalWhere = sinceIso
      ? `WHERE datetime(created_at) >= datetime(?)`
      : ``;

    const stats = sqliteGet<Record<string, unknown>>(
      this.db,
      `SELECT
         AVG(helpfulness_score) as avg_score,
         COUNT(*) as total_evaluated,
         SUM(CASE WHEN helpfulness_score >= 0.7 THEN 1 ELSE 0 END) as helpful,
         SUM(CASE WHEN helpfulness_score >= 0.4 AND helpfulness_score < 0.7 THEN 1 ELSE 0 END) as neutral,
         SUM(CASE WHEN helpfulness_score < 0.4 THEN 1 ELSE 0 END) as unhelpful
       FROM memory_helpfulness
       ${evaluatedWhere}`,
      sinceIso ? [sinceIso] : []
    );

    const totalRow = sqliteGet<Record<string, unknown>>(
      this.db,
      `SELECT COUNT(*) as total FROM memory_helpfulness ${totalWhere}`,
      sinceIso ? [sinceIso] : []
    );

    return {
      avgScore: Math.round(((stats?.avg_score as number) || 0) * 100) / 100,
      totalEvaluated: (stats?.total_evaluated as number) || 0,
      totalRetrievals: (totalRow?.total as number) || 0,
      helpful: (stats?.helpful as number) || 0,
      neutral: (stats?.neutral as number) || 0,
      unhelpful: (stats?.unhelpful as number) || 0
    };
  }

  /**
   * Fast keyword search using FTS5
   * Returns events matching the search query, ranked by relevance
   */
  async keywordSearch(query: string, limit: number = 10): Promise<Array<{event: MemoryEvent; rank: number}>> {
    await this.initialize();

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
   * Rebuild FTS index from existing events
   * Call this once after upgrading to FTS5
   */
  async rebuildFtsIndex(): Promise<number> {
    await this.initialize();

    // Get count of events to index
    const countRow = sqliteGet<{count: number}>(this.db, 'SELECT COUNT(*) as count FROM events', []);
    const totalEvents = countRow?.count ?? 0;

    // Clear and rebuild FTS index. Recreate the virtual table instead of
    // issuing DELETE against it: older migrated FTS5 tables/triggers can fail
    // with `no such column: T.event_id` when processing synthetic deletes.
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


  async recordRetrievalTrace(input: {
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
    }>;
    selectedDetails?: Array<{
      eventId: string;
      score: number;
      semanticScore?: number;
      lexicalScore?: number;
      recencyScore?: number;
    }>;
    confidence?: string;
    fallbackTrace?: string[];
  }): Promise<void> {
    await this.initialize();

    const traceId = randomUUID();
    const queryRewriteKind = normalizeQueryRewriteKind(input.queryRewriteKind);
    sqliteRun(
      this.db,
      `INSERT INTO retrieval_traces (
        trace_id, session_id, project_hash, query_text, raw_query_text, query_rewrite_kind, strategy,
        candidate_event_ids, selected_event_ids, candidate_details_json, selected_details_json,
        candidate_count, selected_count, confidence, fallback_trace
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        traceId,
        input.sessionId || null,
        input.projectHash || null,
        input.queryText,
        input.rawQueryText || null,
        queryRewriteKind,
        input.strategy || null,
        JSON.stringify(input.candidateEventIds || []),
        JSON.stringify(input.selectedEventIds || []),
        JSON.stringify(input.candidateDetails || []),
        JSON.stringify(input.selectedDetails || []),
        (input.candidateEventIds || []).length,
        (input.selectedEventIds || []).length,
        input.confidence || null,
        JSON.stringify(input.fallbackTrace || [])
      ]
    );
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
    }>;
    selectedDetails: Array<{
      eventId: string;
      score: number;
      semanticScore?: number;
      lexicalScore?: number;
      recencyScore?: number;
    }>;
    candidateCount: number;
    selectedCount: number;
    confidence?: string;
    fallbackTrace: string[];
    createdAt: Date;
  }>> {
    await this.initialize();

    try {
      const rows = sqliteAll<Record<string, unknown>>(
        this.db,
        `SELECT * FROM retrieval_traces ORDER BY created_at DESC LIMIT ?`,
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
        candidateDetails: row.candidate_details_json ? JSON.parse(row.candidate_details_json as string) : [],
        selectedDetails: row.selected_details_json ? JSON.parse(row.selected_details_json as string) : [],
        candidateCount: Number(row.candidate_count || 0),
        selectedCount: Number(row.selected_count || 0),
        confidence: (row.confidence as string) || undefined,
        fallbackTrace: row.fallback_trace ? JSON.parse(row.fallback_trace as string) : [],
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
  }> {
    await this.initialize();

    try {
      const rewrittenQueryRewriteKindSql = this.hasTableColumn('retrieval_traces', 'query_rewrite_kind')
        ? REWRITTEN_QUERY_REWRITE_KIND_SQL
        : '0';
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
         FROM retrieval_traces`,
        []
      );

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

    // Drop FTS triggers to prevent SQLITE_CORRUPT_VTAB during bulk delete
    const ftsTriggersDropped: string[] = [];
    for (const triggerName of ['events_fts_delete', 'events_fts_update', 'events_fts_insert']) {
      try {
        sqliteRun(this.db, `DROP TRIGGER IF EXISTS ${triggerName}`);
        ftsTriggersDropped.push(triggerName);
      } catch {
        // Trigger may not exist
      }
    }

    // Delete from related tables first (some may not exist depending on DB version)
    for (const table of ['event_dedup', 'memory_levels', 'embedding_queue', 'embedding_outbox', 'vector_outbox']) {
      try {
        sqliteRun(this.db, `DELETE FROM ${table} WHERE event_id IN (${placeholders})`, eventIds);
      } catch {
        // Table may not exist
      }
    }

    // Delete events
    const result = sqliteRun(this.db, `DELETE FROM events WHERE session_id = ?`, [sessionId]);

    // Rebuild FTS index if we dropped triggers
    if (ftsTriggersDropped.length > 0) {
      try {
        // Rebuild FTS from remaining events
        sqliteRun(this.db, `INSERT INTO events_fts(events_fts) VALUES('rebuild')`);

        // Recreate triggers
        sqliteRun(this.db, `CREATE TRIGGER IF NOT EXISTS events_fts_insert AFTER INSERT ON events BEGIN
          INSERT INTO events_fts(rowid, content, event_id) VALUES (NEW.rowid, NEW.content, NEW.id);
        END`);
        sqliteRun(this.db, `CREATE TRIGGER IF NOT EXISTS events_fts_delete AFTER DELETE ON events BEGIN
          DELETE FROM events_fts WHERE rowid = OLD.rowid;
        END`);
        sqliteRun(this.db, `CREATE TRIGGER IF NOT EXISTS events_fts_update AFTER UPDATE ON events BEGIN
          DELETE FROM events_fts WHERE rowid = OLD.rowid;
          INSERT INTO events_fts(rowid, content, event_id) VALUES (NEW.rowid, NEW.content, NEW.id);
        END`);
      } catch {
        // FTS rebuild failed - non-critical, will be rebuilt on next initialize
      }
    }

    return result.changes || 0;
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
