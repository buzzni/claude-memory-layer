import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface MemoryRootSnapshotEntry {
  kind: 'directory' | 'file' | 'symlink' | 'other';
  mode: number;
  size: number;
  mtimeMs: number;
  contentHash?: string;
  linkTarget?: string;
}

export type MemoryRootSnapshot = Record<string, MemoryRootSnapshotEntry>;

/**
 * Snapshot every artifact below a memory root, including SQLite WAL/SHM files
 * and Lance metadata/fragments. Reads intentionally ignore atime because the
 * act of taking the snapshot may update it.
 */
export function snapshotMemoryRoot(memoryRoot: string): MemoryRootSnapshot {
  const snapshot: MemoryRootSnapshot = {};
  visit(memoryRoot, '.', snapshot);
  return snapshot;
}

export function diffMemoryRootSnapshots(
  before: MemoryRootSnapshot,
  after: MemoryRootSnapshot
): string[] {
  const changes: string[] = [];
  const names = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
  for (const name of names) {
    if (!before[name]) {
      changes.push(`added:${name}`);
    } else if (!after[name]) {
      changes.push(`removed:${name}`);
    } else if (JSON.stringify(before[name]) !== JSON.stringify(after[name])) {
      changes.push(`changed:${name}`);
    }
  }
  return changes;
}

function visit(
  absolutePath: string,
  relativePath: string,
  snapshot: MemoryRootSnapshot
): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  const entry: MemoryRootSnapshotEntry = {
    kind: entryKind(stat),
    mode: stat.mode & 0o7777,
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
  if (stat.isFile()) entry.contentHash = hashFile(absolutePath);
  if (stat.isSymbolicLink()) entry.linkTarget = fs.readlinkSync(absolutePath);
  snapshot[relativePath] = entry;

  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  const children = fs.readdirSync(absolutePath).sort();
  for (const child of children) {
    visit(path.join(absolutePath, child), path.posix.join(relativePath, child), snapshot);
  }
}

function entryKind(stat: fs.Stats): MemoryRootSnapshotEntry['kind'] {
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  if (stat.isSymbolicLink()) return 'symlink';
  return 'other';
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
