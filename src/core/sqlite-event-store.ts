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
  OutboxItem
} from './types.js';
import { makeCanonicalKey, makeDedupeKey } from './canonical-key.js';
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

export interface SQLiteEventStoreOptions extends SQLiteOptions {
  // Additional options can be added here
}

export class SQLiteEventStore {
  private db: SQLiteDatabase;
  private initialized = false;
  private readonly readOnly: boolean;

  constructor(private dbPath: string, options?: SQLiteEventStoreOptions) {
    this.readOnly = options?.readonly ?? false;
    this.db = createSQLiteDatabase(dbPath, {
      readonly: this.readOnly,
      walMode: !this.readOnly
    });
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

      -- Endless Mode Config table
      CREATE TABLE IF NOT EXISTS endless_config (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Sync position tracking (for SQLite -> DuckDB sync)
      CREATE TABLE IF NOT EXISTS sync_positions (
        target_name TEXT PRIMARY KEY,
        last_event_id TEXT,
        last_timestamp TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
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
      CREATE INDEX IF NOT EXISTS idx_embedding_outbox_status ON embedding_outbox(status);
    `);

    // Migrate existing events table to add access tracking columns if they don't exist
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
      // Use transaction for atomicity
      const insertEvent = this.db.prepare(`
        INSERT INTO events (id, event_type, session_id, timestamp, content, canonical_key, dedupe_key, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
          JSON.stringify(input.metadata || {})
        );
        insertDedup.run(dedupeKey, id);
        insertLevel.run(id);
      });

      transaction();

      return { success: true, eventId: id, isDuplicate: false };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Get events by session ID
   */
  async getSessionEvents(sessionId: string): Promise<MemoryEvent[]> {
    await this.initialize();

    const rows = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC`,
      [sessionId]
    );

    return rows.map(this.rowToEvent);
  }

  /**
   * Get recent events
   */
  async getRecentEvents(limit: number = 100): Promise<MemoryEvent[]> {
    await this.initialize();

    const rows = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM events ORDER BY timestamp DESC LIMIT ?`,
      [limit]
    );

    return rows.map(this.rowToEvent);
  }

  /**
   * Get event by ID
   */
  async getEvent(id: string): Promise<MemoryEvent | null> {
    await this.initialize();

    const row = sqliteGet<Record<string, unknown>>(
      this.db,
      `SELECT * FROM events WHERE id = ?`,
      [id]
    );

    if (!row) return null;
    return this.rowToEvent(row);
  }

  /**
   * Get events since a timestamp (for sync)
   */
  async getEventsSince(timestamp: string, limit: number = 1000): Promise<MemoryEvent[]> {
    await this.initialize();

    const rows = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM events WHERE timestamp > ? ORDER BY timestamp ASC LIMIT ?`,
      [timestamp, limit]
    );

    return rows.map(this.rowToEvent);
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

    // Update status to processing
    const ids = pending.map(r => r.id as string);
    const placeholders = ids.map(() => '?').join(',');
    sqliteRun(
      this.db,
      `UPDATE embedding_outbox SET status = 'processing' WHERE id IN (${placeholders})`,
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
      `SELECT level, COUNT(*) as count FROM memory_levels GROUP BY level`
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
   * Get most accessed memories
   */
  async getMostAccessed(limit: number = 10): Promise<MemoryEvent[]> {
    await this.initialize();

    const rows = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM events
       WHERE access_count > 0
       ORDER BY access_count DESC, last_accessed_at DESC
       LIMIT ?`,
      [limit]
    );

    return rows.map(row => this.rowToEvent(row));
  }

  /**
   * Get database instance for direct access
   */
  getDatabase(): SQLiteDatabase {
    return this.db;
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    sqliteClose(this.db);
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
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined
    };

    // Include access tracking fields if present
    if (row.access_count !== undefined) {
      event.access_count = row.access_count;
    }
    if (row.last_accessed_at !== undefined) {
      event.last_accessed_at = row.last_accessed_at;
    }

    return event;
  }
}
