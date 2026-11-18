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
  vectorsPurged: boolean;
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
  vectorStore?: { deleteEventsBefore(before: Date, eventType?: string): Promise<void> };
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
    const cutoff = options.before.toISOString().slice(0, 10);
    // One audit row for the whole purge, committed with the delete. Scope and counts only.
    const { deleted } = await store.deleteEventsBefore(options.before, options.eventType, {
      operation: 'event_delete',
      actor: 'cli',
      targetType: 'events_before',
      targetId: options.eventType ? `${cutoff}:${options.eventType}` : cutoff,
      beforeJson: {
        command: 'forget --before',
        before: cutoff,
        eventType: options.eventType ?? null,
        matchingRows: rows,
        contentBytes,
        mirrorFiles: mirrorFiles.length
      }
    });

    let vectorsPurged = false;
    const vectorStore = deps.vectorStore ?? new VectorStore(path.join(storagePath, 'vectors'));
    try {
      await vectorStore.deleteEventsBefore(options.before, options.eventType);
      vectorsPurged = true;
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
      // VACUUM rewrites the database through the WAL; the checkpoint hands the space back.
      store.getDatabase().exec('VACUUM');
      store.getDatabase().exec('PRAGMA wal_checkpoint(TRUNCATE)');
      vacuumed = true;
    } catch (error) {
      warnings.push(`VACUUM skipped; file space is reclaimed on a later vacuum: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      ...options,
      rows,
      contentBytes,
      mirrorFiles,
      applied: { deleted, vectorsPurged, mirrorFilesRemoved, vacuumed },
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
      `Events deleted ${report.applied.deleted}; vectors purged by cutoff: ${report.applied.vectorsPurged ? 'yes' : 'no'}; mirror files removed ${report.applied.mirrorFilesRemoved}`,
      `VACUUM: ${report.applied.vacuumed ? 'done' : 'skipped'}`
    );
  } else {
    lines.push('Nothing was deleted. Re-run with --confirm to apply.');
  }
  for (const warning of report.warnings ?? []) lines.push(`Warning: ${warning}`);
  return lines.join('\n');
}

export type ForgetTarget = { kind: 'event'; eventId: string } | { kind: 'session'; sessionId: string };

export type ForgetSelection =
  | { kind: 'before'; options: ForgetBeforeOptions }
  | { kind: 'target'; options: ForgetTargetOptions };

export interface ForgetTargetOptions {
  target: ForgetTarget;
  apply: boolean;
}

export interface ForgetTargetApplied {
  deleted: number;
  vectorsPurged: boolean;
  mirrorEntriesRemoved: number;
}

export interface ForgetTargetReport extends ForgetTargetOptions {
  rows: number;
  contentBytes: number;
  mirrorEntries: number;
  mirrorFiles: string[];
  applied: ForgetTargetApplied | null;
  warnings?: string[];
}

export interface ForgetTargetDeps {
  vectorStore?: { deleteEvents(eventIds: readonly string[]): Promise<void> };
}

/**
 * Exactly one of `<eventId>`, `--session` or `--before` picks what to forget. Combining them used
 * to fall through to whichever branch ran first, so a mix is refused instead of guessed at.
 */
export function resolveForgetSelection(
  eventId: string | undefined,
  options: { session?: string; before?: string; type?: string; confirm?: boolean }
): ForgetSelection {
  const id = typeof eventId === 'string' ? eventId.trim() : '';
  const session = typeof options.session === 'string' ? options.session.trim() : '';
  const hasBefore = options.before !== undefined;
  const chosen = [id !== '', session !== '', hasBefore].filter(Boolean).length;
  if (chosen === 0) throw new Error('Please specify an event ID, --session, or --before option');
  if (chosen > 1) throw new Error('Specify only one of an event ID, --session, or --before');
  if (hasBefore) return { kind: 'before', options: resolveForgetBeforeOptions(options) };
  if (options.type !== undefined) throw new Error('--type can only be combined with --before');
  const target: ForgetTarget = id !== '' ? { kind: 'event', eventId: id } : { kind: 'session', sessionId: session };
  return { kind: 'target', options: { target, apply: options.confirm === true } };
}

/**
 * Remove the markdown mirror entries written for one event or one session. Mirror files are
 * day-keyed and shared by every session, so entries are cut out of the file instead of the file
 * being removed; a file left with no entries is removed. Every file is scanned rather than only
 * the event's day because the mirror day is the writer's local date. Entry headers come from
 * `formatMirrorEntry`, whose content lines are indented four spaces, so a `\n- ts: ` line only
 * ever starts an entry.
 *
 * The rewrite is read-then-write: a hook entry appended to the same file in between is lost
 * (the same race as #267).
 */
export function removeMirrorEntries(
  storagePath: string,
  target: ForgetTarget,
  apply: boolean
): { files: string[]; entries: number; removed: number; warnings: string[] } {
  const memoryRoot = path.join(storagePath, 'memory');
  const result = { files: [] as string[], entries: 0, removed: 0, warnings: [] as string[] };
  if (!fs.existsSync(memoryRoot)) return result;

  const headerLine = target.kind === 'event' ? `  id: ${target.eventId}` : `  session: ${target.sessionId}`;
  const pending = [memoryRoot];
  const files: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(entryPath);
    }
  }

  for (const file of files.sort()) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      result.warnings.push(`could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!text.includes(headerLine)) continue;

    const chunks = text.split(/(?=\n- ts: )/);
    const kept = chunks.filter((chunk) => {
      if (!chunk.startsWith('\n- ts: ')) return true;
      const contentStart = chunk.indexOf('\n  content: |');
      const header = (contentStart === -1 ? chunk : chunk.slice(0, contentStart)).split('\n');
      return !header.includes(headerLine);
    });
    const removed = chunks.length - kept.length;
    if (removed === 0) continue;

    result.files.push(file);
    result.entries += removed;
    if (!apply) continue;
    try {
      const rest = kept.join('');
      if (rest.trim() === '') fs.unlinkSync(file);
      else fs.writeFileSync(file, rest, 'utf8');
      result.removed += removed;
    } catch (error) {
      result.warnings.push(`could not rewrite ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

/**
 * Forget one event or one session: preview by default, and with `apply` delete the SQLite rows
 * with their dependent rows and outbox jobs (one transaction, with its `event_delete` audit),
 * then the vectors of exactly the deleted ids, then the markdown mirror entries. A session takes
 * every row whatever wrote it, unlike the force-reimport scope (`importedFrom`).
 *
 * Mirror entries, and an event's vectors, are removed even when SQLite no longer has the row, so
 * a re-run after a vector or mirror failure finishes the cleanup. A session's vectors are picked
 * by the ids the delete returned, so a session re-run cannot find them again; the warning says so.
 */
export async function runForgetTarget(
  storagePath: string,
  options: ForgetTargetOptions,
  deps: ForgetTargetDeps = {}
): Promise<ForgetTargetReport> {
  const { target, apply } = options;
  const dbPath = path.join(storagePath, 'events.sqlite');
  const mirror = removeMirrorEntries(storagePath, target, false);

  let rows = 0;
  let contentBytes = 0;
  let deleted = 0;
  let deletedIds: string[] = [];
  if (fs.existsSync(dbPath)) {
    const store = new SQLiteEventStore(dbPath, { readonly: !apply });
    try {
      await store.initialize();
      const audit = { operation: 'event_delete' as const, actor: 'cli' };
      if (target.kind === 'event') {
        const event = await store.getEvent(target.eventId, { includeQuarantined: true });
        rows = event ? 1 : 0;
        contentBytes = event ? Buffer.byteLength(event.content, 'utf8') : 0;
        if (apply && event) {
          // Scope and counts only, committed with the delete; never the content.
          const removed = await store.deleteEventById(target.eventId, {
            ...audit,
            targetType: 'event',
            targetId: target.eventId,
            beforeJson: {
              command: 'forget <eventId>',
              eventId: target.eventId,
              sessionId: event.sessionId,
              eventType: event.eventType,
              matchingRows: rows,
              contentBytes,
              mirrorEntries: mirror.entries
            },
            sourceEventIds: [target.eventId]
          });
          deleted = removed ? 1 : 0;
        }
      } else {
        ({ rows, contentBytes } = await store.countSessionEvents(target.sessionId));
        if (apply && rows > 0) {
          ({ deleted, eventIds: deletedIds } = await store.deleteSessionEventsWithIds(target.sessionId, {
            audit: {
              ...audit,
              targetType: 'session',
              targetId: target.sessionId,
              beforeJson: {
                command: 'forget --session',
                sessionId: target.sessionId,
                matchingRows: rows,
                contentBytes,
                mirrorEntries: mirror.entries
              }
            }
          }));
        }
      }
    } finally {
      await store.close().catch(() => undefined);
    }
  }

  const report = { ...options, rows, contentBytes, mirrorEntries: mirror.entries, mirrorFiles: mirror.files };
  if (!apply) {
    return { ...report, applied: null, ...(mirror.warnings.length > 0 ? { warnings: mirror.warnings } : {}) };
  }

  const warnings: string[] = [];
  let vectorsPurged = true;
  const vectorIds = target.kind === 'event' ? [target.eventId] : deletedIds;
  const vectorsPath = path.join(storagePath, 'vectors');
  if (vectorIds.length > 0 && (deps.vectorStore || fs.existsSync(vectorsPath))) {
    try {
      await (deps.vectorStore ?? new VectorStore(vectorsPath)).deleteEvents(vectorIds);
    } catch (error) {
      vectorsPurged = false;
      const retry = target.kind === 'event' ? 're-run to retry' : 'a re-run of --session cannot find them again';
      warnings.push(
        `vector deletion failed; orphaned vectors of ${vectorIds.length} event(s) remain (${retry}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const mirrorApplied = removeMirrorEntries(storagePath, target, true);
  warnings.push(...mirrorApplied.warnings);

  return {
    ...report,
    applied: { deleted, vectorsPurged, mirrorEntriesRemoved: mirrorApplied.removed },
    ...(warnings.length > 0 ? { warnings } : {})
  };
}

export function formatForgetTargetReport(report: ForgetTargetReport): string {
  const scope = report.target.kind === 'event' ? `event ${report.target.eventId}` : `session ${report.target.sessionId}`;
  const kb = (report.contentBytes / 1024).toFixed(1);
  const lines = [
    `Forget ${scope} (${report.apply ? 'applied' : 'dry-run'})`,
    `Matching rows: ${report.rows} (${kb} KB of content)`,
    `Mirror entries: ${report.mirrorEntries} in ${report.mirrorFiles.length} file(s)`
  ];
  if (report.applied) {
    lines.push(
      `Events deleted ${report.applied.deleted}; vectors purged: ${report.applied.vectorsPurged ? 'yes' : 'no'}; mirror entries removed ${report.applied.mirrorEntriesRemoved}`
    );
  } else {
    lines.push('Nothing was deleted. Re-run with --confirm to apply.');
  }
  for (const warning of report.warnings ?? []) lines.push(`Warning: ${warning}`);
  return lines.join('\n');
}
