/**
 * AXIOMMIND EventStore implementation
 * Principles: Append-only, Single Source of Truth, Idempotency
 */

import { Database } from 'duckdb';
import { randomUUID } from 'crypto';
import {
  MemoryEvent,
  MemoryEventInput,
  Session,
  AppendResult,
  OutboxItem
} from './types.js';
import { makeCanonicalKey, makeDedupeKey } from './canonical-key.js';

export class EventStore {
  private db: Database;
  private initialized = false;

  constructor(private dbPath: string) {
    this.db = new Database(dbPath);
  }

  /**
   * Initialize database schema
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // L0 EventStore: Single Source of Truth (immutable, append-only)
    await this.db.run(`
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
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS event_dedup (
        dedupe_key VARCHAR PRIMARY KEY,
        event_id VARCHAR NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Session metadata
    await this.db.run(`
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
    await this.db.run(`
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
    await this.db.run(`
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
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS projection_offsets (
        projection_name VARCHAR PRIMARY KEY,
        last_event_id VARCHAR,
        last_timestamp TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Memory level tracking
    await this.db.run(`
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
    await this.db.run(`
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
    await this.db.run(`
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
    await this.db.run(`
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
    await this.db.run(`
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

    await this.db.run(`
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

    await this.db.run(`
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

    await this.db.run(`
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
    await this.db.run(`
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
    await this.db.run(`
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
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS continuity_log (
        log_id VARCHAR PRIMARY KEY,
        from_context_id VARCHAR,
        to_context_id VARCHAR,
        continuity_score FLOAT,
        transition_type VARCHAR,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Endless Mode Config table
    await this.db.run(`
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
    await this.db.run(`CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(entry_type)`);
    await this.db.run(`CREATE INDEX IF NOT EXISTS idx_entries_stage ON entries(stage)`);
    await this.db.run(`CREATE INDEX IF NOT EXISTS idx_entries_canonical ON entries(canonical_key)`);

    // Entity indexes
    await this.db.run(`CREATE INDEX IF NOT EXISTS idx_entities_type_key ON entities(entity_type, canonical_key)`);
    await this.db.run(`CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(status)`);

    // Edge indexes
    await this.db.run(`CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_id, rel_type)`);
    await this.db.run(`CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_id, rel_type)`);
    await this.db.run(`CREATE INDEX IF NOT EXISTS idx_edges_rel ON edges(rel_type)`);

    // Outbox indexes
    await this.db.run(`CREATE INDEX IF NOT EXISTS idx_outbox_status ON vector_outbox(status)`);

    // Endless Mode indexes
    await this.db.run(`CREATE INDEX IF NOT EXISTS idx_working_set_expires ON working_set(expires_at)`);
    await this.db.run(`CREATE INDEX IF NOT EXISTS idx_working_set_relevance ON working_set(relevance_score DESC)`);
    await this.db.run(`CREATE INDEX IF NOT EXISTS idx_consolidated_confidence ON consolidated_memories(confidence DESC)`);
    await this.db.run(`CREATE INDEX IF NOT EXISTS idx_continuity_created ON continuity_log(created_at)`);

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
    const existing = await this.db.all<{ event_id: string }[]>(
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
      await this.db.run(
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

      await this.db.run(
        `INSERT INTO event_dedup (dedupe_key, event_id) VALUES (?, ?)`,
        [dedupeKey, id]
      );

      // Initialize at L0
      await this.db.run(
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

    const rows = await this.db.all<Array<Record<string, unknown>>>(
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

    const rows = await this.db.all<Array<Record<string, unknown>>>(
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

    const rows = await this.db.all<Array<Record<string, unknown>>>(
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

    const existing = await this.db.all<Array<{ id: string }>>(
      `SELECT id FROM sessions WHERE id = ?`,
      [session.id]
    );

    if (existing.length === 0) {
      await this.db.run(
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
        await this.db.run(
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

    const rows = await this.db.all<Array<Record<string, unknown>>>(
      `SELECT * FROM sessions WHERE id = ?`,
      [id]
    );

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      id: row.id as string,
      startedAt: new Date(row.started_at as string),
      endedAt: row.ended_at ? new Date(row.ended_at as string) : undefined,
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
    await this.db.run(
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

    // Atomic update to claim items
    const rows = await this.db.all<Array<Record<string, unknown>>>(
      `UPDATE embedding_outbox
       SET status = 'processing'
       WHERE id IN (
         SELECT id FROM embedding_outbox
         WHERE status = 'pending'
         ORDER BY created_at
         LIMIT ?
       )
       RETURNING *`,
      [limit]
    );

    return rows.map(row => ({
      id: row.id as string,
      eventId: row.event_id as string,
      content: row.content as string,
      status: row.status as 'pending' | 'processing' | 'done' | 'failed',
      retryCount: row.retry_count as number,
      createdAt: new Date(row.created_at as string),
      errorMessage: row.error_message as string | undefined
    }));
  }

  /**
   * Mark outbox items as done
   */
  async completeOutboxItems(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const placeholders = ids.map(() => '?').join(',');
    await this.db.run(
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
    await this.db.run(
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

    await this.db.run(
      `UPDATE memory_levels SET level = ?, promoted_at = CURRENT_TIMESTAMP WHERE event_id = ?`,
      [level, eventId]
    );
  }

  /**
   * Get memory level statistics
   */
  async getLevelStats(): Promise<Array<{ level: string; count: number }>> {
    await this.initialize();

    const rows = await this.db.all<Array<{ level: string; count: number }>>(
      `SELECT level, COUNT(*) as count FROM memory_levels GROUP BY level`
    );

    return rows;
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

    const rows = await this.db.all<Array<{ value: string }>>(
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

    await this.db.run(
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

    const rows = await this.db.all<Array<Record<string, unknown>>>(
      `SELECT * FROM sessions ORDER BY started_at DESC`
    );

    return rows.map(row => ({
      id: row.id as string,
      startedAt: new Date(row.started_at as string),
      endedAt: row.ended_at ? new Date(row.ended_at as string) : undefined,
      projectPath: row.project_path as string | undefined,
      summary: row.summary as string | undefined,
      tags: row.tags ? JSON.parse(row.tags as string) : undefined
    }));
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    await this.db.close();
  }

  /**
   * Convert database row to MemoryEvent
   */
  private rowToEvent(row: Record<string, unknown>): MemoryEvent {
    return {
      id: row.id as string,
      eventType: row.event_type as 'user_prompt' | 'agent_response' | 'session_summary',
      sessionId: row.session_id as string,
      timestamp: new Date(row.timestamp as string),
      content: row.content as string,
      canonicalKey: row.canonical_key as string,
      dedupeKey: row.dedupe_key as string,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined
    };
  }
}
