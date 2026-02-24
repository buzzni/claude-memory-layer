/**
 * AXIOMMIND EventStore implementation
 * Principles: Append-only, Single Source of Truth, Idempotency
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
import { createDatabase, dbRun, dbAll, dbClose, toDate, type Database, type DatabaseOptions } from './db-wrapper.js';

export interface EventStoreOptions extends DatabaseOptions {
  // Additional options can be added here
}

export class EventStore {
  private db: Database;
  private initialized = false;
  private readonly readOnly: boolean;

  constructor(private dbPath: string, options?: EventStoreOptions) {
    this.readOnly = options?.readOnly ?? false;
    this.db = createDatabase(dbPath, { readOnly: this.readOnly });
  }

  /**
   * Initialize database schema
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // In read-only mode, skip schema creation (tables already exist)
    if (this.readOnly) {
      this.initialized = true;
      return;
    }

    // L0 EventStore: Single Source of Truth (immutable, append-only)
    await dbRun(this.db, `
      CREATE TABLE IF NOT EXISTS events (
        id VARCHAR PRIMARY KEY,
        event_type VARCHAR NOT NULL,
        session_id VARCHAR NOT NULL,
        timestamp TIMESTAMP NOT NULL,
        content TEXT NOT NULL,
        canonical_key VARCHAR NOT NULL,
        dedupe_key VARCHAR UNIQUE,
        metadata JSON
      )
    `);

    // Dedup table for idempotency
    await dbRun(this.db, `
      CREATE TABLE IF NOT EXISTS event_dedup (
        dedupe_key VARCHAR PRIMARY KEY,
        event_id VARCHAR NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Session metadata
    await dbRun(this.db, `
      CREATE TABLE IF NOT EXISTS sessions (
        id VARCHAR PRIMARY KEY,
        started_at TIMESTAMP NOT NULL,
        ended_at TIMESTAMP,
        project_path VARCHAR,
        summary TEXT,
        tags JSON
      )
    `);

    // Insights (derived data, rebuildable)
    await dbRun(this.db, `
      CREATE TABLE IF NOT EXISTS insights (
        id VARCHAR PRIMARY KEY,
        insight_type VARCHAR NOT NULL,
        content TEXT NOT NULL,
        canonical_key VARCHAR NOT NULL,
        confidence FLOAT,
        source_events JSON,
        created_at TIMESTAMP,
        last_updated TIMESTAMP
      )
    `);

    // Embedding Outbox (Single-Writer Pattern)
    await dbRun(this.db, `
      CREATE TABLE IF NOT EXISTS embedding_outbox (
        id VARCHAR PRIMARY KEY,
        event_id VARCHAR NOT NULL,
        content TEXT NOT NULL,
        status VARCHAR DEFAULT 'pending',
        retry_count INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMP,
        error_message TEXT
      )
    `);

    // Projection offset tracking
    await dbRun(this.db, `
      CREATE TABLE IF NOT EXISTS projection_offsets (
        projection_name VARCHAR PRIMARY KEY,
        last_event_id VARCHAR,
        last_timestamp TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Memory level tracking
    await dbRun(this.db, `
      CREATE TABLE IF NOT EXISTS memory_levels (
        event_id VARCHAR PRIMARY KEY,
        level VARCHAR NOT NULL DEFAULT 'L0',
        promoted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ============================================================
    // Entity-Edge Model Tables
    // ============================================================

    // Entries (immutable memory units)
    await dbRun(this.db, `
      CREATE TABLE IF NOT EXISTS entries (
        entry_id VARCHAR PRIMARY KEY,
        created_ts TIMESTAMP NOT NULL,
        entry_type VARCHAR NOT NULL,
        title VARCHAR NOT NULL,
        content_json JSON NOT NULL,
        stage VARCHAR NOT NULL DEFAULT 'raw',
        status VARCHAR DEFAULT 'active',
        superseded_by VARCHAR,
        build_id VARCHAR,
        evidence_json JSON,
        canonical_key VARCHAR,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Entities (task/condition/artifact)
    await dbRun(this.db, `
      CREATE TABLE IF NOT EXISTS entities (
        entity_id VARCHAR PRIMARY KEY,
        entity_type VARCHAR NOT NULL,
        canonical_key VARCHAR NOT NULL,
        title VARCHAR NOT NULL,
        stage VARCHAR NOT NULL DEFAULT 'raw',
        status VARCHAR NOT NULL DEFAULT 'active',
        current_json JSON NOT NULL,
        title_norm VARCHAR,
        search_text VARCHAR,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Entity aliases for canonical key lookup
    await dbRun(this.db, `
      CREATE TABLE IF NOT EXISTS entity_aliases (
        entity_type VARCHAR NOT NULL,
        canonical_key VARCHAR NOT NULL,
        entity_id VARCHAR NOT NULL,
        is_primary BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(entity_type, canonical_key)
      )
    `);

    // Edges (relationships between entries/entities)
    await dbRun(this.db, `
      CREATE TABLE IF NOT EXISTS edges (
        edge_id VARCHAR PRIMARY KEY,
        src_type VARCHAR NOT NULL,
        src_id VARCHAR NOT NULL,
        rel_type VARCHAR NOT NULL,
        dst_type VARCHAR NOT NULL,
        dst_id VARCHAR NOT NULL,
        meta_json JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ============================================================
    // Vector Outbox V2 Table
    // ============================================================

    await dbRun(this.db, `
      CREATE TABLE IF NOT EXISTS vector_outbox (
        job_id VARCHAR PRIMARY KEY,
        item_kind VARCHAR NOT NULL,
        item_id VARCHAR NOT NULL,
        embedding_version VARCHAR NOT NULL,
        status VARCHAR NOT NULL DEFAULT 'pending',
        retry_count INT DEFAULT 0,
        error VARCHAR,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(item_kind, item_id, embedding_version)
      )
    `);

    // ============================================================
    // Build Runs & Metrics Tables
    // ============================================================

    await dbRun(this.db, `
      CREATE TABLE IF NOT EXISTS build_runs (
        build_id VARCHAR PRIMARY KEY,
        started_at TIMESTAMP NOT NULL,
        finished_at TIMESTAMP,
        extractor_model VARCHAR NOT NULL,
        extractor_prompt_hash VARCHAR NOT NULL,
        embedder_model VARCHAR NOT NULL,
        embedding_version VARCHAR NOT NULL,
        idris_version VARCHAR NOT NULL,
        schema_version VARCHAR NOT NULL,
        status VARCHAR NOT NULL DEFAULT 'running',
        error VARCHAR
      )
    `);

    await dbRun(this.db, `
      CREATE TABLE IF NOT EXISTS pipeline_metrics (
        id VARCHAR PRIMARY KEY,
        ts TIMESTAMP NOT NULL,
        stage VARCHAR NOT NULL,
        latency_ms DOUBLE NOT NULL,
        success BOOLEAN NOT NULL,
        error VARCHAR,
        session_id VARCHAR
      )
    `);

    // ============================================================
    // Endless Mode Tables
    // ============================================================

    // Working Set table (active memory window)
    await dbRun(this.db, `
      CREATE TABLE IF NOT EXISTS working_set (
        id VARCHAR PRIMARY KEY,
        event_id VARCHAR NOT NULL,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        relevance_score FLOAT DEFAULT 1.0,
        topics JSON,
        expires_at TIMESTAMP
      )
    `);

    // Consolidated Memories table (long-term integrated memories)
    await dbRun(this.db, `
      CREATE TABLE IF NOT EXISTS consolidated_memories (
        memory_id VARCHAR PRIMARY KEY,
        summary TEXT NOT NULL,
        topics JSON,
        source_events JSON,
        confidence FLOAT DEFAULT 0.5,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        accessed_at TIMESTAMP,
        access_count INTEGER DEFAULT 0
      )
    `);

    // Continuity Log table (tracks context transitions)
    await dbRun(this.db, `
      CREATE TABLE IF NOT EXISTS continuity_log (
        log_id VARCHAR PRIMARY KEY,
        from_context_id VARCHAR,
        to_context_id VARCHAR,
        continuity_score FLOAT,
        transition_type VARCHAR,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Consolidated Rules table (long-term stable memory)
    await dbRun(this.db, `
      CREATE TABLE IF NOT EXISTS consolidated_rules (
        rule_id VARCHAR PRIMARY KEY,
        rule TEXT NOT NULL,
        topics JSON,
        source_memory_ids JSON,
        source_events JSON,
        confidence FLOAT DEFAULT 0.5,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Endless Mode Config table
    await dbRun(this.db, `
      CREATE TABLE IF NOT EXISTS endless_config (
        key VARCHAR PRIMARY KEY,
        value JSON,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ============================================================
    // Create Indexes
    // ============================================================

    // Entry indexes
    await dbRun(this.db, `CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(entry_type)`);
    await dbRun(this.db, `CREATE INDEX IF NOT EXISTS idx_entries_stage ON entries(stage)`);
    await dbRun(this.db, `CREATE INDEX IF NOT EXISTS idx_entries_canonical ON entries(canonical_key)`);

    // Entity indexes
    await dbRun(this.db, `CREATE INDEX IF NOT EXISTS idx_entities_type_key ON entities(entity_type, canonical_key)`);
    await dbRun(this.db, `CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(status)`);

    // Edge indexes
    await dbRun(this.db, `CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_id, rel_type)`);
    await dbRun(this.db, `CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_id, rel_type)`);
    await dbRun(this.db, `CREATE INDEX IF NOT EXISTS idx_edges_rel ON edges(rel_type)`);

    // Outbox indexes
    await dbRun(this.db, `CREATE INDEX IF NOT EXISTS idx_outbox_status ON vector_outbox(status)`);

    // Endless Mode indexes
    await dbRun(this.db, `CREATE INDEX IF NOT EXISTS idx_working_set_expires ON working_set(expires_at)`);
    await dbRun(this.db, `CREATE INDEX IF NOT EXISTS idx_working_set_relevance ON working_set(relevance_score DESC)`);
    await dbRun(this.db, `CREATE INDEX IF NOT EXISTS idx_consolidated_confidence ON consolidated_memories(confidence DESC)`);
    await dbRun(this.db, `CREATE INDEX IF NOT EXISTS idx_consolidated_rules_confidence ON consolidated_rules(confidence DESC)`);
    await dbRun(this.db, `CREATE INDEX IF NOT EXISTS idx_continuity_created ON continuity_log(created_at)`);

    this.initialized = true;
  }

  /**
   * Append event to store (AXIOMMIND Principle 2: Append-only)
   * Returns existing event ID if duplicate (Principle 3: Idempotency)
   */
  async append(input: MemoryEventInput): Promise<AppendResult> {
    await this.initialize();

    const canonicalKey = makeCanonicalKey(input.content);
    const dedupeKey = makeDedupeKey(input.content, input.sessionId);

    // Check for duplicate
    const existing = await dbAll<{ event_id: string }>(
      this.db,
      `SELECT event_id FROM event_dedup WHERE dedupe_key = ?`,
      [dedupeKey]
    );

    if (existing.length > 0) {
      return {
        success: true,
        eventId: existing[0].event_id,
        isDuplicate: true
      };
    }

    const id = randomUUID();
    const timestamp = input.timestamp.toISOString();

    try {
      await dbRun(
        this.db,
        `INSERT INTO events (id, event_type, session_id, timestamp, content, canonical_key, dedupe_key, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.eventType,
          input.sessionId,
          timestamp,
          input.content,
          canonicalKey,
          dedupeKey,
          JSON.stringify(input.metadata || {})
        ]
      );

      await dbRun(
        this.db,
        `INSERT INTO event_dedup (dedupe_key, event_id) VALUES (?, ?)`,
        [dedupeKey, id]
      );

      // Initialize at L0
      await dbRun(
        this.db,
        `INSERT INTO memory_levels (event_id, level) VALUES (?, 'L0')`,
        [id]
      );

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

    const rows = await dbAll<Record<string, unknown>>(
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

    const rows = await dbAll<Record<string, unknown>>(
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

    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM events WHERE id = ?`,
      [id]
    );

    if (rows.length === 0) return null;
    return this.rowToEvent(rows[0]);
  }

  /**
   * Create or update session
   */
  async upsertSession(session: Partial<Session> & { id: string }): Promise<void> {
    await this.initialize();

    const existing = await dbAll<{ id: string }>(
      this.db,
      `SELECT id FROM sessions WHERE id = ?`,
      [session.id]
    );

    if (existing.length === 0) {
      await dbRun(
        this.db,
        `INSERT INTO sessions (id, started_at, project_path, tags)
         VALUES (?, ?, ?, ?)`,
        [
          session.id,
          (session.startedAt || new Date()).toISOString(),
          session.projectPath || null,
          JSON.stringify(session.tags || [])
        ]
      );
    } else {
      const updates: string[] = [];
      const values: unknown[] = [];

      if (session.endedAt) {
        updates.push('ended_at = ?');
        values.push(session.endedAt.toISOString());
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
        await dbRun(
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

    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM sessions WHERE id = ?`,
      [id]
    );

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      id: row.id as string,
      startedAt: toDate(row.started_at),
      endedAt: row.ended_at ? toDate(row.ended_at) : undefined,
      projectPath: row.project_path as string | undefined,
      summary: row.summary as string | undefined,
      tags: row.tags ? JSON.parse(row.tags as string) : undefined
    };
  }

  /**
   * Add to embedding outbox (Single-Writer Pattern)
   */
  async enqueueForEmbedding(eventId: string, content: string): Promise<string> {
    await this.initialize();

    const id = randomUUID();
    await dbRun(
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

    // First, get pending items
    const pending = await dbAll<Record<string, unknown>>(
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
    await dbRun(
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
      createdAt: toDate(row.created_at),
      errorMessage: row.error_message as string | undefined
    }));
  }

  /**
   * Mark outbox items as done
   */
  async completeOutboxItems(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const placeholders = ids.map(() => '?').join(',');
    await dbRun(
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
    await dbRun(
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

    await dbRun(
      this.db,
      `UPDATE memory_levels SET level = ?, promoted_at = CURRENT_TIMESTAMP WHERE event_id = ?`,
      [level, eventId]
    );
  }

  /**
   * Get memory level statistics
   */
  async getLevelStats(): Promise<Array<{ level: string; count: number }>> {
    await this.initialize();

    const rows = await dbAll<{ level: string; count: number }>(
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

    const rows = await dbAll<Record<string, unknown>>(
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

    const rows = await dbAll<{ level: string }>(
      this.db,
      `SELECT level FROM memory_levels WHERE event_id = ?`,
      [eventId]
    );

    return rows.length > 0 ? rows[0].level : null;
  }

  // ============================================================
  // Endless Mode Helper Methods
  // ============================================================

  /**
   * Get database instance for Endless Mode stores
   */
  getDatabase(): Database {
    return this.db;
  }

  /**
   * Get config value for endless mode
   */
  async getEndlessConfig(key: string): Promise<unknown | null> {
    await this.initialize();

    const rows = await dbAll<{ value: string }>(
      this.db,
      `SELECT value FROM endless_config WHERE key = ?`,
      [key]
    );

    if (rows.length === 0) return null;
    return JSON.parse(rows[0].value);
  }

  /**
   * Set config value for endless mode
   */
  async setEndlessConfig(key: string, value: unknown): Promise<void> {
    await this.initialize();

    await dbRun(
      this.db,
      `INSERT OR REPLACE INTO endless_config (key, value, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)`,
      [key, JSON.stringify(value)]
    );
  }

  /**
   * Get all sessions
   */
  async getAllSessions(): Promise<Session[]> {
    await this.initialize();

    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM sessions ORDER BY started_at DESC`
    );

    return rows.map(row => ({
      id: row.id as string,
      startedAt: toDate(row.started_at),
      endedAt: row.ended_at ? toDate(row.ended_at) : undefined,
      projectPath: row.project_path as string | undefined,
      summary: row.summary as string | undefined,
      tags: row.tags ? JSON.parse(row.tags as string) : undefined
    }));
  }

  /**
   * Increment access count for events (stub for compatibility)
   */
  async incrementAccessCount(eventIds: string[]): Promise<void> {
    // This is a stub method for compatibility
    // Actual implementation is in SQLiteEventStore
    return Promise.resolve();
  }

  /**
   * Get most accessed memories (stub for compatibility)
   */
  async getMostAccessed(limit: number = 10): Promise<MemoryEvent[]> {
    // This is a stub method for compatibility
    // Actual implementation is in SQLiteEventStore
    return [];
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    await dbClose(this.db);
  }

  /**
   * Convert database row to MemoryEvent
   */
  private rowToEvent(row: Record<string, unknown>): MemoryEvent {
    return {
      id: row.id as string,
      eventType: row.event_type as 'user_prompt' | 'agent_response' | 'session_summary',
      sessionId: row.session_id as string,
      timestamp: toDate(row.timestamp),
      content: row.content as string,
      canonicalKey: row.canonical_key as string,
      dedupeKey: row.dedupe_key as string,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined
    };
  }
}
