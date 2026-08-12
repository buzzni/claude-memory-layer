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

export interface ExistingStoreResolution {
  status: ExistingStoreStatus;
  inputKind: ExistingStoreInputKind;
  projectHash?: string;
  /** Internal-only resolved location. Public formatters must not print it. */
  storagePath?: string;
  /** Internal-only SQLite location. Public formatters must not print it. */
  databasePath?: string;
}

export interface ExistingStoreResolverOptions {
  homeDir?: string;
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
  if (storageEntry.kind === 'unreadable') return { ...base, status: 'unreadable' };
  if (storageEntry.stat.isSymbolicLink() || !storageEntry.stat.isDirectory()) {
    return { ...base, status: 'invalid' };
  }

  const databaseEntry = safeLstat(databasePath);
  if (databaseEntry.kind === 'missing') return { ...base, status: 'missing' };
  if (databaseEntry.kind === 'unreadable') return { ...base, status: 'unreadable' };
  if (databaseEntry.stat.isSymbolicLink() || !databaseEntry.stat.isFile()) {
    return { ...base, status: 'invalid' };
  }
  if ((databaseEntry.stat.mode & 0o444) === 0) return { ...base, status: 'unreadable' };
  const headerStatus = inspectSQLiteHeader(databasePath);
  if (headerStatus === 'unreadable') return { ...base, status: 'unreadable' };
  if (databaseEntry.stat.size < SQLITE_HEADER.length || headerStatus === 'invalid') {
    return { ...base, status: 'corrupt' };
  }

  let db;
  try {
    db = createSQLiteDatabase(databasePath, { readonly: true, walMode: false });
    const integrity = sqliteGet<Record<string, string>>(db, 'PRAGMA quick_check(1)');
    if (Object.values(integrity ?? {})[0] !== 'ok') return { ...base, status: 'corrupt' };
    const eventsTable = sqliteGet<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'"
    );
    if (!eventsTable) return { ...base, status: 'invalid' };
  } catch (error) {
    return { ...base, status: isPermissionError(error) ? 'unreadable' : 'corrupt' };
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
    return { status: 'invalid', inputKind: 'project-path' };
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
