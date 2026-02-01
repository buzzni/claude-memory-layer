/**
 * DuckDB Promise Wrapper
 * Wraps the callback-based DuckDB API with Promise-based async/await interface
 */

import duckdb from 'duckdb';

export type Database = duckdb.Database;

/**
 * Converts BigInt values to Number in an object
 * DuckDB returns BigInt for COUNT(*) and other aggregate functions
 */
function convertBigInts<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'bigint') return Number(obj) as unknown as T;
  if (obj instanceof Date) return obj; // Preserve Date objects
  if (Array.isArray(obj)) return obj.map(convertBigInts) as unknown as T;
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = convertBigInts(value);
    }
    return result as T;
  }
  return obj;
}

/**
 * Safely converts a value to a Date object
 * Handles both Date objects and string timestamps from DuckDB
 */
export function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string') return new Date(value);
  if (typeof value === 'number') return new Date(value);
  return new Date(String(value));
}

/**
 * Creates a new DuckDB database with Promise-based API
 */
export function createDatabase(path: string): Database {
  return new duckdb.Database(path);
}

/**
 * Promisified db.run() - executes a statement that doesn't return rows
 */
export function dbRun(db: Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    if (params.length === 0) {
      db.run(sql, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    } else {
      db.run(sql, ...params, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    }
  });
}

/**
 * Promisified db.all() - executes a query and returns all rows
 * Automatically converts BigInt values to Number
 */
export function dbAll<T = Record<string, unknown>>(
  db: Database,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    if (params.length === 0) {
      db.all(sql, (err: Error | null, rows: T[]) => {
        if (err) reject(err);
        else resolve(convertBigInts(rows || []));
      });
    } else {
      db.all(sql, ...params, (err: Error | null, rows: T[]) => {
        if (err) reject(err);
        else resolve(convertBigInts(rows || []));
      });
    }
  });
}

/**
 * Promisified db.close() - closes the database connection
 */
export function dbClose(db: Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Promisified db.exec() - executes multiple statements
 */
export function dbExec(db: Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
