/**
 * Create an ephemeral copy for side-effect-free SQLite inspection.
 *
 * SQLite databases configured for WAL may create or update `-wal`/`-shm`
 * sidecars even when opened with SQLITE_OPEN_READONLY. Diagnostic readers use
 * this copy so all connection bookkeeping stays outside the canonical memory
 * root. The copied WAL, when present, keeps committed uncheckpointed rows in
 * the diagnostic snapshot.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface SQLiteReadSnapshot {
  databasePath: string;
  cleanup(): void;
}

export interface SQLiteReadSnapshotOptions {
  /** Internal-only parent for runtimes whose default temp directory is unavailable. */
  snapshotDirectory?: string;
  /** Snapshot storage must never be placed inside this canonical memory root. */
  canonicalMemoryRoot?: string;
}

export function createSQLiteReadSnapshot(
  sourceDatabasePath: string,
  options: SQLiteReadSnapshotOptions = {}
): SQLiteReadSnapshot {
  if (options.canonicalMemoryRoot) {
    rejectSourceOutsideOrThroughSymlink(sourceDatabasePath, options.canonicalMemoryRoot);
  }
  rejectSymlinkOrNonFile(sourceDatabasePath, 'source database');
  const sourceWalPath = `${sourceDatabasePath}-wal`;
  rejectSymlinkIfPresent(sourceWalPath, 'source WAL');

  const parent = path.resolve(options.snapshotDirectory ?? os.tmpdir());
  const realParent = fs.realpathSync(parent);
  if (!fs.lstatSync(realParent).isDirectory()) {
    throw snapshotError('SQLITE_SNAPSHOT_UNSAFE_LOCATION', 'Snapshot parent must be a local directory');
  }
  if (options.canonicalMemoryRoot) {
    const canonicalRoot = realPathIfPresent(path.resolve(options.canonicalMemoryRoot));
    if (isWithin(canonicalRoot, realParent)) {
      throw snapshotError('SQLITE_SNAPSHOT_UNSAFE_LOCATION', 'Snapshot directory must be outside canonical memory storage');
    }
  }

  const snapshotRoot = fs.mkdtempSync(path.join(realParent, 'cml-sqlite-read-'));
  const databasePath = path.join(snapshotRoot, 'events.sqlite');
  try {
    fs.copyFileSync(sourceDatabasePath, databasePath);
    copyIfLocalFile(sourceWalPath, `${databasePath}-wal`);
    return {
      databasePath,
      cleanup: () => cleanupSnapshotRoot(snapshotRoot)
    };
  } catch (error) {
    cleanupSnapshotRoot(snapshotRoot);
    throw error;
  }
}

function rejectSourceOutsideOrThroughSymlink(sourcePath: string, canonicalMemoryRoot: string): void {
  const root = path.resolve(canonicalMemoryRoot);
  const source = path.resolve(sourcePath);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw snapshotError('SQLITE_SNAPSHOT_UNSAFE_SOURCE', 'Canonical memory root must be a non-symlink directory');
  }
  const relative = path.relative(root, source);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw snapshotError('SQLITE_SNAPSHOT_UNSAFE_SOURCE', 'Source database must be inside canonical memory storage');
  }

  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw snapshotError('SQLITE_SNAPSHOT_UNSAFE_SOURCE', 'Source database path must not traverse symlinks');
    }
  }
}

function realPathIfPresent(targetPath: string): string {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return targetPath;
  }
}

function copyIfLocalFile(source: string, destination: string): void {
  try {
    const stat = fs.lstatSync(source);
    if (stat.isFile() && !stat.isSymbolicLink()) fs.copyFileSync(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function rejectSymlinkOrNonFile(targetPath: string, label: string): void {
  const stat = fs.lstatSync(targetPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw snapshotError('SQLITE_SNAPSHOT_UNSAFE_SOURCE', `${label} must be a regular non-symlink file`);
  }
}

function rejectSymlinkIfPresent(targetPath: string, label: string): void {
  try {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw snapshotError('SQLITE_SNAPSHOT_UNSAFE_SOURCE', `${label} must be a regular non-symlink file`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function snapshotError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function cleanupSnapshotRoot(snapshotRoot: string): void {
  // The target is a concrete mkdtemp result, never a caller-controlled path.
  try {
    fs.rmSync(snapshotRoot, { recursive: true, force: true });
  } catch {
    // Snapshot cleanup is best effort. A temporary-directory permission or
    // antivirus race must not turn an otherwise successful diagnostic read
    // into a canonical-store failure.
  }
}
