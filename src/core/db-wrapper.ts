/**
 * SQLite Database Wrapper
 * Provides Promise-based interface over better-sqlite3 synchronous API
 */

import BetterSqlite3 from 'better-sqlite3';

export type Database = BetterSqlite3.Database;

/**
 * Safely converts a value to a Date object
 */
export function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string') return new Date(value);
  if (typeof value === 'number') return new Date(value);
  return new Date(String(value));
}

export interface DatabaseOptions {
  readOnly?: boolean;
}

/**
 * Creates a new SQLite database connection.
 *
 * Applies the same connection pragmas as the primary sqlite-wrapper so handles
 * opened here don't fall back to rollback-journal mode with a 0ms busy timeout —
 * which would throw SQLITE_BUSY the instant another process (vector worker,
 * mongo sync, or a second handle to the same file) holds a write lock.
 */
export function createDatabase(dbPath: string, options?: DatabaseOptions): Database {
  const db = new BetterSqlite3(dbPath, { readonly: options?.readOnly });
  db.pragma('busy_timeout = 5000');
  if (!options?.readOnly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  return db;
}

/**
 * Executes a statement that doesn't return rows
 */
export function dbRun(db: Database, sql: string, params: unknown[] = []): Promise<void> {
  db.prepare(sql).run(...(params as never[]));
  return Promise.resolve();
}

/**
 * Executes a query and returns all rows
 */
export function dbAll<T = Record<string, unknown>>(
  db: Database,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  return Promise.resolve(db.prepare(sql).all(...(params as never[])) as T[]);
}

/**
 * Closes the database connection
 */
export function dbClose(db: Database): Promise<void> {
  db.close();
  return Promise.resolve();
}

/**
 * Executes multiple statements
 */
export function dbExec(db: Database, sql: string): Promise<void> {
  db.exec(sql);
  return Promise.resolve();
}
