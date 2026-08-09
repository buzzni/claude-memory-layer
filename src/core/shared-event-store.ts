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

  constructor(dbPath: string) {
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

    // A shared principal is intentionally an explicit link between an actor in
    // one project and the same actor in another project.  It is not an
    // authentication provider: callers still have to supply the local actor
    // id, and the adapter uses this table only to narrow shared reads.
    await dbRun(this.db, `
      CREATE TABLE IF NOT EXISTS shared_actor_identities (
        project_hash VARCHAR NOT NULL,
        actor_id VARCHAR NOT NULL,
        shared_principal_id VARCHAR NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(project_hash, actor_id)
      )
    `);

    // Identity links change the set of projects visible to a shared principal.
    // Keep their history beside the mapping so link/relink/unlink can be
    // committed atomically even though each project has a separate database.
    await dbRun(this.db, `
      CREATE TABLE IF NOT EXISTS shared_actor_identity_audit (
        audit_id VARCHAR PRIMARY KEY,
        operation VARCHAR NOT NULL,
        project_hash VARCHAR NOT NULL,
        actor_id VARCHAR NOT NULL,
        before_shared_principal_id VARCHAR,
        after_shared_principal_id VARCHAR,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
    await dbRun(this.db, `
      CREATE INDEX IF NOT EXISTS idx_shared_actor_identities_principal
      ON shared_actor_identities(shared_principal_id, project_hash)
    `);
    await dbRun(this.db, `
      CREATE INDEX IF NOT EXISTS idx_shared_actor_identity_audit_actor
      ON shared_actor_identity_audit(project_hash, actor_id, created_at DESC)
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
