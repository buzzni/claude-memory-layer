/**
 * Compaction checkpoint: where a session was right before Claude Code
 * compacted its context, so the SessionStart that follows the compaction
 * (source "compact") can put it back.
 *
 * Stored in the existing memory_checkpoints table (CheckpointRepository, the
 * same rows mem-checkpoint-create writes) with a session target. Built from
 * stored events only, never an LLM call: PreCompact runs on the compaction's
 * critical path.
 *
 * SQLite calls are synchronous, so the hook watchdog cannot cut one short.
 * What bounds this path instead: a dedicated connection with a short busy
 * wait (the shared factory waits 5 s), no schema initialization, and reads
 * capped in rows and characters.
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { CheckpointRepository } from '../../../core/operations/checkpoint-repository.js';
import { getProjectStoragePath, hashProjectPath } from '../../../core/registry/project-path.js';
import { singleLineRecallText } from '../../../core/recall-sanitizer.js';
import { notActiveQuarantinedSql } from '../../../core/sqlite-event-store.js';
import { sqliteAll, type SQLiteDatabase } from '../../../core/sqlite-wrapper.js';
import { privateSafeText } from './stored-text-privacy.js';

const CHECKPOINT_KIND = 'pre_compact';
const CHECKPOINT_ACTOR = 'claude-hook:pre-compact';

/** How long one statement waits for another connection's lock before failing. */
const DB_BUSY_TIMEOUT_MS = 200;

const MAX_PROMPTS = 3;
const MAX_EDITED_FILES = 10;
/** Tool observations scanned for edited files, newest first. */
const SCAN_TOOL_OBSERVATIONS = 40;
/** Characters read per prompt/response, before filtering and clipping. */
const SOURCE_CHARS = 4000;
/** Tool observations larger than this are skipped rather than parsed. */
const MAX_TOOL_OBSERVATION_CHARS = 64 * 1024;
const PROMPT_CHARS = 300;
const RESPONSE_CHARS = 600;

/**
 * How long after it is saved a checkpoint still describes the compaction that
 * follows. SessionStart fires as soon as the summary is written; an older
 * checkpoint belongs to an earlier compaction whose PreCompact succeeded when
 * this one's did not.
 */
export const COMPACTION_CHECKPOINT_MAX_AGE_MS = 10 * 60 * 1000;
/** A clock stepped back this far still accepts the checkpoint; further, it reads as from the future. */
export const COMPACTION_CHECKPOINT_MAX_FUTURE_SKEW_MS = 60 * 1000;

const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

export interface CompactionCheckpoint {
  trigger: string;
  createdAt: Date;
  /** Oldest first. */
  recentPrompts: string[];
  lastResponse?: string;
  /** Relative to the session cwd, most recent first. */
  editedFiles: string[];
  /** The prompt and response events quoted above. */
  sourceEventIds: string[];
}

interface TextRow { id: string; session_id: string; content: string }
interface EditRow { id: string; session_id: string; file_path: unknown }

function storeDbPath(cwd: string): string {
  return path.join(getProjectStoragePath(cwd), 'events.sqlite');
}

function openStore(dbPath: string, readonly: boolean): SQLiteDatabase {
  return new Database(dbPath, { readonly, fileMustExist: true, timeout: DB_BUSY_TIMEOUT_MS });
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit).trimEnd()}…`;
}

/** The newest rows of one event type in this session, newest first. */
function recentRows<T>(db: SQLiteDatabase, select: string, sessionId: string, eventType: string, limit: number, extra = ''): T[] {
  // The inner query reads only columns stored before `content`, so it never
  // walks a large row's overflow pages; the outer one reads `limit` rows.
  return sqliteAll<T>(
    db,
    `SELECT ${select} FROM events
     WHERE rowid IN (
       SELECT rowid FROM events WHERE session_id = ? AND event_type = ?
       ORDER BY timestamp DESC LIMIT ?
     ) AND session_id = ? AND ${notActiveQuarantinedSql()} ${extra}
     ORDER BY timestamp DESC`,
    [sessionId, eventType, limit, sessionId]
  );
}

function projectRelative(filePath: unknown, cwd: string): string | null {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return null;
  const relative = path.relative(cwd, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : null;
}

function readCheckpointState(db: SQLiteDatabase, sessionId: string, cwd: string): Omit<CompactionCheckpoint, 'trigger' | 'createdAt'> {
  const textSelect = `id, session_id, substr(content, 1, ${SOURCE_CHARS}) AS content`;
  const json = `CASE WHEN json_valid(content) THEN content ELSE '{}' END`;
  // Rows are re-checked against the session before anything is saved.
  const ownSession = <T extends { session_id: string }>(rows: T[]) => rows.filter((row) => row.session_id === sessionId);

  const prompts = ownSession(recentRows<TextRow>(db, textSelect, sessionId, 'user_prompt', MAX_PROMPTS))
    .map((row) => ({ id: row.id, text: clip(privateSafeText(row.content), PROMPT_CHARS) }))
    .filter((prompt) => prompt.text)
    .reverse();
  const response = ownSession(recentRows<TextRow>(db, textSelect, sessionId, 'agent_response', 1))
    .map((row) => ({ id: row.id, text: clip(privateSafeText(row.content), RESPONSE_CHARS) }))
    .find((candidate) => candidate.text);
  const edits = ownSession(recentRows<EditRow>(
    db,
    `id, session_id, COALESCE(json_extract(${json}, '$.metadata.filePath'), json_extract(${json}, '$.toolInput.file_path'),`
      + ` json_extract(${json}, '$.toolInput.notebook_path')) AS file_path`,
    sessionId,
    'tool_observation',
    SCAN_TOOL_OBSERVATIONS,
    `AND length(content) <= ${MAX_TOOL_OBSERVATION_CHARS}`
      + ` AND json_extract(${json}, '$.toolName') IN (${EDIT_TOOLS.map((tool) => `'${tool}'`).join(', ')})`
  ));
  const editedFiles: string[] = [];
  for (const edit of edits) {
    const file = projectRelative(edit.file_path, cwd);
    if (file && !editedFiles.includes(file)) editedFiles.push(file);
    if (editedFiles.length >= MAX_EDITED_FILES) break;
  }

  return {
    recentPrompts: prompts.map((prompt) => prompt.text),
    ...(response ? { lastResponse: response.text } : {}),
    editedFiles,
    sourceEventIds: [...prompts, ...(response ? [response] : [])].map((item) => item.id)
  };
}

/**
 * Save the checkpoint for this session. Returns false, without creating a
 * store, when the project has no store or the session has no stored events.
 */
export async function saveCompactionCheckpoint(input: { cwd: string; sessionId: string; trigger: string }): Promise<boolean> {
  const dbPath = storeDbPath(input.cwd);
  if (!fs.existsSync(dbPath)) return false;

  const db = openStore(dbPath, false);
  try {
    const state = readCheckpointState(db, input.sessionId, input.cwd);
    if (state.recentPrompts.length === 0 && !state.lastResponse && state.editedFiles.length === 0) return false;

    const { sourceEventIds, ...rest } = state;
    await new CheckpointRepository(db).create({
      projectHash: hashProjectPath(input.cwd),
      sessionId: input.sessionId,
      title: `Pre-compaction checkpoint (${input.trigger})`,
      summary: `${rest.recentPrompts.length} recent request(s), ${rest.editedFiles.length} edited file(s)`,
      // The repository also redacts absolute paths and credentials in this state.
      stateJson: { kind: CHECKPOINT_KIND, trigger: input.trigger, ...rest },
      sourceEventIds,
      actor: CHECKPOINT_ACTOR
    });
    return true;
  } finally {
    db.close();
  }
}

function safeStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map(privateSafeText)
    : [];
}

/** This session's latest compaction checkpoint, or null when there is no current one. */
export async function readCompactionCheckpoint(
  cwd: string,
  sessionId: string,
  now: Date = new Date()
): Promise<CompactionCheckpoint | null> {
  const dbPath = storeDbPath(cwd);
  if (!fs.existsSync(dbPath)) return null;

  const db = openStore(dbPath, true);
  try {
    const checkpoints = await new CheckpointRepository(db)
      .list({ projectHash: hashProjectPath(cwd), sessionId, limit: 10 });
    const latest = checkpoints.find((checkpoint) => checkpoint.sessionId === sessionId
      && checkpoint.stateJson.kind === CHECKPOINT_KIND);
    if (!latest) return null;
    const age = now.getTime() - latest.createdAt.getTime();
    if (!Number.isFinite(age) || age > COMPACTION_CHECKPOINT_MAX_AGE_MS || age < -COMPACTION_CHECKPOINT_MAX_FUTURE_SKEW_MS) {
      return null;
    }

    const state = latest.stateJson;
    return {
      trigger: typeof state.trigger === 'string' ? state.trigger : 'unknown',
      createdAt: latest.createdAt,
      recentPrompts: safeStrings(state.recentPrompts),
      ...(typeof state.lastResponse === 'string' ? { lastResponse: privateSafeText(state.lastResponse) } : {}),
      editedFiles: safeStrings(state.editedFiles),
      sourceEventIds: latest.sourceEventIds
    };
  } finally {
    db.close();
  }
}

/**
 * The SessionStart section for a checkpoint. Every item is collapsed onto one
 * line so stored text cannot open a heading or list item of its own; the hook
 * output envelope sanitizes the whole context on the way out.
 */
export function formatCompactionCheckpointContext(checkpoint: CompactionCheckpoint): string {
  let context = '## Before Compaction\n\n'
    + `The conversation was just compacted (${singleLineRecallText(checkpoint.trigger)}). `
    + `This is where it stood, saved at ${checkpoint.createdAt.toISOString()} right before the compaction:\n\n`;
  if (checkpoint.recentPrompts.length > 0) {
    context += '- Recent requests, oldest first:\n';
    for (const prompt of checkpoint.recentPrompts) context += `  - ${singleLineRecallText(prompt)}\n`;
  }
  if (checkpoint.lastResponse) context += `- Last response: ${singleLineRecallText(checkpoint.lastResponse)}\n`;
  if (checkpoint.editedFiles.length > 0) {
    context += `- Files edited: ${checkpoint.editedFiles.map(singleLineRecallText).join(', ')}\n`;
  }
  return context;
}
