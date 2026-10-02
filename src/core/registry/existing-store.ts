/**
 * Non-creating memory-store resolution shared by diagnostic callers.
 *
 * Input semantics are intentionally narrow and stable:
 * - omitted input selects the global store;
 * - exactly eight lowercase hexadecimal characters select an opaque project hash;
 * - every other non-empty string is a project path (relative paths remain relative
 *   to the caller's cwd, matching hashProjectPath);
 * - empty strings and NUL-containing values are invalid.
 *
 * This module never creates a directory, opens a writable database, migrates a
 * schema, or updates the session registry.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createSQLiteDatabase, sqliteAll, sqliteClose, sqliteGet, type SQLiteDatabase } from '../sqlite-wrapper.js';
import { hashProjectPath } from './project-path.js';

export type ExistingStoreInputKind = 'global' | 'project-hash' | 'project-path';
export type ExistingStoreStatus = 'existing' | 'missing' | 'invalid' | 'unreadable' | 'corrupt';
export type ExistingStoreFailureReason =
  | 'invalid_input'
  | 'invalid_store_shape'
  | 'source_unreadable'
  | 'snapshot_unavailable'
  | 'snapshot_inconsistent'
  | 'integrity_check_failed'
  | 'schema_incompatible'
  | 'readonly_runtime';

export interface ExistingStoreResolution {
  status: ExistingStoreStatus;
  inputKind: ExistingStoreInputKind;
  projectHash?: string;
  /** Internal-only resolved location. Public formatters must not print it. */
  storagePath?: string;
  /** Internal-only SQLite location. Public formatters must not print it. */
  databasePath?: string;
  /** Stable internal diagnostic. Public callers may expose this enum, never the local paths above. */
  reason?: ExistingStoreFailureReason;
}

export interface ExistingStoreResolverOptions {
  homeDir?: string;
  snapshotDirectory?: string;
}

const PROJECT_HASH_PATTERN = /^[a-f0-9]{8}$/;
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'utf8');

export function resolveExistingStore(
  projectOrHash?: string,
  options: ExistingStoreResolverOptions = {}
): ExistingStoreResolution {
  const located = locateExistingStore(projectOrHash, options);
  if (!located.candidate) return located.resolution;
  const { resolution: base, memoryRoot } = located;
  const databasePath = base.databasePath!;

  // The integrity probe reads an unlocked point-in-time copy (snapshot), and a
  // writer checkpointing mid-copy can produce a torn copy that fails
  // quick_check even though the live store is intact. One retry with a fresh
  // copy separates that race from real corruption.
  const walObservedBeforeProbe = safeLstat(`${databasePath}-wal`).kind === 'found';
  let probe = probeDatabase(base, databasePath, memoryRoot, options.snapshotDirectory);
  if (isRetryableSnapshotProbe(probe)) {
    probe = probeDatabase(base, databasePath, memoryRoot, options.snapshotDirectory);
    if (
      isRetryableSnapshotProbe(probe)
      && (walObservedBeforeProbe || safeLstat(`${databasePath}-wal`).kind === 'found')
    ) {
      return { ...base, status: 'unreadable', reason: 'snapshot_inconsistent' };
    }
  }
  return probe;
}

type LocatedExistingStore =
  | { candidate: false; resolution: ExistingStoreResolution }
  | { candidate: true; resolution: ExistingStoreResolution; memoryRoot: string };

/**
 * File-shape checks shared by every non-creating reader: input parsing,
 * missing/symlink/permission/header classification. A `candidate` result has
 * passed these checks but has not been opened yet.
 */
function locateExistingStore(
  projectOrHash: string | undefined,
  options: ExistingStoreResolverOptions
): LocatedExistingStore {
  const homeDir = options.homeDir ?? os.homedir();
  const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
  const parsed = parseStoreInput(projectOrHash);
  if (parsed.status === 'invalid') return { candidate: false, resolution: parsed };

  const storagePath = parsed.inputKind === 'global'
    ? memoryRoot
    : path.join(memoryRoot, 'projects', parsed.projectHash!);
  const databasePath = path.join(storagePath, 'events.sqlite');
  const base = { ...parsed, storagePath, databasePath };
  const done = (resolution: ExistingStoreResolution): LocatedExistingStore => ({ candidate: false, resolution });

  const storageEntry = safeLstat(storagePath);
  if (storageEntry.kind === 'missing') return done({ ...base, status: 'missing' });
  if (storageEntry.kind === 'unreadable') return done({ ...base, status: 'unreadable', reason: 'source_unreadable' });
  if (storageEntry.stat.isSymbolicLink() || !storageEntry.stat.isDirectory()) {
    return done({ ...base, status: 'invalid', reason: 'invalid_store_shape' });
  }
  if (!isRealPathWithin(memoryRoot, storagePath)) {
    return done({ ...base, status: 'invalid', reason: 'invalid_store_shape' });
  }

  const databaseEntry = safeLstat(databasePath);
  if (databaseEntry.kind === 'missing') return done({ ...base, status: 'missing' });
  if (databaseEntry.kind === 'unreadable') return done({ ...base, status: 'unreadable', reason: 'source_unreadable' });
  if (databaseEntry.stat.isSymbolicLink() || !databaseEntry.stat.isFile()) {
    return done({ ...base, status: 'invalid', reason: 'invalid_store_shape' });
  }
  if ((databaseEntry.stat.mode & 0o444) === 0) {
    return done({ ...base, status: 'unreadable', reason: 'source_unreadable' });
  }
  // A zero-length file is a valid, empty SQLite database — the header is
  // written lazily on first write. Treat it like a store that does not exist
  // yet so callers get the graceful empty reader, not a corruption error.
  if (databaseEntry.stat.size === 0) return done({ ...base, status: 'missing' });
  const headerStatus = inspectSQLiteHeader(databasePath);
  if (headerStatus === 'unreadable') return done({ ...base, status: 'unreadable', reason: 'source_unreadable' });
  if (databaseEntry.stat.size < SQLITE_HEADER.length || headerStatus === 'invalid') {
    return done({ ...base, status: 'corrupt', reason: 'integrity_check_failed' });
  }
  return { candidate: true, resolution: { ...base, status: 'existing' }, memoryRoot };
}

/** Typed failure from {@link withExistingStoreReadSnapshot}; carries enums only, never paths. */
export class ExistingStoreReadError extends Error {
  constructor(
    readonly storeStatus: Exclude<ExistingStoreStatus, 'existing'>,
    readonly reason?: ExistingStoreFailureReason
  ) {
    super(`Memory store is ${storeStatus}`);
    this.name = 'ExistingStoreReadError';
  }
}

export interface ExistingStoreReadSnapshotOptions extends ExistingStoreResolverOptions {
  /** Tables (and the columns callers cannot default) that must exist; optional columns are omitted. */
  requiredColumns?: Record<string, readonly string[]>;
}

const READ_SNAPSHOT_ATTEMPTS = 2;

/**
 * Open one read-only snapshot of an existing store and run a read callback on
 * it. Shares the resolver's shape checks but, unlike resolveExistingStore()
 * followed by a second open, copies the database once per attempt: the schema
 * check runs on the same snapshot the callback reads. Instead of a full
 * quick_check (O(database size) on every call), a torn copy is detected by the
 * SQLite corruption/schema errors it produces and retried once with a fresh
 * copy. The callback must therefore be a pure read that is safe to re-run.
 * A missing store is reported, never created. A concurrent checkpoint can
 * still produce a valid but stale snapshot, which is not detected or retried
 * (see createSQLiteReadSnapshot); this is best effort with no freshness SLA.
 */
export async function withExistingStoreReadSnapshot<T>(
  projectOrHash: string | undefined,
  callback: (db: SQLiteDatabase, resolution: ExistingStoreResolution) => Promise<T> | T,
  options: ExistingStoreReadSnapshotOptions = {}
): Promise<T> {
  const located = locateExistingStore(projectOrHash, options);
  if (!located.candidate) {
    const { status, reason } = located.resolution;
    throw new ExistingStoreReadError(status as Exclude<ExistingStoreStatus, 'existing'>, reason);
  }
  const { resolution, memoryRoot } = located;
  const databasePath = resolution.databasePath!;
  const walObservedBeforeRead = safeLstat(`${databasePath}-wal`).kind === 'found';

  let lastFailure: ExistingStoreResolution | undefined;
  for (let attempt = 1; attempt <= READ_SNAPSHOT_ATTEMPTS; attempt++) {
    let db: SQLiteDatabase | undefined;
    try {
      db = createSQLiteDatabase(databasePath, {
        readonly: true,
        snapshot: true,
        snapshotDirectory: options.snapshotDirectory,
        canonicalMemoryRoot: memoryRoot,
        walMode: false
      });
      const schemaFailure = checkRequiredSchema(db, options.requiredColumns);
      if (schemaFailure) {
        lastFailure = { ...resolution, status: 'invalid', reason: 'schema_incompatible' };
        continue;
      }
      return await callback(db, resolution);
    } catch (error) {
      // Unsafe snapshot placement is a deterministic configuration error whose
      // message is already path-free; callers surface it unchanged.
      const code = String((error as NodeJS.ErrnoException | undefined)?.code ?? '');
      if (code === 'SQLITE_SNAPSHOT_UNSAFE_LOCATION' || !isStorageError(error)) throw error;
      lastFailure = classifyProbeFailure(resolution, error);
      if (!isRetryableSnapshotProbe(lastFailure)) break;
    } finally {
      if (db) {
        try {
          sqliteClose(db);
        } catch {
          // The read already completed or failed; a close error must not mask it.
        }
      }
    }
  }
  const failure = lastFailure!;
  if (
    failure.reason !== 'schema_incompatible'
    && isRetryableSnapshotProbe(failure)
    && (walObservedBeforeRead || safeLstat(`${databasePath}-wal`).kind === 'found')
  ) {
    throw new ExistingStoreReadError('unreadable', 'snapshot_inconsistent');
  }
  throw new ExistingStoreReadError(failure.status as Exclude<ExistingStoreStatus, 'existing'>, failure.reason);
}

function checkRequiredSchema(
  db: SQLiteDatabase,
  requiredColumns: Record<string, readonly string[]> = {}
): string | null {
  const tables: Record<string, readonly string[]> = { events: [], ...requiredColumns };
  for (const [table, columns] of Object.entries(tables)) {
    const present = new Set(
      sqliteAll<{ name: string }>(db, `SELECT name FROM pragma_table_info(?)`, [table]).map((row) => row.name)
    );
    if (present.size === 0) return table;
    if (columns.some((column) => !present.has(column))) return table;
  }
  return null;
}

/** SQLite/filesystem failures belong to the store; anything else is a caller error. */
function isStorageError(error: unknown): boolean {
  const code = String((error as NodeJS.ErrnoException | undefined)?.code ?? '').toUpperCase();
  if (code.startsWith('SQLITE_') || code === 'ENOENT' || code === 'ENOSPC' || code === 'EACCES' || code === 'EPERM') {
    return true;
  }
  const message = String((error as Error | undefined)?.message ?? '').toLowerCase();
  return message.includes('database disk image is malformed')
    || message.includes('file is not a database')
    || message.includes('no such table')
    || message.includes('no such column');
}

function isRetryableSnapshotProbe(probe: ExistingStoreResolution): boolean {
  return probe.reason === 'snapshot_inconsistent'
    || probe.reason === 'integrity_check_failed'
    || probe.reason === 'schema_incompatible';
}

function probeDatabase(
  base: Omit<ExistingStoreResolution, 'status'>,
  databasePath: string,
  memoryRoot: string,
  snapshotDirectory?: string
): ExistingStoreResolution {
  let db;
  try {
    db = createSQLiteDatabase(databasePath, {
      readonly: true,
      snapshot: true,
      snapshotDirectory,
      canonicalMemoryRoot: memoryRoot,
      walMode: false
    });
    const integrity = sqliteGet<Record<string, string>>(db, 'PRAGMA quick_check(1)');
    if (Object.values(integrity ?? {})[0] !== 'ok') {
      return { ...base, status: 'corrupt', reason: 'integrity_check_failed' };
    }
    const eventsTable = sqliteGet<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'"
    );
    if (!eventsTable) return { ...base, status: 'invalid', reason: 'schema_incompatible' };
  } catch (error) {
    return classifyProbeFailure(base, error);
  } finally {
    if (db) {
      try {
        sqliteClose(db);
      } catch {
        // Resolution is already complete; close failures must not trigger writes.
      }
    }
  }

  return { ...base, status: 'existing' };
}

function parseStoreInput(projectOrHash?: string): ExistingStoreResolution {
  if (projectOrHash === undefined) return { status: 'missing', inputKind: 'global' };
  const normalized = projectOrHash.trim();
  if (normalized.length === 0 || normalized.includes('\0')) {
    return { status: 'invalid', inputKind: 'project-path', reason: 'invalid_input' };
  }
  if (PROJECT_HASH_PATTERN.test(normalized)) {
    return { status: 'missing', inputKind: 'project-hash', projectHash: normalized };
  }
  return {
    status: 'missing',
    inputKind: 'project-path',
    projectHash: hashProjectPath(normalized)
  };
}

type LstatResult =
  | { kind: 'found'; stat: fs.Stats }
  | { kind: 'missing' }
  | { kind: 'unreadable' };

function safeLstat(targetPath: string): LstatResult {
  try {
    return { kind: 'found', stat: fs.lstatSync(targetPath) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? { kind: 'missing' }
      : { kind: 'unreadable' };
  }
}

function isRealPathWithin(rootPath: string, candidatePath: string): boolean {
  try {
    const root = fs.realpathSync(rootPath);
    const candidate = fs.realpathSync(candidatePath);
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

function inspectSQLiteHeader(databasePath: string): 'valid' | 'invalid' | 'unreadable' {
  let fd: number | undefined;
  try {
    fd = fs.openSync(databasePath, 'r');
    const header = Buffer.alloc(SQLITE_HEADER.length);
    return fs.readSync(fd, header, 0, header.length, 0) === header.length
      && header.equals(SQLITE_HEADER)
      ? 'valid'
      : 'invalid';
  } catch (error) {
    return isPermissionError(error) ? 'unreadable' : 'invalid';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM';
}

function classifyProbeFailure(
  base: Omit<ExistingStoreResolution, 'status'>,
  error: unknown
): ExistingStoreResolution {
  const code = String((error as NodeJS.ErrnoException | undefined)?.code ?? '').toUpperCase();
  const message = String((error as Error | undefined)?.message ?? '').toLowerCase();
  if (isPermissionError(error)) {
    return { ...base, status: 'unreadable', reason: 'source_unreadable' };
  }
  if (code.startsWith('SQLITE_SNAPSHOT_') || code === 'ENOENT' || code === 'ENOSPC') {
    return { ...base, status: 'unreadable', reason: 'snapshot_unavailable' };
  }
  if (code === 'SQLITE_READONLY' || message.includes('readonly database') || message.includes('read-only database')) {
    return { ...base, status: 'unreadable', reason: 'readonly_runtime' };
  }
  if (message.includes('database disk image is malformed') || message.includes('file is not a database')) {
    return { ...base, status: 'corrupt', reason: 'integrity_check_failed' };
  }
  if (message.includes('no such table') || message.includes('no such column')) {
    return { ...base, status: 'invalid', reason: 'schema_incompatible' };
  }
  if (message.includes('database is locked') || message.includes('database table is locked')) {
    return { ...base, status: 'unreadable', reason: 'snapshot_inconsistent' };
  }
  return { ...base, status: 'unreadable', reason: 'snapshot_unavailable' };
}
