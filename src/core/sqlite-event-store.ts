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
import { MarkdownMirror } from './markdown-mirror.js';

export interface SQLiteEventStoreOptions extends SQLiteOptions {
  markdownMirrorRoot?: string;
}

export class SQLiteEventStore {
  private db: SQLiteDatabase;
  private initialized = false;
  private readonly readOnly: boolean;
  private readonly markdownMirror: MarkdownMirror | null;

  constructor(private dbPath: string, options?: SQLiteEventStoreOptions) {
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
      CREATE INDEX IF NOT EXISTS idx_consolidated_rules_confidence ON consolidated_rules(confidence);
      CREATE INDEX IF NOT EXISTS idx_embedding_outbox_status ON embedding_outbox(status);
      CREATE INDEX IF NOT EXISTS idx_helpfulness_event ON memory_helpfulness(event_id);
      CREATE INDEX IF NOT EXISTS idx_helpfulness_session ON memory_helpfulness(session_id);
      CREATE INDEX IF NOT EXISTS idx_helpfulness_score ON memory_helpfulness(helpfulness_score DESC);

      -- FTS5 Full-Text Search for fast keyword search
      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        content,
        event_id UNINDEXED,
        content='events',
        content_rowid='rowid'
      );

      -- Triggers to keep FTS in sync with events table
      CREATE TRIGGER IF NOT EXISTS events_fts_insert AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(rowid, content, event_id) VALUES (NEW.rowid, NEW.content, NEW.id);
      END;

      CREATE TRIGGER IF NOT EXISTS events_fts_delete AFTER DELETE ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, content, event_id) VALUES('delete', OLD.rowid, OLD.content, OLD.id);
      END;

      CREATE TRIGGER IF NOT EXISTS events_fts_update AFTER UPDATE ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, content, event_id) VALUES('delete', OLD.rowid, OLD.content, OLD.id);
        INSERT INTO events_fts(rowid, content, event_id) VALUES (NEW.rowid, NEW.content, NEW.id);
      END;
    `);

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
   * Get events since a SQLite rowid (for robust incremental replication).
   * Rowid is monotonic for append-only tables, independent of client timestamps.
   */
  async getEventsSinceRowid(
    lastRowid: number,
    limit: number = 1000
  ): Promise<Array<{ rowid: number; event: MemoryEvent }>> {
    await this.initialize();

    const rows = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT rowid as _rowid, * FROM events WHERE rowid > ? ORDER BY rowid ASC LIMIT ?`,
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
   * Get most accessed memories (falls back to recent events if none accessed)
   */
  async getMostAccessed(limit: number = 10): Promise<MemoryEvent[]> {
    await this.initialize();

    // First try events with access_count > 0
    let rows = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM events
       WHERE access_count > 0
       ORDER BY access_count DESC, last_accessed_at DESC
       LIMIT ?`,
      [limit]
    );

    // Fallback: if no accessed events, show recent events
    if (rows.length === 0) {
      rows = sqliteAll<Record<string, unknown>>(
        this.db,
        `SELECT * FROM events
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
      const retrievalScore = retrieval.retrieval_score as number || 0;
      const helpfulnessScore = (
        0.30 * Math.min(retrievalScore, 1.0) +
        0.25 * (sessionContinued ? 1.0 : 0.0) +
        0.25 * toolSuccessRatio +
        0.20 * (wasReasked ? 0.0 : 1.0)
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
  async getHelpfulnessStats(): Promise<{
    avgScore: number;
    totalEvaluated: number;
    totalRetrievals: number;
    helpful: number;
    neutral: number;
    unhelpful: number;
  }> {
    await this.initialize();

    const stats = sqliteGet<Record<string, unknown>>(
      this.db,
      `SELECT
         AVG(helpfulness_score) as avg_score,
         COUNT(*) as total_evaluated,
         SUM(CASE WHEN helpfulness_score >= 0.7 THEN 1 ELSE 0 END) as helpful,
         SUM(CASE WHEN helpfulness_score >= 0.4 AND helpfulness_score < 0.7 THEN 1 ELSE 0 END) as neutral,
         SUM(CASE WHEN helpfulness_score < 0.4 THEN 1 ELSE 0 END) as unhelpful
       FROM memory_helpfulness
       WHERE measured_at IS NOT NULL`
    );

    const totalRow = sqliteGet<Record<string, unknown>>(
      this.db,
      `SELECT COUNT(*) as total FROM memory_helpfulness`
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

    // Clear and rebuild FTS index
    sqliteExec(this.db, `
      DELETE FROM events_fts;
      INSERT INTO events_fts(rowid, content, event_id)
      SELECT rowid, content, id FROM events;
    `);

    return totalEvents;
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
   * Get events grouped by turn_id for a session
   * Returns turns ordered by first event timestamp (newest first)
   */
  async getSessionTurns(sessionId: string, options?: { limit?: number; offset?: number }): Promise<Array<{
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
      const events = await this.getEventsByTurn(turnRow.turn_id);

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
  async getEventsByTurn(turnId: string): Promise<MemoryEvent[]> {
    await this.initialize();

    const rows = sqliteAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM events WHERE turn_id = ? ORDER BY timestamp ASC`,
      [turnId]
    );

    return rows.map(this.rowToEvent);
  }

  /**
   * Count total turns for a session
   */
  async countSessionTurns(sessionId: string): Promise<number> {
    await this.initialize();

    const row = sqliteGet<{ count: number }>(
      this.db,
      `SELECT COUNT(DISTINCT turn_id) as count
       FROM events
       WHERE session_id = ? AND turn_id IS NOT NULL`,
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
          INSERT INTO events_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
        END`);
        sqliteRun(this.db, `CREATE TRIGGER IF NOT EXISTS events_fts_delete AFTER DELETE ON events BEGIN
          INSERT INTO events_fts(events_fts, rowid, content) VALUES('delete', OLD.rowid, OLD.content);
        END`);
        sqliteRun(this.db, `CREATE TRIGGER IF NOT EXISTS events_fts_update AFTER UPDATE ON events BEGIN
          INSERT INTO events_fts(events_fts, rowid, content) VALUES('delete', OLD.rowid, OLD.content);
          INSERT INTO events_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
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
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined
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
