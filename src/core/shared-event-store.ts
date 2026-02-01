/**
 * SharedEventStore - Global database for cross-project knowledge
 * Location: ~/.claude-code/memory/shared/
 */

import {
  createDatabase,
  dbRun,
  dbClose,
  type Database
} from './db-wrapper.js';

export class SharedEventStore {
  private db: Database;
  private initialized = false;

  constructor(private dbPath: string) {
    this.db = createDatabase(dbPath);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Shared troubleshooting entries table
    await dbRun(this.db, `
      CREATE TABLE IF NOT EXISTS shared_troubleshooting (
        entry_id VARCHAR PRIMARY KEY,
        source_project_hash VARCHAR NOT NULL,
        source_entry_id VARCHAR NOT NULL,
        title VARCHAR NOT NULL,
        symptoms JSON NOT NULL,
        root_cause TEXT NOT NULL,
        solution TEXT NOT NULL,
        topics JSON NOT NULL,
        technologies JSON,
        confidence REAL NOT NULL DEFAULT 0.8,
        usage_count INTEGER DEFAULT 0,
        last_used_at TIMESTAMP,
        promoted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(source_project_hash, source_entry_id)
      )
    `);

    // Future extensibility: best practices table
    await dbRun(this.db, `
      CREATE TABLE IF NOT EXISTS shared_best_practices (
        entry_id VARCHAR PRIMARY KEY,
        source_project_hash VARCHAR NOT NULL,
        source_entry_id VARCHAR NOT NULL,
        title VARCHAR NOT NULL,
        content_json JSON NOT NULL,
        topics JSON NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.8,
        usage_count INTEGER DEFAULT 0,
        promoted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(source_project_hash, source_entry_id)
      )
    `);

    // Future extensibility: common errors table
    await dbRun(this.db, `
      CREATE TABLE IF NOT EXISTS shared_common_errors (
        entry_id VARCHAR PRIMARY KEY,
        source_project_hash VARCHAR NOT NULL,
        source_entry_id VARCHAR NOT NULL,
        title VARCHAR NOT NULL,
        error_pattern TEXT NOT NULL,
        solution TEXT NOT NULL,
        topics JSON NOT NULL,
        technologies JSON,
        confidence REAL NOT NULL DEFAULT 0.8,
        usage_count INTEGER DEFAULT 0,
        promoted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(source_project_hash, source_entry_id)
      )
    `);

    // Indexes for troubleshooting
    await dbRun(this.db, `
      CREATE INDEX IF NOT EXISTS idx_shared_ts_confidence
      ON shared_troubleshooting(confidence DESC)
    `);
    await dbRun(this.db, `
      CREATE INDEX IF NOT EXISTS idx_shared_ts_usage
      ON shared_troubleshooting(usage_count DESC)
    `);
    await dbRun(this.db, `
      CREATE INDEX IF NOT EXISTS idx_shared_ts_source
      ON shared_troubleshooting(source_project_hash)
    `);

    this.initialized = true;
  }

  getDatabase(): Database {
    return this.db;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async close(): Promise<void> {
    await dbClose(this.db);
    this.initialized = false;
  }
}

export function createSharedEventStore(dbPath: string): SharedEventStore {
  return new SharedEventStore(dbPath);
}
