/**
 * SQLite Wrapper with WAL Mode Support
 * Primary store for hooks - always available, no lock conflicts
 */

import Database from 'better-sqlite3';

export type SQLiteDatabase = Database.Database;

export interface SQLiteOptions {
  readonly?: boolean;
  walMode?: boolean;
}

/**
 * Creates a new SQLite database with WAL mode
 */
export function createSQLiteDatabase(path: string, options?: SQLiteOptions): SQLiteDatabase {
  const db = new Database(path, {
    readonly: options?.readonly ?? false,
  });

  // Enable WAL mode for concurrent access (unless read-only)
  if (!options?.readonly && (options?.walMode ?? true)) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
  }

  return db;
}

/**
 * Execute a statement that doesn't return rows (INSERT, UPDATE, DELETE)
 */
export function sqliteRun(
  db: SQLiteDatabase,
  sql: string,
  params: unknown[] = []
): Database.RunResult {
  const stmt = db.prepare(sql);
  return stmt.run(...params);
}

/**
 * Execute a query and return all rows
 */
export function sqliteAll<T = Record<string, unknown>>(
  db: SQLiteDatabase,
  sql: string,
  params: unknown[] = []
): T[] {
  const stmt = db.prepare(sql);
  return stmt.all(...params) as T[];
}

/**
 * Execute a query and return first row
 */
export function sqliteGet<T = Record<string, unknown>>(
  db: SQLiteDatabase,
  sql: string,
  params: unknown[] = []
): T | undefined {
  const stmt = db.prepare(sql);
  return stmt.get(...params) as T | undefined;
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
  if (typeof value === 'string') return new Date(value);
  if (typeof value === 'number') return new Date(value);
  return new Date(String(value));
}

/**
 * Convert Date to ISO string for SQLite storage
 */
export function toSQLiteTimestamp(date: Date): string {
  return date.toISOString();
}
