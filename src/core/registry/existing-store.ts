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

import { createSQLiteDatabase, sqliteClose, sqliteGet } from '../sqlite-wrapper.js';
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
  const homeDir = options.homeDir ?? os.homedir();
  const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
  const parsed = parseStoreInput(projectOrHash);
  if (parsed.status === 'invalid') return parsed;

  const storagePath = parsed.inputKind === 'global'
    ? memoryRoot
    : path.join(memoryRoot, 'projects', parsed.projectHash!);
  const databasePath = path.join(storagePath, 'events.sqlite');
  const base = { ...parsed, storagePath, databasePath };

  const storageEntry = safeLstat(storagePath);
  if (storageEntry.kind === 'missing') return { ...base, status: 'missing' };
  if (storageEntry.kind === 'unreadable') return { ...base, status: 'unreadable', reason: 'source_unreadable' };
  if (storageEntry.stat.isSymbolicLink() || !storageEntry.stat.isDirectory()) {
    return { ...base, status: 'invalid', reason: 'invalid_store_shape' };
  }
  if (!isRealPathWithin(memoryRoot, storagePath)) {
    return { ...base, status: 'invalid', reason: 'invalid_store_shape' };
  }

  const databaseEntry = safeLstat(databasePath);
  if (databaseEntry.kind === 'missing') return { ...base, status: 'missing' };
  if (databaseEntry.kind === 'unreadable') return { ...base, status: 'unreadable', reason: 'source_unreadable' };
  if (databaseEntry.stat.isSymbolicLink() || !databaseEntry.stat.isFile()) {
    return { ...base, status: 'invalid', reason: 'invalid_store_shape' };
  }
  if ((databaseEntry.stat.mode & 0o444) === 0) {
    return { ...base, status: 'unreadable', reason: 'source_unreadable' };
  }
  // A zero-length file is a valid, empty SQLite database — the header is
  // written lazily on first write. Treat it like a store that does not exist
  // yet so callers get the graceful empty reader, not a corruption error.
  if (databaseEntry.stat.size === 0) return { ...base, status: 'missing' };
  const headerStatus = inspectSQLiteHeader(databasePath);
  if (headerStatus === 'unreadable') return { ...base, status: 'unreadable', reason: 'source_unreadable' };
  if (databaseEntry.stat.size < SQLITE_HEADER.length || headerStatus === 'invalid') {
    return { ...base, status: 'corrupt', reason: 'integrity_check_failed' };
  }

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
  if (message.includes('database is locked') || message.includes('database table is locked')) {
    return { ...base, status: 'unreadable', reason: 'snapshot_inconsistent' };
  }
  return { ...base, status: 'unreadable', reason: 'snapshot_unavailable' };
}
