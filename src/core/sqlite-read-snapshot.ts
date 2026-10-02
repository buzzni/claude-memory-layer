/**
 * Create an ephemeral copy for side-effect-free SQLite inspection.
 *
 * SQLite databases configured for WAL may create or update `-wal`/`-shm`
 * sidecars even when opened with SQLITE_OPEN_READONLY. Diagnostic readers use
 * this copy so all connection bookkeeping stays outside the canonical memory
 * root. The copied WAL, when present, keeps committed uncheckpointed rows in
 * the diagnostic snapshot.
 *
 * Best effort, not a consistent point-in-time read: the database file and WAL
 * are copied one after the other without a lock. A checkpoint running between
 * the two copies can yield a torn copy (callers detect and retry that) or a
 * valid but stale view, which is indistinguishable and not retried. Callers
 * that need fresh data should repeat the read; no consistency or latency SLA
 * is implied.
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
  let realParent: string;
  let parentIsDirectory: boolean;
  try {
    realParent = fs.realpathSync(parent);
    parentIsDirectory = fs.lstatSync(realParent).isDirectory();
  } catch {
    // Failures preparing temporary storage say nothing about source readability.
    throw snapshotError('SQLITE_SNAPSHOT_UNAVAILABLE', 'Temporary snapshot storage is unavailable');
  }
  if (!parentIsDirectory) {
    throw snapshotError('SQLITE_SNAPSHOT_UNSAFE_LOCATION', 'Snapshot parent must be a local directory');
  }
  if (options.canonicalMemoryRoot) {
    const canonicalRoot = realPathIfPresent(path.resolve(options.canonicalMemoryRoot));
    if (isWithin(canonicalRoot, realParent)) {
      throw snapshotError('SQLITE_SNAPSHOT_UNSAFE_LOCATION', 'Snapshot directory must be outside canonical memory storage');
    }
  }

  let snapshotRoot: string;
  try {
    snapshotRoot = fs.mkdtempSync(path.join(realParent, 'cml-sqlite-read-'));
  } catch {
    throw snapshotError('SQLITE_SNAPSHOT_UNAVAILABLE', 'Temporary snapshot storage is unavailable');
  }
  const databasePath = path.join(snapshotRoot, 'events.sqlite');
  try {
    cloneOrCopyFile(sourceDatabasePath, databasePath);
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
    if (stat.isFile() && !stat.isSymbolicLink()) cloneOrCopyFile(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * COPYFILE_FICLONE asks for a copy-on-write clone (APFS/btrfs/XFS reflink) and
 * lets libuv fall back to a byte copy when the filesystem cannot clone, so the
 * snapshot is never a hard link or shared inode with the canonical file.
 */
function cloneOrCopyFile(source: string, destination: string): void {
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_FICLONE);
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
