/**
 * Pre-edit memory: what earlier sessions in this project left about a file,
 * read right before Claude Code edits it (PreToolUse).
 *
 * Three kinds of item: lessons linked to the file, tool runs on the file that
 * failed, and summaries of the sessions that edited it. Found through the
 * stored tool observations for the file (a bounded scan of the newest ones,
 * plus the codify-lite file graph when it has the file), never an LLM or the
 * semantic daemon: this runs before every edit.
 *
 * SQLite calls are synchronous, so the hook watchdog cannot cut one short.
 * Same bounds as the PreCompact checkpoint: a dedicated read-only connection
 * with a short busy wait, no schema initialization, capped reads.
 *
 * An item already shown for the same file in the same session is not shown
 * again; that record is a small JSON file per session in the project store.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { makeSourceFileKey, normalizeFilePath } from '../../../core/canonical-key.js';
import { CanonicalMemoryInjectionService } from '../../../core/operations/canonical-memory-injection-service.js';
import { LessonRepository } from '../../../core/operations/lesson-repository.js';
import { getProjectStoragePath, hashProjectPath } from '../../../core/registry/project-path.js';
import { singleLineRecallText } from '../../../core/recall-sanitizer.js';
import { notActiveQuarantinedSql } from '../../../core/sqlite-event-store.js';
import { sqliteAll, type SQLiteDatabase } from '../../../core/sqlite-wrapper.js';
import type { MemoryLesson } from '../../../core/types.js';
import { privateSafeText } from './stored-text-privacy.js';

/** How long one statement waits for another connection's lock before failing. */
const DB_BUSY_TIMEOUT_MS = 200;

/** Newest tool observations scanned for the file. */
export const PRE_EDIT_SCAN_WINDOW = 2000;
/** Codify-lite links followed for the file, newest first. */
const GRAPH_LINK_LIMIT = 50;
/** Tool observations larger than this are skipped rather than parsed. */
const MAX_TOOL_OBSERVATION_CHARS = 64 * 1024;
/** Characters read per stored text, before filtering and clipping. */
const SOURCE_CHARS = 4000;
const MAX_LESSONS_SCANNED = 500;

const MAX_LESSONS = 3;
const MAX_FAILURES = 2;
const MAX_SESSIONS = 3;
const LESSON_CHARS = 160;
const FAILURE_CHARS = 200;
const SUMMARY_CHARS = 300;
/** Ceiling on the whole injected context, header included. */
export const PRE_EDIT_CONTEXT_BUDGET = 1500;

/** File times and stored times both have coarse edges; closer than this is not a change. */
const STALE_TOLERANCE_MS = 1000;
/** Dedup records of sessions idle this long are deleted. */
const SEEN_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const SEEN_STATE_DIR = 'pre-edit-check';

export interface PreEditMemoryRequest {
  cwd: string;
  sessionId: string;
  /** Absolute path of the file about to be edited. */
  filePath: string;
  now?: Date;
  /** Tests only: a smaller scan window. */
  scanWindow?: number;
}

interface TouchRow {
  id: string;
  session_id: string;
  timestamp: string;
  tool_name: unknown;
  success: unknown;
  error_message: unknown;
  file_path: unknown;
}

interface Touch {
  id: string;
  sessionId: string;
  at: Date;
  toolName: string;
  failed: boolean;
  errorMessage: string;
}

interface Item {
  key: string;
  line: string;
}

function storeDbPath(cwd: string): string {
  return path.join(getProjectStoragePath(cwd), 'events.sqlite');
}

function projectRelative(filePath: string, cwd: string): string | null {
  if (!path.isAbsolute(filePath)) return null;
  const relative = path.relative(cwd, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? normalizeFilePath(relative) : null;
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit).trimEnd()}…`;
}

/** Stored text as one filtered line, with this project's absolute paths made relative. */
function displayText(text: string, cwd: string, limit: number): string {
  const relative = privateSafeText(text).split(`${cwd}${path.sep}`).join('');
  return clip(singleLineRecallText(relative), limit);
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const TOUCH_COLUMNS = (() => {
  const json = `CASE WHEN json_valid(content) THEN content ELSE '{}' END`;
  return `id, session_id, timestamp, json_extract(${json}, '$.toolName') AS tool_name,`
    + ` json_extract(${json}, '$.success') AS success,`
    + ` substr(json_extract(${json}, '$.errorMessage'), 1, ${SOURCE_CHARS}) AS error_message,`
    + ` COALESCE(json_extract(${json}, '$.metadata.filePath'), json_extract(${json}, '$.toolInput.file_path'),`
    + ` json_extract(${json}, '$.toolInput.notebook_path')) AS file_path`;
})();

/** Tool observations on the file from other sessions: the newest scanned, plus codify-lite links. */
function readTouches(db: SQLiteDatabase, request: PreEditMemoryRequest, relPath: string): Touch[] {
  const filters = `session_id != ? AND ${notActiveQuarantinedSql()} AND length(content) <= ${MAX_TOOL_OBSERVATION_CHARS}`;
  // The inner query reads only columns stored before `content`; the outer one
  // reads content only for rows that contain the path as a JSON string.
  // Neither outer query tests event_type: that makes SQLite walk every tool
  // observation in the type index instead of looking up the listed rows. The
  // CROSS JOIN keeps the graph lookup starting from the one file entity rather
  // than from every touched_in edge. Edges only link tool observations.
  const rows = sqliteAll<TouchRow>(
    db,
    `SELECT ${TOUCH_COLUMNS} FROM events
     WHERE rowid IN (
       SELECT rowid FROM events WHERE event_type = 'tool_observation' ORDER BY timestamp DESC LIMIT ?
     ) AND ${filters} AND instr(content, ?) > 0`,
    [request.scanWindow ?? PRE_EDIT_SCAN_WINDOW, request.sessionId, JSON.stringify(request.filePath)]
  );
  try {
    rows.push(...sqliteAll<TouchRow>(
      db,
      `SELECT ${TOUCH_COLUMNS} FROM events
       WHERE id IN (
         SELECT g.src_id FROM entities n CROSS JOIN edges g ON g.dst_id = n.entity_id AND g.rel_type = 'touched_in'
         WHERE n.entity_type = 'source_file' AND n.canonical_key = ? AND g.src_type = 'event'
         ORDER BY g.created_at DESC LIMIT ${GRAPH_LINK_LIMIT}
       ) AND ${filters}`,
      [makeSourceFileKey(relPath, hashProjectPath(request.cwd)), request.sessionId]
    ));
  } catch {
    // A store from before codify-lite has no graph tables.
  }

  const touches = new Map<string, Touch>();
  for (const row of rows) {
    const at = new Date(row.timestamp);
    // Rows are re-checked against the file and the session before use.
    if (row.file_path !== request.filePath || row.session_id === request.sessionId || Number.isNaN(at.getTime())) continue;
    touches.set(row.id, {
      id: row.id,
      sessionId: row.session_id,
      at,
      toolName: typeof row.tool_name === 'string' ? row.tool_name : 'tool',
      failed: row.success === 0 || row.success === false,
      errorMessage: typeof row.error_message === 'string' ? row.error_message : ''
    });
  }
  return [...touches.values()].sort((left, right) => right.at.getTime() - left.at.getTime());
}

function latestSummary(db: SQLiteDatabase, sessionId: string): { content: string } | undefined {
  return sqliteAll<{ session_id: string; content: string }>(
    db,
    `SELECT session_id, substr(content, 1, ${SOURCE_CHARS}) AS content FROM events
     WHERE session_id = ? AND event_type = 'session_summary' AND ${notActiveQuarantinedSql()}
     ORDER BY timestamp DESC LIMIT 1`,
    [sessionId]
  ).find((row) => row.session_id === sessionId);
}

function mentionsPath(text: string, relPath: string): boolean {
  const escaped = relPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w./-])${escaped}($|[^\\w/-])`).test(text);
}

/** Recallable lessons built from an edit of the file or naming it, as automatic injection allows them. */
async function linkedLessons(db: SQLiteDatabase, cwd: string, relPath: string, touchIds: Set<string>): Promise<MemoryLesson[]> {
  try {
    const projectHash = hashProjectPath(cwd);
    const lessons = (await new LessonRepository(db).list({ projectHash, limit: MAX_LESSONS_SCANNED }))
      .filter((lesson) => lesson.sourceEventIds.some((id) => touchIds.has(id))
        || [lesson.name, lesson.trigger, lesson.scope ?? '', ...lesson.steps, ...lesson.failureModes]
          .some((text) => mentionsPath(text, relPath)));
    return new CanonicalMemoryInjectionService(db).select({
      projectHash,
      lane: 'prompt',
      candidates: lessons.map((lesson) => ({ canonicalType: 'lesson' as const, canonicalId: lesson.lessonId, value: lesson }))
    }).items.map((item) => item.value);
  } catch {
    // Lessons are supplementary; an enforcement mode without an actor fails closed.
    return [];
  }
}

function fileModifiedAt(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function collectItems(db: SQLiteDatabase, request: PreEditMemoryRequest, touches: Touch[], lessons: MemoryLesson[]): Item[] {
  const modifiedAt = fileModifiedAt(request.filePath);
  const mark = (recordedAt: Date) => modifiedAt !== null && modifiedAt > recordedAt.getTime() + STALE_TOLERANCE_MS
    ? ' (file changed since)'
    : '';
  const items: Item[] = [];

  for (const lesson of lessons.slice(0, MAX_LESSONS)) {
    items.push({
      key: `lesson:${lesson.lessonId}@${lesson.revision}`,
      line: `- Lesson "${displayText(lesson.name, request.cwd, 80)}": ${displayText(lesson.trigger, request.cwd, LESSON_CHARS)}${mark(lesson.updatedAt)}`
    });
  }
  for (const failure of touches.filter((touch) => touch.failed).slice(0, MAX_FAILURES)) {
    const detail = displayText(failure.errorMessage, request.cwd, FAILURE_CHARS);
    items.push({
      key: `failure:${failure.id}`,
      line: `- ${displayText(failure.toolName, request.cwd, 40)} on this file failed on ${day(failure.at)}`
        + `${detail ? `: ${detail}` : ''}${mark(failure.at)}`
    });
  }
  const lastTouchBySession = new Map<string, Date>();
  for (const touch of touches) {
    if (!lastTouchBySession.has(touch.sessionId)) lastTouchBySession.set(touch.sessionId, touch.at);
  }
  for (const [sessionId, lastTouch] of [...lastTouchBySession].slice(0, MAX_SESSIONS)) {
    const summary = latestSummary(db, sessionId);
    const text = summary ? displayText(summary.content, request.cwd, SUMMARY_CHARS) : '';
    if (!text) continue;
    items.push({
      key: `session:${sessionId}`,
      line: `- Session that edited it on ${day(lastTouch)}: ${text}${mark(lastTouch)}`
    });
  }
  return items;
}

function seenStatePath(cwd: string, sessionId: string): string {
  const name = createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
  return path.join(getProjectStoragePath(cwd), SEEN_STATE_DIR, `${name}.json`);
}

function readSeen(statePath: string): Record<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string[]> : {};
  } catch {
    return {};
  }
}

/** Records what was shown; a session's first record also deletes other sessions' stale records. */
function writeSeen(statePath: string, seen: Record<string, string[]>, now: Date): void {
  const dir = path.dirname(statePath);
  const firstRecord = !fs.existsSync(statePath);
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(seen));
  fs.renameSync(temp, statePath);
  if (!firstRecord) return;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      if (now.getTime() - fs.statSync(file).mtimeMs > SEEN_STATE_MAX_AGE_MS) fs.rmSync(file, { force: true });
    } catch {
      // Removed concurrently.
    }
  }
}

/** Header plus items, filled in order until the budget would be exceeded. */
function render(relPath: string, items: Item[]): { text: string; shown: Item[] } {
  const header = `## Memory About ${singleLineRecallText(relPath)}\n\n`
    + 'Notes from earlier sessions in this project that involved the file about to be edited. '
    + '"(file changed since)" marks a note recorded before the file last changed.\n\n';
  const shown: Item[] = [];
  let text = header;
  for (const item of items) {
    const next = `${text}${item.line}\n`;
    if (next.length > PRE_EDIT_CONTEXT_BUDGET) continue;
    text = next;
    shown.push(item);
  }
  return { text: shown.length > 0 ? text : '', shown };
}

/**
 * The context to inject before editing the file, or '' when there is nothing
 * new to say about it in this session. Never creates a store.
 */
export async function buildPreEditContext(request: PreEditMemoryRequest): Promise<string> {
  const relPath = projectRelative(request.filePath, request.cwd);
  if (!relPath) return '';
  const dbPath = storeDbPath(request.cwd);
  if (!fs.existsSync(dbPath)) return '';

  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: DB_BUSY_TIMEOUT_MS });
  let items: Item[];
  try {
    const touches = readTouches(db, request, relPath);
    const lessons = await linkedLessons(db, request.cwd, relPath, new Set(touches.map((touch) => touch.id)));
    items = collectItems(db, request, touches, lessons);
  } finally {
    db.close();
  }

  const statePath = seenStatePath(request.cwd, request.sessionId);
  const seen = readSeen(statePath);
  const alreadyShown = new Set(Array.isArray(seen[relPath]) ? seen[relPath] : []);
  const { text, shown } = render(relPath, items.filter((item) => !alreadyShown.has(item.key)));
  if (!text) return '';

  try {
    writeSeen(statePath, { ...seen, [relPath]: [...alreadyShown, ...shown.map((item) => item.key)] }, request.now ?? new Date());
  } catch {
    // Without the record the same items may be shown again; still show them now.
  }
  return text;
}
