/**
 * Pre-edit memory: what earlier sessions in this project left about a file,
 * read right before Claude Code edits it (PreToolUse).
 *
 * Three kinds of item: lessons linked to the file, tool runs on the file that
 * failed, and summaries of the sessions that edited it. Found through the
 * stored tool observations for the file, never an LLM or the semantic daemon:
 * this runs before every edit.
 *
 * SQLite calls are synchronous, so the hook watchdog cannot cut one short.
 * Every read is bounded in rows instead: the newest tool observations, the
 * newest codify-lite links of the file, the newest session summaries and the
 * project's lessons, each capped, and each planned as index lookups that stop
 * at the cap. Older memories outside those windows are not looked for. Like
 * the PreCompact checkpoint, the connection is read-only with a short busy
 * wait and skips schema initialization.
 *
 * An item shown for a file is not shown again for that file in the same
 * session. Each shown item is reserved by creating an empty marker file
 * exclusively, so concurrent hook runs cannot both show it.
 *
 * Source trust (src/core/memory-origin.ts): every item carries the origin of
 * the row it quotes, and a low-trust one is labelled before any stored text.
 * A failed tool run quotes the tool's own error message, so it is `tool`, or
 * `unknown` when its row is not a tool observation (the failure is then read
 * from content that only claims to be one). Lessons are `derived`; a session
 * summary is classified from its row. With operations.json
 * sourceTrust.excludeUntrustedFromAutoInjection, `tool` and `unknown` items
 * are left out like in every other automatic injection, so failed runs are
 * not shown: their only content beyond a date is tool output.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { makeSourceFileKey, normalizeFilePath } from '../../../core/canonical-key.js';
import { CanonicalMemoryInjectionService } from '../../../core/operations/canonical-memory-injection-service.js';
import {
  classifyStoredEvent,
  isAutoInjectionExcludableOrigin,
  memoryOriginLabel,
  type MemoryOrigin
} from '../../../core/memory-origin.js';
import { LessonRepository } from '../../../core/operations/lesson-repository.js';
import { getProjectStoragePath, hashProjectPath } from '../../../core/registry/project-path.js';
import { sanitizeRecallText, singleLineRecallText } from '../../../core/recall-sanitizer.js';
import { notActiveQuarantinedSql } from '../../../core/sqlite-event-store.js';
import { sqliteAll, type SQLiteDatabase } from '../../../core/sqlite-wrapper.js';
import type { MemoryLesson } from '../../../core/types.js';
import { privateSafeText } from './stored-text-privacy.js';

/** How long one statement waits for another connection's lock before failing. */
const DB_BUSY_TIMEOUT_MS = 200;

/** Newest tool observations scanned for the file. */
export const PRE_EDIT_SCAN_WINDOW = 2000;
/** Newest codify-lite links of the file followed. */
const GRAPH_LINK_LIMIT = 50;
/** Newest session summaries searched for the sessions that edited the file. */
export const PRE_EDIT_SUMMARY_WINDOW = 500;
/** Tool observations larger than this (bytes) are skipped rather than read. */
const MAX_TOOL_OBSERVATION_BYTES = 64 * 1024;
/** Characters read per stored text, before filtering and clipping. */
const SOURCE_CHARS = 4000;
const MAX_LESSONS_SCANNED = 500;
/** Lesson candidates checked for events of the current session, and source event ids checked per lesson. */
const MAX_LESSON_CANDIDATES = 10;
const MAX_LESSON_SOURCE_IDS = 50;

const MAX_LESSONS = 3;
const MAX_FAILURES = 2;
const MAX_SESSIONS = 3;
/**
 * Sessions whose summary is looked up, newest edit first; one without a summary
 * does not take a slot. One read covers them all within the summary window.
 */
const MAX_SESSIONS_CHECKED = 50;
const LESSON_CHARS = 160;
const FAILURE_CHARS = 200;
const SUMMARY_CHARS = 300;
/** Ceiling on the injected context, header included, as it leaves the sanitizer. */
export const PRE_EDIT_CONTEXT_BUDGET = 1500;

/** Shown-item markers of a session are deleted after this long without a run in that session that found notes. */
const SHOWN_MARKERS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SHOWN_MARKERS_DIR = 'pre-edit-check';

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * An absolute path left in stored text after this project's paths were made
 * relative: POSIX, home-relative or Windows, with at least two segments so
 * slash commands and the like stay. Not after a word character, so relative
 * paths such as src/a/b.ts are not touched, nor after ':' or '/', so URLs stay.
 */
const OTHER_ABSOLUTE_PATH = /(?<![\w.~:/\\-])(?:~|[A-Za-z]:)?(?:[\\/][^\s\\/'"`<>()[\]{},;|*?]+){2,}[\\/]?/g;

export interface PreEditMemoryRequest {
  cwd: string;
  sessionId: string;
  /** Absolute path of the file about to be edited. */
  filePath: string;
  /** operations.json sourceTrust: leave out tool and unknown-origin items. */
  excludeUntrustedOrigins?: boolean;
  now?: Date;
  /** Tests only: smaller windows. */
  scanWindow?: number;
  summaryWindow?: number;
}

interface Target {
  /** Real path: symlinks resolved, and the case the filesystem stores. */
  canonical: string;
  /** Relative to the project's real path, with forward slashes. */
  relPath: string;
  /** Spellings the stored observations may use, as JSON strings. */
  needles: string[];
  /** The project directory as given and as its real path. */
  projectRoots: string[];
}

interface TouchRow {
  id: string;
  session_id: string;
  event_type: string;
  metadata: unknown;
  timestamp: string;
  tool_name: unknown;
  success: unknown;
  error_message: unknown;
  file_path: unknown;
}

interface Touch {
  id: string;
  sessionId: string;
  /** `tool`, or `unknown` when the row is not a tool observation or its metadata cannot be read. */
  origin: MemoryOrigin;
  at: Date;
  toolName: string;
  failed: boolean;
  errorMessage: string;
}

interface Item {
  key: string;
  origin: MemoryOrigin;
  line: string;
}

/**
 * The real path, resolving symlinks in the longest prefix that exists, so a
 * file about to be created resolves through its existing parent directories.
 */
function canonicalPath(filePath: string): string {
  const missing: string[] = [];
  let current = path.resolve(filePath);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...missing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(filePath);
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** The file inside the project, compared by real paths, or null when it is outside. */
function resolveTarget(cwd: string, filePath: string): Target | null {
  if (!path.isAbsolute(filePath)) return null;
  const projectRoot = canonicalPath(cwd);
  const canonical = canonicalPath(filePath);
  const relative = path.relative(projectRoot, canonical);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  const spellings = [path.resolve(filePath), canonical, path.join(path.resolve(cwd), relative)];
  return {
    canonical,
    relPath: normalizeFilePath(relative),
    needles: [...new Set(spellings)].map((spelling) => JSON.stringify(spelling)),
    projectRoots: [...new Set([path.resolve(cwd), projectRoot])]
  };
}

function storeDbPath(cwd: string): string {
  return path.join(getProjectStoragePath(cwd), 'events.sqlite');
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit).trimEnd()}…`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Stored text as one filtered line: private sections removed, this project's
 * absolute paths made relative, and any other absolute path masked.
 */
function displayText(text: string, target: Target, limit: number): string {
  let shown = privateSafeText(text);
  // Longest first, so /var/x does not match inside /private/var/x.
  for (const root of [...target.projectRoots].sort((left, right) => right.length - left.length)) {
    const pattern = new RegExp(`(?<![\\w.~:/\\\\-])${escapeRegExp(root)}(?:[\\\\/]|(?![\\w-]|\\.[\\w-]))`, 'g');
    shown = shown.replace(pattern, (match) => (match.length > root.length ? '' : '.'));
  }
  return clip(singleLineRecallText(shown.replace(OTHER_ABSOLUTE_PATH, '[path]')), limit);
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const TOUCH_COLUMNS = (() => {
  const json = `CASE WHEN json_valid(content) THEN content ELSE '{}' END`;
  return `id, session_id, event_type, metadata, timestamp, json_extract(${json}, '$.toolName') AS tool_name,`
    + ` json_extract(${json}, '$.success') AS success,`
    + ` substr(json_extract(${json}, '$.errorMessage'), 1, ${SOURCE_CHARS}) AS error_message,`
    + ` COALESCE(json_extract(${json}, '$.metadata.filePath'), json_extract(${json}, '$.toolInput.file_path'),`
    + ` json_extract(${json}, '$.toolInput.notebook_path')) AS file_path`;
})();

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/** Tool observations on the file from other sessions: the newest scanned, plus its newest codify-lite links. */
function readTouches(db: SQLiteDatabase, request: PreEditMemoryRequest, target: Target): Touch[] {
  // Outer filters never test event_type or an indexed equality, so SQLite looks
  // up exactly the rows the bounded inner query lists instead of walking an index.
  // The size test comes first and uses octet_length, which reads the stored
  // size without loading the value: a Write of a large file stores its whole
  // content, and length(), metadata or instr() would read all of it.
  const filters = `octet_length(content) <= ${MAX_TOOL_OBSERVATION_BYTES} AND session_id != ? AND ${notActiveQuarantinedSql()}`;
  const rows = sqliteAll<TouchRow>(
    db,
    `SELECT ${TOUCH_COLUMNS} FROM events
     WHERE rowid IN (
       SELECT rowid FROM events WHERE event_type = 'tool_observation' ORDER BY timestamp DESC LIMIT ?
     ) AND ${filters} AND (${target.needles.map(() => 'instr(content, ?) > 0').join(' OR ')})`,
    [request.scanWindow ?? PRE_EDIT_SCAN_WINDOW, request.sessionId, ...target.needles]
  );
  try {
    // Edges are only ever inserted, one per observation, so within one
    // (dst_id, rel_type) idx_edges_dst is in rowid order, newest last: walking
    // it backwards stops at the LIMIT without sorting the file's links.
    rows.push(...sqliteAll<TouchRow>(
      db,
      `SELECT ${TOUCH_COLUMNS} FROM events
       WHERE id IN (
         SELECT src_id FROM edges
         WHERE dst_id = (SELECT entity_id FROM entities WHERE entity_type = 'source_file' AND canonical_key = ? LIMIT 1)
           AND rel_type = 'touched_in' AND src_type = 'event'
         ORDER BY rowid DESC LIMIT ${GRAPH_LINK_LIMIT}
       ) AND ${filters}`,
      [makeSourceFileKey(target.relPath, hashProjectPath(request.cwd)), request.sessionId]
    ));
  } catch {
    // A store from before codify-lite has no graph tables.
  }

  const canonicalByStoredPath = new Map<string, string>();
  const touches = new Map<string, Touch>();
  for (const row of rows) {
    const at = new Date(row.timestamp);
    if (typeof row.file_path !== 'string' || !path.isAbsolute(row.file_path)
      || row.session_id === request.sessionId || Number.isNaN(at.getTime())) continue;
    // The stored path must be the same file, not merely contain the same text.
    let canonical = canonicalByStoredPath.get(row.file_path);
    if (canonical === undefined) {
      canonical = canonicalPath(row.file_path);
      canonicalByStoredPath.set(row.file_path, canonical);
    }
    if (canonical !== target.canonical) continue;
    touches.set(row.id, {
      id: row.id,
      sessionId: row.session_id,
      origin: classifyStoredEvent(row.event_type, row.metadata) === 'tool' ? 'tool' : 'unknown',
      at,
      toolName: typeof row.tool_name === 'string' ? row.tool_name : 'tool',
      failed: row.success === 0 || row.success === false,
      errorMessage: typeof row.error_message === 'string' ? row.error_message : ''
    });
  }
  return [...touches.values()].sort((left, right) => right.at.getTime() - left.at.getTime());
}

/** Each session's latest summary among the newest summaries, in one bounded read. */
function latestSummaries(db: SQLiteDatabase, request: PreEditMemoryRequest, sessionIds: string[]): Map<string, { at: Date; content: string; origin: MemoryOrigin }> {
  const summaries = new Map<string, { at: Date; content: string; origin: MemoryOrigin }>();
  if (sessionIds.length === 0) return summaries;
  // `+session_id` keeps SQLite from answering through idx_events_session,
  // which would read every event of those sessions.
  const rows = sqliteAll<{ session_id: string; event_type: string; metadata: unknown; timestamp: string; content: string }>(
    db,
    `SELECT session_id, event_type, metadata, timestamp, substr(content, 1, ${SOURCE_CHARS}) AS content FROM events
     WHERE rowid IN (
       SELECT rowid FROM events WHERE event_type = 'session_summary' ORDER BY timestamp DESC LIMIT ?
     ) AND +session_id IN (${placeholders(sessionIds.length)}) AND ${notActiveQuarantinedSql()}`,
    [request.summaryWindow ?? PRE_EDIT_SUMMARY_WINDOW, ...sessionIds]
  );
  for (const row of rows) {
    const at = new Date(row.timestamp);
    if (!sessionIds.includes(row.session_id) || Number.isNaN(at.getTime())) continue;
    const current = summaries.get(row.session_id);
    if (!current || at > current.at) {
      const origin = classifyStoredEvent(row.event_type, row.metadata);
      summaries.set(row.session_id, { at, content: row.content, origin });
    }
  }
  return summaries;
}

function mentionsPath(text: string, relPath: string): boolean {
  return new RegExp(`(^|[^\\w./-])${escapeRegExp(relPath)}($|[^\\w/-])`).test(text);
}

/**
 * Recallable lessons built from an edit of the file or naming it, as automatic
 * injection allows them, leaving out those that came from the current session.
 */
async function linkedLessons(db: SQLiteDatabase, request: PreEditMemoryRequest, target: Target, touchIds: Set<string>): Promise<MemoryLesson[]> {
  try {
    const projectHash = hashProjectPath(request.cwd);
    const linked = (await new LessonRepository(db).list({ projectHash, limit: MAX_LESSONS_SCANNED }))
      .filter((lesson) => !lesson.sourceSessionIds.includes(request.sessionId))
      .filter((lesson) => lesson.sourceEventIds.some((id) => touchIds.has(id))
        || [lesson.name, lesson.trigger, lesson.scope ?? '', ...lesson.steps, ...lesson.failureModes]
          .some((text) => mentionsPath(text, target.relPath)));
    const candidates = new CanonicalMemoryInjectionService(db).select({
      projectHash,
      lane: 'prompt',
      candidates: linked.map((lesson) => ({ canonicalType: 'lesson' as const, canonicalId: lesson.lessonId, value: lesson }))
    }).items.map((item) => item.value).slice(0, MAX_LESSON_CANDIDATES);

    const sourceIds = [...new Set(candidates.flatMap((lesson) => lesson.sourceEventIds.slice(0, MAX_LESSON_SOURCE_IDS)))];
    const fromThisSession = new Set(sourceIds.length === 0 ? [] : sqliteAll<{ id: string }>(
      db,
      `SELECT id FROM events WHERE id IN (${placeholders(sourceIds.length)}) AND +session_id = ?`,
      [...sourceIds, request.sessionId]
    ).map((row) => row.id));
    return candidates.filter((lesson) => !lesson.sourceEventIds.some((id) => fromThisSession.has(id)));
  } catch {
    // Lessons are supplementary; an enforcement mode without an actor fails closed.
    return [];
  }
}

function fileModifiedAtMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function collectItems(db: SQLiteDatabase, request: PreEditMemoryRequest, target: Target, touches: Touch[], lessons: MemoryLesson[]): Item[] {
  const modifiedAtMs = fileModifiedAtMs(target.canonical);
  // Marked only when the file certainly changed after the note: its mtime, cut
  // to whole milliseconds like stored times, is later. A filesystem with coarse
  // times only rounds mtime down, so this never marks too much; it can miss a
  // change in the same millisecond, or one made after the clock was set back.
  const mark = (recordedAt: Date) => modifiedAtMs !== null && Math.floor(modifiedAtMs) > recordedAt.getTime()
    ? ' (file changed since)'
    : '';
  const items: Item[] = [];

  for (const lesson of lessons.slice(0, MAX_LESSONS)) {
    items.push({
      key: `lesson:${lesson.lessonId}@${lesson.revision}`,
      origin: 'derived',
      line: `- Lesson "${displayText(lesson.name, target, 80)}": ${displayText(lesson.trigger, target, LESSON_CHARS)}${mark(lesson.updatedAt)}`
    });
  }
  for (const failure of touches.filter((touch) => touch.failed).slice(0, MAX_FAILURES)) {
    const detail = displayText(failure.errorMessage, target, FAILURE_CHARS);
    items.push({
      key: `failure:${failure.id}`,
      origin: failure.origin,
      line: `- ${displayText(failure.toolName, target, 40)} on this file failed on ${day(failure.at)}`
        + `${detail ? `: ${detail}` : ''}${mark(failure.at)}`
    });
  }

  const editingSessions: string[] = [];
  for (const touch of touches) {
    if (EDIT_TOOLS.has(touch.toolName) && !editingSessions.includes(touch.sessionId)) editingSessions.push(touch.sessionId);
  }
  const checked = editingSessions.slice(0, MAX_SESSIONS_CHECKED);
  const summaries = latestSummaries(db, request, checked);
  let sessionItems = 0;
  for (const sessionId of checked) {
    const summary = summaries.get(sessionId);
    const text = summary ? displayText(summary.content, target, SUMMARY_CHARS) : '';
    if (!summary || !text || sessionItems >= MAX_SESSIONS) continue;
    sessionItems++;
    items.push({
      key: `session:${sessionId}`,
      origin: summary.origin,
      line: `- Summary of a session that edited it (${day(summary.at)}): ${text}${mark(summary.at)}`
    });
  }
  return items;
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/**
 * Shown-item markers of one session: an empty file per (file, item) shown.
 * Creating it exclusively is the reservation, so of two concurrent runs only
 * one shows the item. A session's markers are deleted after 7 days without a
 * run in it that found notes; the first run of a session deletes them.
 */
class ShownMarkers {
  private readonly root: string;
  private readonly dir: string;

  constructor(cwd: string, sessionId: string, private readonly relPath: string) {
    this.root = path.join(getProjectStoragePath(cwd), SHOWN_MARKERS_DIR);
    this.dir = path.join(this.root, digest(sessionId));
  }

  private file(item: Item): string {
    return path.join(this.dir, digest(`${this.relPath}\0${item.key}`));
  }

  has(item: Item): boolean {
    return fs.existsSync(this.file(item));
  }

  /** Marks the session as active, and on its first run deletes other sessions' expired markers. */
  open(now: Date): void {
    const firstRun = !fs.existsSync(this.dir);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.utimesSync(this.dir, now, now);
    if (!firstRun) return;
    for (const name of fs.readdirSync(this.root)) {
      const entry = path.join(this.root, name);
      try {
        if (entry !== this.dir && now.getTime() - fs.statSync(entry).mtimeMs > SHOWN_MARKERS_MAX_AGE_MS) {
          fs.rmSync(entry, { recursive: true, force: true });
        }
      } catch {
        // Removed concurrently.
      }
    }
  }

  /** False when another run already reserved the item; any other failure shows it without dedup. */
  reserve(item: Item): boolean {
    try {
      fs.writeFileSync(this.file(item), '', { flag: 'wx' });
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'EEXIST';
    }
  }
}

/** The item line with its low-trust label, if any, ahead of all stored text. */
function labelled(item: Item): string {
  const label = memoryOriginLabel(item.origin);
  return label ? `- [${label}] ${item.line.slice(2)}` : item.line;
}

/**
 * Header plus the items that fit, measured after sanitizing (which can lengthen
 * text) and each reserved before it is added.
 */
function render(relPath: string, items: Item[], reserve: (item: Item) => boolean): string {
  let text = sanitizeRecallText(`## Memory About ${singleLineRecallText(relPath)}\n\n`
    + 'Notes from earlier sessions in this project that involved the file about to be edited. '
    + '"(file changed since)" marks a note recorded before the file last changed.\n\n');
  let shown = 0;
  for (const item of items) {
    const next = sanitizeRecallText(`${text}${labelled(item)}\n`);
    if (next.length > PRE_EDIT_CONTEXT_BUDGET || !reserve(item)) continue;
    text = next;
    shown++;
  }
  return shown > 0 ? text : '';
}

/**
 * The context to inject before editing the file, or '' when there is nothing
 * new to say about it in this session. Never creates a store.
 */
export async function buildPreEditContext(request: PreEditMemoryRequest): Promise<string> {
  const target = resolveTarget(request.cwd, request.filePath);
  if (!target) return '';
  const dbPath = storeDbPath(request.cwd);
  if (!fs.existsSync(dbPath)) return '';

  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: DB_BUSY_TIMEOUT_MS });
  let items: Item[];
  try {
    const touches = readTouches(db, request, target);
    const lessons = await linkedLessons(db, request, target, new Set(touches.map((touch) => touch.id)));
    items = collectItems(db, request, target, touches, lessons)
      .filter((item) => !(request.excludeUntrustedOrigins && isAutoInjectionExcludableOrigin(item.origin)));
  } finally {
    db.close();
  }
  if (items.length === 0) return '';

  const markers = new ShownMarkers(request.cwd, request.sessionId, target.relPath);
  try {
    markers.open(request.now ?? new Date());
  } catch {
    // Without markers the same items may be shown again; still show them now.
    return render(target.relPath, items, () => true);
  }
  return render(target.relPath, items.filter((item) => !markers.has(item)), (item) => markers.reserve(item));
}
