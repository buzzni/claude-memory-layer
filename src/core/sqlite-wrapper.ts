/**
 * SQLite Wrapper with WAL Mode Support
 * Primary store for hooks - always available, no lock conflicts
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as nodePath from 'path';
import { createSQLiteReadSnapshot } from './sqlite-read-snapshot.js';

export type SQLiteDatabase = Database.Database;

export interface SQLiteOptions {
  readonly?: boolean;
  walMode?: boolean;
  /**
   * Open an ephemeral copy instead of the live file. Only for diagnostics
   * that must guarantee zero writes inside the canonical memory root — the
   * copy costs O(database size) per open and the view is frozen at open time.
   * Long-lived readers (semantic daemon), per-hook readers, and machine-wide
   * scanners (maintenance) must NOT set this: a frozen view serves stale
   * memories and the copies dominate their runtime.
   */
  snapshot?: boolean;
  /** Internal-only snapshot parent; see createSQLiteReadSnapshot. */
  snapshotDirectory?: string;
  /** Used to reject unsafe snapshot placement inside canonical storage. */
  canonicalMemoryRoot?: string;
}

/**
 * Creates a new SQLite database with WAL mode
 */
export function createSQLiteDatabase(path: string, options?: SQLiteOptions): SQLiteDatabase {
  // Writable callers may create a new store. Read-only callers must never turn
  // a missing diagnostic target into an empty directory tree.
  const dir = nodePath.dirname(path);
  if (!options?.readonly && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const snapshot = options?.readonly && options?.snapshot
    ? createSQLiteReadSnapshot(path, {
      snapshotDirectory: options.snapshotDirectory,
      canonicalMemoryRoot: options.canonicalMemoryRoot
    })
    : null;
  let db: SQLiteDatabase;
  try {
    db = new Database(snapshot?.databasePath ?? path, {
      readonly: options?.readonly ?? false,
      fileMustExist: options?.readonly ?? false,
    });
  } catch (error) {
    snapshot?.cleanup();
    throw error;
  }
  if (snapshot) {
    const closeSnapshotDatabase = db.close.bind(db);
    Object.defineProperty(db, 'close', {
      configurable: true,
      value: () => {
        try {
          return closeSnapshotDatabase();
        } finally {
          snapshot.cleanup();
        }
      }
    });
  }

  // Enable WAL mode for concurrent access (unless read-only)
  if (!options?.readonly && (options?.walMode ?? true)) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
  }

  return db;
}

// Per-connection prepared-statement cache. Re-running db.prepare() for every
// call recompiles the SQL each time, which dominates the per-call cost on hot
// paths (getEvent, keywordSearch, access tracking). Statements are scoped to
// their database via a WeakMap so they are finalized/GC'd with the connection,
// and SQLite transparently re-prepares them across schema changes.
const statementCache = new WeakMap<SQLiteDatabase, Map<string, Database.Statement>>();

function prepareCached(db: SQLiteDatabase, sql: string): Database.Statement {
  let cache = statementCache.get(db);
  if (!cache) {
    cache = new Map();
    statementCache.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

/**
 * Execute a statement that doesn't return rows (INSERT, UPDATE, DELETE)
 */
export function sqliteRun(
  db: SQLiteDatabase,
  sql: string,
  params: unknown[] = []
): Database.RunResult {
  return prepareCached(db, sql).run(...params);
}

/**
 * Execute a query and return all rows
 */
export function sqliteAll<T = Record<string, unknown>>(
  db: SQLiteDatabase,
  sql: string,
  params: unknown[] = []
): T[] {
  return prepareCached(db, sql).all(...params) as T[];
}

/**
 * Execute a query and return first row
 */
export function sqliteGet<T = Record<string, unknown>>(
  db: SQLiteDatabase,
  sql: string,
  params: unknown[] = []
): T | undefined {
  return prepareCached(db, sql).get(...params) as T | undefined;
}

/**
 * Execute multiple statements (for schema creation)
 */
export function sqliteExec(db: SQLiteDatabase, sql: string): void {
  db.exec(sql);
}

/**
 * Close database connection
 */
export function sqliteClose(db: SQLiteDatabase): void {
  db.close();
}

/**
 * Run multiple statements in a transaction
 */
export function sqliteTransaction<T>(
  db: SQLiteDatabase,
  fn: () => T
): T {
  return db.transaction(fn)();
}

/**
 * Safely converts a value to a Date object
 */
export function toDateFromSQLite(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') {
    // SQLite datetime('now') stores UTC timestamps without an explicit timezone
    // (for example, "2026-05-07 16:00:00"). JavaScript treats that shape as
    // local time, which shifts dashboard time-window calculations on non-UTC
    // machines. Normalize SQLite's timezone-less UTC shape before parsing while
    // leaving ISO strings with an explicit offset/Z untouched.
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed)) {
      return new Date(trimmed.replace(' ', 'T') + 'Z');
    }
    return new Date(trimmed);
  }
  return new Date(String(value));
}

/**
 * Convert Date to ISO string for SQLite storage
 */
export function toSQLiteTimestamp(date: Date): string {
  return date.toISOString();
}
