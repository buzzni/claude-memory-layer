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

export function createSQLiteReadSnapshot(sourceDatabasePath: string): SQLiteReadSnapshot {
  const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cml-sqlite-read-'));
  const databasePath = path.join(snapshotRoot, 'events.sqlite');
  try {
    fs.copyFileSync(sourceDatabasePath, databasePath);
    copyIfLocalFile(`${sourceDatabasePath}-wal`, `${databasePath}-wal`);
    return {
      databasePath,
      cleanup: () => cleanupSnapshotRoot(snapshotRoot)
    };
  } catch (error) {
    cleanupSnapshotRoot(snapshotRoot);
    throw error;
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

function cleanupSnapshotRoot(snapshotRoot: string): void {
  // The target is a concrete mkdtemp result, never a caller-controlled path.
  fs.rmSync(snapshotRoot, { recursive: true, force: true });
}
