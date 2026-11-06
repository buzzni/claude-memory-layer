import * as fs from 'node:fs';
import * as path from 'node:path';

import { sanitizeSegment } from '../../core/markdown-mirror.js';
import { SQLiteEventStore } from '../../core/sqlite-event-store.js';
import { VectorStore } from '../../core/vector-store.js';

export interface ForgetBeforeOptions {
  before: Date;
  eventType?: string;
  apply: boolean;
}

export interface ForgetBeforeApplied {
  deleted: number;
  vectorsDeleted: number;
  mirrorFilesRemoved: number;
  vacuumed: boolean;
}

export interface ForgetBeforeReport extends ForgetBeforeOptions {
  rows: number;
  contentBytes: number;
  mirrorFiles: string[];
  applied: ForgetBeforeApplied | null;
  warnings?: string[];
}

export interface ForgetBeforeDeps {
  vectorStore?: { deleteEventsEverywhere(eventIds: readonly string[]): Promise<void> };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function resolveForgetBeforeOptions(
  options: { before?: string; type?: string; confirm?: boolean }
): ForgetBeforeOptions {
  const raw = String(options.before ?? '').trim();
  const before = new Date(`${raw}T00:00:00.000Z`);
  if (!DATE_ONLY.test(raw) || Number.isNaN(before.getTime()) || !before.toISOString().startsWith(raw)) {
    throw new Error('--before must be YYYY-MM-DD');
  }
  const eventType = typeof options.type === 'string' && options.type.trim() ? options.type.trim() : undefined;
  return { before, eventType, apply: options.confirm === true };
}

/**
 * Dated markdown mirror files (`memory/<namespace>/<category>/YYYY-MM-DD.md`) whose day is
 * before the cutoff. The mirror day is the event's local date while the SQLite cutoff is UTC,
 * so a purge may leave or remove up to one boundary day of mirror entries; retention purges
 * tolerate that slop.
 */
export function listMirrorFilesBefore(storagePath: string, before: Date, eventType?: string): string[] {
  const memoryRoot = path.join(storagePath, 'memory');
  if (!fs.existsSync(memoryRoot)) return [];
  const cutoffDay = before.toISOString().slice(0, 10);
  const category = eventType === undefined ? undefined : sanitizeSegment(eventType, eventType);
  const matches: string[] = [];
  const pending = [memoryRoot];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const day = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(entry.name)?.[1];
      if (!day || day >= cutoffDay) continue;
      if (category !== undefined && path.basename(current) !== category) continue;
      matches.push(entryPath);
    }
  }
  return matches.sort();
}

export async function runForgetBefore(
  storagePath: string,
  options: ForgetBeforeOptions,
  deps: ForgetBeforeDeps = {}
): Promise<ForgetBeforeReport> {
  const dbPath = path.join(storagePath, 'events.sqlite');
  const mirrorFiles = listMirrorFilesBefore(storagePath, options.before, options.eventType);
  if (!fs.existsSync(dbPath)) {
    return { ...options, rows: 0, contentBytes: 0, mirrorFiles, applied: null };
  }

  const store = new SQLiteEventStore(dbPath, { readonly: !options.apply });
  try {
    await store.initialize();
    const { rows, contentBytes } = await store.countEventsBefore(options.before, options.eventType);
    if (!options.apply) {
      return { ...options, rows, contentBytes, mirrorFiles, applied: null };
    }

    const warnings: string[] = [];
    const { deleted, eventIds } = await store.deleteEventsBefore(options.before, options.eventType);

    let vectorsDeleted = 0;
    const vectorStore = deps.vectorStore ?? new VectorStore(path.join(storagePath, 'vectors'));
    try {
      await vectorStore.deleteEventsEverywhere(eventIds);
      vectorsDeleted = eventIds.length;
    } catch (error) {
      warnings.push(`vector deletion failed; orphaned vectors remain: ${error instanceof Error ? error.message : String(error)}`);
    }

    let mirrorFilesRemoved = 0;
    for (const file of mirrorFiles) {
      try {
        fs.unlinkSync(file);
        mirrorFilesRemoved += 1;
      } catch (error) {
        warnings.push(`could not remove ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    let vacuumed = false;
    try {
      store.getDatabase().exec('VACUUM');
      vacuumed = true;
    } catch (error) {
      warnings.push(`VACUUM skipped; file space is reclaimed on a later vacuum: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      ...options,
      rows,
      contentBytes,
      mirrorFiles,
      applied: { deleted, vectorsDeleted, mirrorFilesRemoved, vacuumed },
      ...(warnings.length > 0 ? { warnings } : {})
    };
  } finally {
    await store.close().catch(() => undefined);
  }
}

export function formatForgetBeforeReport(report: ForgetBeforeReport): string {
  const scope = report.eventType ? `${report.eventType} events` : 'events of every type';
  const cutoff = report.before.toISOString().slice(0, 10);
  const mb = (report.contentBytes / (1024 * 1024)).toFixed(1);
  const lines = [
    `Forget ${scope} before ${cutoff} (${report.apply ? 'applied' : 'dry-run'})`,
    `Matching rows: ${report.rows} (${mb} MB of content)`,
    `Dated mirror files: ${report.mirrorFiles.length}`
  ];
  if (report.applied) {
    lines.push(
      `Events deleted ${report.applied.deleted}; vectors deleted ${report.applied.vectorsDeleted}; mirror files removed ${report.applied.mirrorFilesRemoved}`,
      `VACUUM: ${report.applied.vacuumed ? 'done' : 'skipped'}`
    );
  } else {
    lines.push('Nothing was deleted. Re-run with --confirm to apply.');
  }
  for (const warning of report.warnings ?? []) lines.push(`Warning: ${warning}`);
  return lines.join('\n');
}
