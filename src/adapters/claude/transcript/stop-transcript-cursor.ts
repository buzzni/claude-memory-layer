/**
 * Stop Transcript Cursor
 *
 * Remembers, per session, how far the Stop hook has read the transcript so
 * each Stop reads only what was appended since the previous one. A fixed tail
 * window loses the earlier assistant text of a turn whose tool results are
 * larger than the window, and re-reads the same tail on every Stop.
 *
 * State file location: ~/.claude-code/memory/.stop-cursor-{session_id}.json
 *
 * The cursor is an optimisation over the store's dedupe key, not a guarantee
 * against duplicates: re-reading a range stores nothing new. That is what
 * makes every fallback safe — a missing, stale or contended cursor only
 * means some bytes are read again. Without a usable cursor (first Stop of a
 * session, or a truncated, compacted or replaced transcript) Stop reads the
 * current turn only, so earlier turns are not attributed to this one.
 */

import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readTranscriptRange, type ClaudeTranscriptEntry } from './transcript-reader.js';
import { extractAssistantTextMessages, isUserPromptEntry, type AssistantTextMessage } from './turn-reconstructor.js';

/** Upper bound for one Stop; a larger backlog keeps only its newest bytes. */
const MAX_READ_BYTES = 8 * 1024 * 1024;
/** Bytes before the offset whose hash ties a cursor to the transcript it was taken from. */
const ANCHOR_BYTES = 256;
const STALE_CURSOR_MS = 14 * 24 * 60 * 60 * 1000;

interface StopCursor {
  sessionId: string;
  transcriptPath: string;
  offset: number;
  anchor: string;
  updatedAt: string;
}

export interface StopTranscriptReadOptions {
  maxReadBytes?: number;
}

export interface StopTranscriptBatch {
  messages: AssistantTextMessage[];
  /** Move the cursor past this batch. Call only after every message is stored. */
  commit(): void;
}

function cursorDir(): string {
  return path.join(os.homedir(), '.claude-code', 'memory');
}

function getCursorPath(sessionId: string): string {
  return path.join(cursorDir(), `.stop-cursor-${sessionId}.json`);
}

function anchorAt(transcriptPath: string, offset: number): string {
  const start = Math.max(0, offset - ANCHOR_BYTES);
  const buffer = Buffer.alloc(offset - start);
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    fs.readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    fs.closeSync(fd);
  }
  return createHash('sha256').update(buffer).digest('hex');
}

function readCursor(sessionId: string): StopCursor | null {
  try {
    const cursor = JSON.parse(fs.readFileSync(getCursorPath(sessionId), 'utf-8')) as StopCursor;
    return cursor.sessionId === sessionId && Number.isInteger(cursor.offset) ? cursor : null;
  } catch {
    return null;
  }
}

/**
 * A cursor still applies only to the same file, not past its end, and with the
 * bytes before it unchanged; truncation, compaction or a new file fail this.
 */
function isCursorValid(cursor: StopCursor, transcriptPath: string, size: number): boolean {
  if (cursor.transcriptPath !== transcriptPath || cursor.offset < 0 || cursor.offset > size) return false;
  try {
    return anchorAt(transcriptPath, cursor.offset) === cursor.anchor;
  } catch {
    return false;
  }
}

/** Drop cursors of sessions not seen for two weeks; a resumed one restarts from its current turn. */
function pruneStaleCursors(): void {
  try {
    const now = Date.now();
    for (const file of fs.readdirSync(cursorDir())) {
      if (!file.startsWith('.stop-cursor-')) continue;
      const filePath = path.join(cursorDir(), file);
      try {
        if (now - fs.statSync(filePath).mtimeMs > STALE_CURSOR_MS) fs.unlinkSync(filePath);
      } catch {
        // Another Stop may have removed it.
      }
    }
  } catch {
    // Non-critical
  }
}

/**
 * Without a cursor, earlier turns were already handled by the Stops before
 * this one (or by the tail-window Stop of an older version), so only the
 * current turn is read: the entries after its prompt.
 */
function currentTurnEntries(entries: ClaudeTranscriptEntry[]): ClaudeTranscriptEntry[] {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isUserPromptEntry(entries[i])) return entries.slice(i + 1);
  }
  return entries;
}

/**
 * Write the cursor unless a concurrent Stop already moved it further along the
 * same transcript. The check and the rename are not atomic together; losing
 * that race leaves the cursor behind, which only causes a later re-read.
 */
function writeCursor(cursor: StopCursor): void {
  try {
    const existing = readCursor(cursor.sessionId);
    if (existing && existing.offset > cursor.offset) {
      const size = fs.statSync(cursor.transcriptPath).size;
      if (isCursorValid(existing, cursor.transcriptPath, size)) return;
    }

    fs.mkdirSync(cursorDir(), { recursive: true });
    const filePath = getCursorPath(cursor.sessionId);
    // Per-writer temp file so concurrent Stops never rename each other's file.
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(cursor));
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    // Non-critical: the next Stop re-reads from the previous cursor or the current turn.
    if (process.env.CLAUDE_MEMORY_DEBUG) {
      console.error('Failed to write stop transcript cursor:', error);
    }
  }
}

/**
 * Read the assistant messages appended to the transcript since this session's
 * last committed Stop. Without a usable cursor it reads the current turn.
 */
export function readUnprocessedAssistantMessages(
  sessionId: string,
  transcriptPath: string,
  options: StopTranscriptReadOptions = {}
): StopTranscriptBatch {
  const maxReadBytes = options.maxReadBytes ?? MAX_READ_BYTES;

  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return { messages: [], commit: () => {} };

    const size = fs.statSync(transcriptPath).size;
    const previous = readCursor(sessionId);
    if (!previous) pruneStaleCursors();

    const resume = previous !== null && isCursorValid(previous, transcriptPath, size);
    const start = Math.max(resume ? previous.offset : 0, size - maxReadBytes);
    const range = readTranscriptRange(transcriptPath, start, size);
    const entries = resume ? range.entries : currentTurnEntries(range.entries);
    const { endOffset } = range;
    // Anchor what was read now, so a file replaced before commit cannot be mistaken for it.
    const cursor: StopCursor = {
      sessionId,
      transcriptPath,
      offset: endOffset,
      anchor: anchorAt(transcriptPath, endOffset),
      updatedAt: new Date().toISOString()
    };

    return { messages: extractAssistantTextMessages(entries), commit: () => writeCursor(cursor) };
  } catch (error) {
    if (process.env.CLAUDE_MEMORY_DEBUG) {
      console.error('Failed to read stop transcript:', error);
    }
    return { messages: [], commit: () => {} };
  }
}
