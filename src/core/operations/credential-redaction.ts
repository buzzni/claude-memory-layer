/**
 * Retroactive credential redaction for an already-populated store.
 *
 * The ingest-side fix stops new leaks, but everything written before it stays
 * in place. A partial scrub is worse than none — it reads as "cleaned" while
 * copies survive elsewhere — so this covers every place a prompt's text is
 * duplicated:
 *
 * - `events.content`
 * - `memory_helpfulness.query_preview` and `injected_content`
 * - `retrieval_traces.query_text` and `raw_query_text`
 * - the markdown mirror under `<storage>/memory/`
 * - the Lance vector store, which keeps the source text alongside the embedding
 *
 * Vectors cannot be edited in place, so affected events are deleted from the
 * vector store and re-queued for embedding; the next embedding pass rebuilds
 * them from the redacted SQLite content.
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { sqliteAll, sqliteRun, type SQLiteDatabase } from '../sqlite-wrapper.js';
import { applyPrivacyFilter } from '../privacy/filter.js';
import { sanitizeGovernanceAuditValue, writeGovernanceAuditEntrySync } from './governance-audit.js';
import type { Config } from '../types.js';

const REDACTION_PRIVACY_CONFIG: Config['privacy'] = {
  excludePatterns: ['password', 'secret', 'api_key', 'token', 'bearer'],
  anonymize: false,
  privateTags: {
    enabled: true,
    marker: '[PRIVATE]',
    preserveLineCount: false,
    supportedFormats: ['xml']
  }
};

interface TextColumnTarget {
  table: string;
  idColumn: string;
  columns: string[];
}

const SQLITE_TARGETS: TextColumnTarget[] = [
  { table: 'events', idColumn: 'id', columns: ['content'] },
  { table: 'memory_helpfulness', idColumn: 'id', columns: ['query_preview', 'injected_content'] },
  { table: 'retrieval_traces', idColumn: 'trace_id', columns: ['query_text', 'raw_query_text'] }
];

export interface RedactionRowChange {
  table: string;
  rowId: string;
  column: string;
  /** Already-redacted preview, safe to print. */
  preview: string;
  /** How output names the row, safe to print: its id, or `<table> rowid <n>` (see rowReference). */
  rowRef: string;
}

export interface RedactionFileChange {
  filePath: string;
  occurrences: number;
  /** The apply could not rewrite the file, so it still holds the credential. */
  writeFailed?: boolean;
}

export interface CredentialRedactionPlan {
  dryRun: boolean;
  rowChanges: RedactionRowChange[];
  fileChanges: RedactionFileChange[];
  /** Event ids whose vectors must be rebuilt from the redacted text. */
  affectedEventIds: string[];
  vectorsDeleted: number;
  embeddingsRequeued: number;
  /** Shared by every audit row of one apply. */
  runId?: string;
  /** Transactions the apply committed, one `credential_redact` audit row each. */
  batchesCommitted?: number;
  /** Longest time a committed batch held the write lock, in milliseconds. */
  longestBatchLockMs?: number;
  /** Rows that changed or were deleted after the scan read them; left for the next run. */
  rowsSkipped?: number;
  /** Rows whose update failed even on its own; they keep their text. */
  rowsFailed?: number;
  /** The first error behind `rowsFailed`. */
  rowError?: string;
  /** SQLite stayed busy, so the apply stopped before the rows it had not reached. */
  sqliteBusy?: string;
  /**
   * Events whose old vectors could not be deleted, as eventReference names
   * them: the event id, or its events rowid when the id itself looks like it
   * holds a credential.
   */
  vectorDeleteFailures?: string[];
  /** How many of `vectorDeleteFailures` are rowids standing in for a hidden id. */
  vectorDeleteFailuresHidden?: number;
  /** File holding every entry of `vectorDeleteFailures`, one per line, readable by the user only. */
  vectorDeleteFailuresFile?: string;
  /** Redacted events that could not be queued for re-embedding. */
  requeueFailures?: string[];
  requeueError?: string;
  /** The closing audit row of the run could not be written. */
  summaryAuditError?: string;
}

export function redactText(value: string): string {
  return applyPrivacyFilter(value, REDACTION_PRIVACY_CONFIG).content;
}

function previewOf(redacted: string): string {
  const compact = redacted.replace(/\s+/g, ' ').trim();
  return compact.length > 120 ? `${compact.slice(0, 120)}…` : compact;
}

function tableExists(db: SQLiteDatabase, table: string): boolean {
  const rows = sqliteAll<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
    [table]
  );
  return rows.length > 0;
}

function columnExists(db: SQLiteDatabase, table: string, column: string): boolean {
  const rows = sqliteAll<{ name: string }>(db, `PRAGMA table_info(${table})`);
  return rows.some((row) => row.name === column);
}

interface PendingRowRedaction {
  change: RedactionRowChange;
  idColumn: string;
  original: string;
  redacted: string;
}

/**
 * Rows the apply writes per transaction. Each batch is one short IMMEDIATE
 * transaction holding its guarded updates and its own audit row, which bounds
 * three things by this number: the work done while hooks wait on the write
 * lock (100 long rows with their FTS reindex and the audit row stay in the
 * tens of milliseconds, far under the hooks' 5 s busy timeout), the redactions
 * an interrupted run loses compared with committing every row on its own, and
 * the ids in one audit row's `sourceEventIds`.
 */
export const REDACTION_BATCH_SIZE = 100;

/**
 * Scan SQLite for values the privacy filter would change. Reads only, outside
 * any write transaction, so hooks keep writing while the filter runs.
 */
export function planSqliteRedaction(db: SQLiteDatabase): { rowChanges: RedactionRowChange[]; affectedEventIds: string[] } {
  const pending = Array.from(scanSqliteRedaction(db));
  return { rowChanges: pending.map(({ change }) => change), affectedEventIds: eventIdsOf(pending) };
}

function eventIdsOf(rows: PendingRowRedaction[]): string[] {
  const ids = new Set<string>();
  for (const { change } of rows) {
    if (change.table === 'events') ids.add(change.rowId);
  }
  return Array.from(ids);
}

/** The changed events as rowReference names them, so an id that may hold a credential is never stored. */
function eventReferencesOf(rows: PendingRowRedaction[]): string[] {
  const refs = new Set<string>();
  for (const { change } of rows) {
    if (change.table === 'events') refs.add(change.rowRef);
  }
  return Array.from(refs);
}

function* scanSqliteRedaction(db: SQLiteDatabase): Generator<PendingRowRedaction> {
  for (const target of SQLITE_TARGETS) {
    if (!tableExists(db, target.table)) continue;
    for (const column of target.columns) {
      if (!columnExists(db, target.table, column)) continue;

      const rows = sqliteAll<Record<string, unknown>>(
        db,
        `SELECT ${target.idColumn} AS row_id, rowid AS row_rowid, ${column} AS value
         FROM ${target.table}
         WHERE ${column} IS NOT NULL AND ${column} <> ''`
      );

      for (const row of rows) {
        const value = typeof row.value === 'string' ? row.value : null;
        const rowId = row.row_id === null || row.row_id === undefined ? null : String(row.row_id);
        if (!value || !rowId) continue;

        const redacted = redactText(value);
        if (redacted === value) continue;

        yield {
          change: {
            table: target.table,
            rowId,
            column,
            preview: previewOf(redacted),
            rowRef: rowReference(target.table, rowId, Number(row.row_rowid)).ref
          },
          idColumn: target.idColumn,
          original: value,
          redacted
        };
      }
    }
  }
}

interface BatchAudit {
  actor: string;
  runId: string;
  batch: number;
}

/**
 * One batch: the guarded updates, the removal of the changed events' queued
 * embedding jobs (which still carry the old text) and the batch's audit row,
 * committed or rolled back together. An update applies only while the value
 * still matches what the scan read, so a row that changed or was deleted in
 * between is skipped instead of overwritten with the redacted form of its old
 * text. The audit row holds counts and event ids only — never a secret, the
 * text it was replaced in, or a preview — and is written only when a row
 * changed.
 */
function commitBatch(
  db: SQLiteDatabase,
  rows: PendingRowRedaction[],
  audit: BatchAudit
): { applied: PendingRowRedaction[]; lockMs: number } {
  let lockedAt = 0;
  const applied = db.transaction(() => {
    lockedAt = performance.now();
    const changed = rows.filter(({ change, idColumn, original, redacted }) => sqliteRun(
      db,
      `UPDATE ${change.table} SET ${change.column} = ? WHERE ${idColumn} = ? AND ${change.column} = ?`,
      [redacted, change.rowId, original]
    ).changes > 0);
    if (changed.length > 0) {
      const rowsByColumn: Record<string, number> = {};
      for (const { change } of changed) {
        const key = `${change.table}.${change.column}`;
        rowsByColumn[key] = (rowsByColumn[key] ?? 0) + 1;
      }
      const eventIds = eventIdsOf(changed);
      // A queued embedding job carries its own copy of the old text, and the worker embeds that copy.
      // Dropping it with the update means no failure later in the run can leave it queued.
      deleteQueuedJobs(db, eventIds);
      writeGovernanceAuditEntrySync(db, {
        operation: 'credential_redact',
        actor: audit.actor,
        targetType: 'store',
        targetId: 'redact-credentials',
        afterJson: {
          runId: audit.runId,
          batch: audit.batch,
          rowsRedacted: changed.length,
          rowsByColumn,
          rowsSkipped: rows.length - changed.length,
          eventsAffected: eventIds.length
        },
        // At most one batch of rows, so at most REDACTION_BATCH_SIZE ids. Named as rowReference names
        // them: the audit sanitizer does not know every token shape the privacy filter does (`ghp_…`).
        sourceEventIds: eventReferencesOf(changed)
      });
    }
    return changed;
  }).immediate();
  return { applied, lockMs: performance.now() - lockedAt };
}

/** True when the audit sanitizer or the privacy filter would change this id, so it may hold a credential. */
function idMayHoldCredential(id: string): boolean {
  return sanitizeGovernanceAuditValue(id) !== id || redactText(id) !== id;
}

/**
 * How output, the vector-failure file and the audit's `sourceEventIds` name a
 * row. Most ids are UUIDs, but imported events keep whatever id they came with.
 * One that may hold a credential is named by its rowid instead, which stays
 * valid until the next VACUUM (`forget` runs one).
 */
function rowReference(table: string, rowId: string, rowid: number | undefined): { ref: string; hidden: boolean } {
  if (!idMayHoldCredential(rowId)) return { ref: rowId, hidden: false };
  return { ref: rowid === undefined ? `a row no longer in ${table}` : `${table} rowid ${rowid}`, hidden: true };
}

function eventReference(db: SQLiteDatabase, eventId: string): { ref: string; hidden: boolean } {
  const rowid = idMayHoldCredential(eventId)
    ? sqliteAll<{ rowid: number }>(db, 'SELECT rowid FROM events WHERE id = ?', [eventId])[0]?.rowid
    : undefined;
  return rowReference('events', eventId, rowid);
}

function isBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The old text of a mirror file, kept under a second name while a run replaced
 * it (see replaceMirrorFile). Only this command makes such names.
 */
const KEPT_SUFFIX = /(?<=\.md)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.old$/;

function walkMarkdown(dir: string, found: string[], kept: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, found, kept);
    else if (entry.isFile() && entry.name.endsWith('.md')) found.push(full);
    else if (entry.isFile() && KEPT_SUFFIX.test(entry.name)) kept.push(full);
  }
}

/** The lines formatMirrorEntry writes around an event's content. */
const MIRROR_CONTENT_HEADER = '  content: |';
const MIRROR_CONTENT_INDENT = '    ';

/**
 * Redact a mirror file entry by entry. Run over the whole file, the marker
 * cleanup ate the newline and indentation after each marker — the next
 * entry's `- ts:` header landed on the previous content line — and a tag
 * opened in one entry could match a close in a later one. So each content
 * block is redacted on its own, exactly as its row is, and everything outside
 * one (headers, or a file not in the mirror format) keeps its whitespace.
 */
function redactMirrorText(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let other: string[] = [];
  const flushOther = () => {
    if (other.length === 0) return;
    out.push(applyPrivacyFilter(other.join('\n'), REDACTION_PRIVACY_CONFIG, { collapseMarkers: false }).content);
    other = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i++];
    other.push(line);
    if (line !== MIRROR_CONTENT_HEADER) continue;
    const start = i;
    while (i < lines.length && lines[i].startsWith(MIRROR_CONTENT_INDENT)) i++;
    if (i === start) continue;
    flushOther();
    const content = lines.slice(start, i).map((l) => l.slice(MIRROR_CONTENT_INDENT.length)).join('\n');
    out.push(redactText(content).split('\n').map((l) => `${MIRROR_CONTENT_INDENT}${l}`).join('\n'));
  }
  flushOther();
  return out.join('\n');
}

/**
 * The markdown mirror is a plain-text copy of ingested events, so it leaks
 * independently of the database.
 */
export function planMarkdownRedaction(
  storagePath: string,
  options: { apply: boolean }
): RedactionFileChange[] {
  const memoryRoot = path.join(storagePath, 'memory');
  if (!fs.existsSync(memoryRoot)) return [];

  const files: string[] = [];
  const keptFiles: string[] = [];
  walkMarkdown(memoryRoot, files, keptFiles);

  const changes: RedactionFileChange[] = [];
  // Before the scan, so that a second name left on a mirror file does not make
  // it look hard-linked.
  for (const keptPath of keptFiles) {
    let old: string;
    try {
      old = fs.readFileSync(keptPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      // It may hold the old text: kept, and reported so that the run is not finished.
      changes.push({ filePath: keptPath, occurrences: 1, writeFailed: true });
      continue;
    }
    const occurrences = redactMirrorText(old).split('[REDACTED]').length - old.split('[REDACTED]').length;
    changes.push({ filePath: keptPath, occurrences: Math.max(1, occurrences) });
    if (options.apply) {
      try {
        recoverKeptFile(keptPath, keptPath.replace(KEPT_SUFFIX, ''), old);
      } catch {
        changes[changes.length - 1].writeFailed = true;
      }
    }
  }

  for (const filePath of files) {
    let fd: number;
    try {
      fd = fs.openSync(filePath, 'r');
    } catch {
      continue;
    }
    try {
      let original: string;
      try {
        original = fs.readFileSync(fd, 'utf8');
      } catch {
        continue;
      }
      const redacted = redactMirrorText(original);
      if (redacted === original) continue;

      const occurrences = redacted.split('[REDACTED]').length - original.split('[REDACTED]').length;
      changes.push({ filePath, occurrences: Math.max(1, occurrences) });
      if (options.apply) {
        const keptPath = `${filePath}.${randomUUID()}.old`;
        try {
          replaceMirrorFile(filePath, fd, redacted, keptPath);
        } catch {
          // A write failure must not abort the rest; it is reported per file.
          changes[changes.length - 1].writeFailed = true;
        }
        // Left behind only when it could be neither deleted nor put back.
        if (fs.existsSync(keptPath)) changes.push({ filePath: keptPath, occurrences, writeFailed: true });
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return changes;
}

/** How link() says the filesystem has no hard links, as opposed to a full disk or a permission. */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

/**
 * Hooks append to mirror files with no lock, so truncating and rewriting one in
 * place drops every entry appended after it was read. The redacted copy
 * replaces the file by rename instead: hooks that open the path afterwards
 * append to the copy, and `fd`, still on the replaced file and positioned where
 * the read stopped, picks up whatever was appended to it before the swap.
 */
function replaceMirrorFile(filePath: string, fd: number, redacted: string, keptPath: string): void {
  const { mode, nlink } = fs.fstatSync(fd);
  // A rename would leave the file's other names on the old text, so a
  // hard-linked file is still rewritten in place, race and all.
  if (nlink > 1) {
    fs.writeFileSync(filePath, redacted, 'utf8');
    return;
  }
  // Rename ignores the file's own permissions; keep refusing read-only files.
  fs.accessSync(filePath, fs.constants.W_OK);
  const stagingPath = `${filePath}.${randomUUID()}.tmp`;
  // The replaced file keeps `keptPath` as a second name until what the hooks
  // appended to it is in the copy. Renaming it back needs no disk space, so a
  // full disk cannot lose those entries: the file is left as it was, for a
  // re-run. If it can be neither deleted nor put back, a re-run recovers it.
  try {
    fs.linkSync(filePath, keptPath);
  } catch (error) {
    if (!NO_HARD_LINKS.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
    // A filesystem without hard links: rewrite in place, as before #267.
    fs.writeFileSync(filePath, redacted, 'utf8');
    return;
  }
  try {
    fs.writeFileSync(stagingPath, redacted, { encoding: 'utf8', flag: 'wx' });
    fs.chmodSync(stagingPath, mode & 0o777);
    fs.renameSync(stagingPath, filePath);
  } catch (error) {
    fs.rmSync(stagingPath, { force: true });
    fs.rmSync(keptPath, { force: true });
    throw error;
  }
  try {
    const appended = fs.readFileSync(fd, 'utf8');
    if (appended.length > 0) fs.appendFileSync(filePath, redactMirrorText(appended), 'utf8');
  } catch (error) {
    fs.renameSync(keptPath, filePath);
    throw error;
  }
  try {
    fs.rmSync(keptPath);
  } catch {
    // The copy is complete; the caller reports the old text left at keptPath.
  }
}

const MIRROR_ENTRY_START = '\n- ts: ';

/**
 * Finish what a run left at `keptPath`: the mirror file gets, redacted, the
 * entries of the old text it does not hold yet, and the old text goes. It only
 * ever appends to the mirror file, as the hooks do, so nothing they wrote
 * since is lost. When both names are still the same file, the run stopped
 * before the swap and the second name just goes.
 */
function recoverKeptFile(keptPath: string, filePath: string, old: string): void {
  const kept = fs.statSync(keptPath);
  let current: string | undefined;
  try {
    const mirror = fs.statSync(filePath);
    if (mirror.dev !== kept.dev || mirror.ino !== kept.ino) current = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    current = ''; // The mirror file is gone: the old text, redacted, recreates it.
  }
  if (current !== undefined) {
    const missing = redactedEntriesMissingFrom(current, old);
    if (missing.length > 0) fs.appendFileSync(filePath, missing, 'utf8');
  }
  fs.rmSync(keptPath);
}

/** `text` cut before each entry header; the first piece may be text before any entry. */
function mirrorEntries(text: string): string[] {
  const starts = [0];
  for (let i = text.indexOf(MIRROR_ENTRY_START, 1); i !== -1; i = text.indexOf(MIRROR_ENTRY_START, i + 1)) starts.push(i);
  return starts.map((start, k) => text.slice(start, starts[k + 1] ?? text.length));
}

/** The event id formatMirrorEntry writes on the line right after the entry's `- ts:` header. */
function mirrorEntryId(entry: string): string | undefined {
  const [blank, header, idLine] = entry.split('\n', 3);
  if (blank !== '' || !header?.startsWith('- ts: ')) return undefined;
  return /^ {2}id: (\S+)$/.exec(idLine ?? '')?.[1];
}

/**
 * The entries of the old text, redacted, that `current` does not hold yet.
 * Hooks may have written entries between the copied ones, so an entry is
 * looked up by its event id, and it counts as held only when an entry with
 * that id is exactly the redacted old one: a copy cut short while the entry
 * was being written still lacks the rest. A piece with no id (text before the
 * first entry, or a broken one) counts as held only when its redacted text is
 * in `current` as it is. Anything else is added, redacted: at worst a
 * duplicate, never the old text.
 */
function redactedEntriesMissingFrom(current: string, old: string): string {
  const held = new Map<string, string[]>();
  for (const entry of mirrorEntries(current)) {
    const id = mirrorEntryId(entry);
    if (id !== undefined) held.set(id, [...(held.get(id) ?? []), entry]);
  }
  return mirrorEntries(old)
    .map((entry) => ({ id: mirrorEntryId(entry), redacted: redactMirrorText(entry) }))
    .filter(({ id, redacted }) =>
      id === undefined ? !current.includes(redacted) : !held.get(id)?.includes(redacted))
    .map(({ redacted }) => redacted)
    .join('');
}

/**
 * Delete the events' embedding jobs in one statement. `embedding_outbox` has no
 * index on `event_id`, so every DELETE scans the whole queue: one per batch
 * keeps a long backlog from stretching the write lock, where one per event
 * held it for seconds on a 15,000-job queue.
 */
function deleteQueuedJobs(db: SQLiteDatabase, eventIds: string[]): void {
  if (eventIds.length === 0 || !tableExists(db, 'embedding_outbox')) return;
  sqliteRun(
    db,
    `DELETE FROM embedding_outbox WHERE event_id IN (${eventIds.map(() => '?').join(', ')})`,
    eventIds
  );
}

/**
 * Queue redacted events for re-embedding. Callers delete the stale vectors
 * separately, since that needs the vector store rather than SQLite.
 */
export function requeueEmbeddings(
  db: SQLiteDatabase,
  eventIds: string[],
  options: { apply: boolean }
): number {
  if (eventIds.length === 0 || !tableExists(db, 'embedding_outbox')) return 0;

  if (options.apply) deleteQueuedJobs(db, eventIds);
  let queued = 0;
  for (const eventId of eventIds) {
    const rows = sqliteAll<{ content: string }>(
      db,
      `SELECT content FROM events WHERE id = ?`,
      [eventId]
    );
    const content = rows[0]?.content;
    if (typeof content !== 'string' || content.length === 0) continue;
    queued += 1;
    if (!options.apply) continue;

    sqliteRun(
      db,
      `INSERT INTO embedding_outbox (id, event_id, content, status, retry_count, created_at)
       VALUES (?, ?, ?, 'pending', 0, datetime('now'))`,
      [`redact-${eventId}`, eventId, content]
    );
  }
  return queued;
}

/**
 * The whole apply. It keeps the order the command always had — SQLite, then the
 * Markdown mirror — but commits SQLite in batches of `batchSize` rows as the
 * scan finds them, so a failure or an interruption never takes back more than
 * the batch in flight:
 *
 * 1. Each batch commits its guarded updates and its audit row together
 *    (commitBatch), then deletes the batch's old vectors and queues its events
 *    for re-embedding, in that order: queued first, the embedding worker could
 *    write a fresh vector the delete then removes.
 * 2. A batch that fails is retried row by row, so one row that cannot be
 *    written keeps only itself unredacted, as it would have with a commit per
 *    row; earlier batches stay committed. A busy database stops the SQLite
 *    pass instead, since every retry would wait out the busy timeout again.
 * 3. The mirror is rewritten whatever happened to SQLite.
 * 4. A closing audit row records the run's totals and the mirror outcome; a run
 *    with batch rows but no closing row did not finish.
 *
 * Failures come back in the plan instead of being thrown, so the caller can
 * print what did and did not change; credentialRedactionExitCode turns any of
 * them into a non-zero exit.
 */
export async function applyCredentialRedaction(
  db: SQLiteDatabase,
  storagePath: string,
  options: {
    actor: string;
    deleteEventVectors: (eventIds: string[]) => Promise<void>;
    batchSize?: number;
  }
): Promise<CredentialRedactionPlan> {
  const batchSize = options.batchSize ?? REDACTION_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > REDACTION_BATCH_SIZE) {
    // The bound is what keeps the write lock and an audit row's event ids small.
    throw new RangeError(`batchSize must be an integer from 1 to ${REDACTION_BATCH_SIZE}`);
  }
  const runId = randomUUID();
  const plan: CredentialRedactionPlan = {
    dryRun: false, rowChanges: [], fileChanges: [], affectedEventIds: [], vectorsDeleted: 0, embeddingsRequeued: 0,
    runId, batchesCommitted: 0, longestBatchLockMs: 0, rowsSkipped: 0, rowsFailed: 0,
    vectorDeleteFailures: [], requeueFailures: []
  };
  const vectorDeleteFailures: string[] = [];
  const requeueFailures: string[] = [];

  const afterCommit = async (applied: PendingRowRedaction[]): Promise<void> => {
    plan.rowChanges.push(...applied.map(({ change }) => change));
    const eventIds = eventIdsOf(applied);
    if (eventIds.length === 0) return;
    plan.affectedEventIds.push(...eventIds);
    try {
      await options.deleteEventVectors(eventIds);
      plan.vectorsDeleted += eventIds.length;
    } catch {
      vectorDeleteFailures.push(...eventIds);
    }
    try {
      plan.embeddingsRequeued += db.transaction(() => requeueEmbeddings(db, eventIds, { apply: true })).immediate();
    } catch (error) {
      requeueFailures.push(...eventIds);
      plan.requeueError ??= messageOf(error);
      // A busy store stops the SQLite pass here too, as it does for a batch.
      if (isBusyError(error)) throw error;
    }
  };

  const flush = async (rows: PendingRowRedaction[]): Promise<void> => {
    if (rows.length === 0) return;
    let outcome: { applied: PendingRowRedaction[]; lockMs: number };
    try {
      outcome = commitBatch(db, rows, { actor: options.actor, runId, batch: plan.batchesCommitted! + 1 });
    } catch (error) {
      if (isBusyError(error)) throw error;
      if (rows.length > 1) {
        for (const row of rows) await flush([row]);
      } else {
        plan.rowsFailed! += 1;
        plan.rowError ??= messageOf(error);
      }
      return;
    }
    plan.longestBatchLockMs = Math.max(plan.longestBatchLockMs!, outcome.lockMs);
    plan.rowsSkipped! += rows.length - outcome.applied.length;
    if (outcome.applied.length > 0) plan.batchesCommitted! += 1;
    await afterCommit(outcome.applied);
  };

  try {
    let batch: PendingRowRedaction[] = [];
    for (const row of scanSqliteRedaction(db)) {
      batch.push(row);
      if (batch.length < batchSize) continue;
      await flush(batch);
      batch = [];
    }
    await flush(batch);
  } catch (error) {
    if (!isBusyError(error)) throw error;
    plan.sqliteBusy = messageOf(error);
  }

  plan.fileChanges = planMarkdownRedaction(storagePath, { apply: true });
  const mirrorFilesFailed = plan.fileChanges.filter((change) => change.writeFailed).length;
  const mirrorFilesRedacted = plan.fileChanges.length - mirrorFilesFailed;

  if (plan.batchesCommitted! > 0 || mirrorFilesRedacted > 0) {
    try {
      db.transaction(() => writeGovernanceAuditEntrySync(db, {
        operation: 'credential_redact',
        actor: options.actor,
        targetType: 'store',
        targetId: 'redact-credentials',
        afterJson: {
          runId,
          summary: true,
          batches: plan.batchesCommitted,
          rowsRedacted: plan.rowChanges.length,
          rowsSkipped: plan.rowsSkipped,
          rowsFailed: plan.rowsFailed,
          stoppedBusy: plan.sqliteBusy !== undefined,
          eventsAffected: plan.affectedEventIds.length,
          mirrorFilesRedacted,
          mirrorFilesFailed,
          vectorDeleteFailures: vectorDeleteFailures.length,
          requeueFailures: requeueFailures.length
        }
      })).immediate();
    } catch (error) {
      plan.summaryAuditError = messageOf(error);
    }
  }

  const references = vectorDeleteFailures.map((eventId) => eventReference(db, eventId));
  plan.vectorDeleteFailures = references.map(({ ref }) => ref);
  plan.vectorDeleteFailuresHidden = references.filter(({ hidden }) => hidden).length;
  plan.requeueFailures = requeueFailures;
  if (references.length > 0) {
    const file = path.join(storagePath, `redact-credentials-${runId}-vector-delete-failures.txt`);
    try {
      fs.writeFileSync(file, `${plan.vectorDeleteFailures.join('\n')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      plan.vectorDeleteFailuresFile = file;
    } catch {
      // The output then lists every entry instead.
    }
  }
  return plan;
}

/** Each way an apply can stop short, worded for the person who ran it. */
function unfinishedRedaction(plan: CredentialRedactionPlan): string[] {
  const notes: string[] = [];
  const failedFiles = plan.fileChanges.filter((change) => change.writeFailed);

  if (plan.sqliteBusy !== undefined) {
    notes.push(
      `SQLite stayed busy (${plan.sqliteBusy}), so the run stopped after ${plan.batchesCommitted ?? 0} ` +
      'committed batch(es); values it had not reached still hold their credentials. Re-run with --apply.'
    );
  }
  if ((plan.rowsFailed ?? 0) > 0) {
    notes.push(
      `${plan.rowsFailed} SQLite value(s) could not be updated (${plan.rowError}) and still hold the ` +
      'credential; the run went on with the rest. Re-run with --apply.'
    );
  }
  if ((plan.rowsSkipped ?? 0) > 0) {
    notes.push(
      `${plan.rowsSkipped} SQLite value(s) changed or were deleted after the scan read them and were left as ` +
      'they are, so they may still hold a credential. Re-run with --apply to redact them.'
    );
  }
  if (failedFiles.length > 0) {
    notes.push(
      `${failedFiles.length} Markdown file(s) could not be rewritten and still hold the credential; ` +
      'fix their permissions or free disk space, then re-run with --apply:'
    );
    for (const change of failedFiles.slice(0, 10)) notes.push(`    ${change.filePath}`);
    if (failedFiles.length > 10) notes.push(`    … and ${failedFiles.length - 10} more`);
  }
  const vectorFailures = plan.vectorDeleteFailures ?? [];
  if (vectorFailures.length > 0) {
    notes.push(
      `The old vectors of ${vectorFailures.length} event(s) could not be deleted and may still hold the ` +
      'credential. The events themselves are redacted, so a re-run of this command does not retry the delete. ' +
      (plan.vectorDeleteFailuresFile
        ? `Every event is listed in ${plan.vectorDeleteFailuresFile}`
        : 'The events:')
    );
    if (!plan.vectorDeleteFailuresFile) {
      for (const ref of vectorFailures) notes.push(`    ${ref}`);
    }
    if ((plan.vectorDeleteFailuresHidden ?? 0) > 0) {
      notes.push(
        `${plan.vectorDeleteFailuresHidden} of those event ids look like they hold a credential, so they are ` +
        'given as `events rowid <n>`; read such an id with `SELECT id FROM events WHERE rowid = <n>` before the ' +
        'next VACUUM (`forget` runs one) renumbers the rows.'
      );
    }
  }
  const requeueFailures = plan.requeueFailures ?? [];
  if (requeueFailures.length > 0) {
    notes.push(
      `${requeueFailures.length} redacted event(s) could not be queued for re-embedding ` +
      `(${plan.requeueError}), so they may have no vector now. Run \`repair backfill-vectors --apply\` to queue them.`
    );
  }
  if (plan.summaryAuditError !== undefined) {
    notes.push(
      `The run's closing audit row could not be written (${plan.summaryAuditError}). The batch audit rows are ` +
      'there; the run totals and the Markdown counts are only in this output.'
    );
  }
  return notes;
}

/** 1 whenever an apply left something undone, so scripts cannot read it as clean. */
export function credentialRedactionExitCode(plan: CredentialRedactionPlan): number {
  return unfinishedRedaction(plan).length > 0 ? 1 : 0;
}

export function formatRedactionPlan(plan: CredentialRedactionPlan): string {
  const lines: string[] = [];
  const mode = plan.dryRun ? 'DRY RUN — nothing was modified' : 'APPLIED';
  lines.push(`Credential redaction: ${mode}`);
  lines.push('');
  lines.push(`SQLite values to redact : ${plan.rowChanges.length}`);
  lines.push(`Markdown files to redact: ${plan.fileChanges.length}`);
  lines.push(`Events needing re-embed : ${plan.affectedEventIds.length}`);
  if (!plan.dryRun) {
    lines.push(`Changed since the scan  : ${plan.rowsSkipped ?? 0}`);
    lines.push(`Vectors deleted         : ${plan.vectorsDeleted}`);
    lines.push(`Embeddings re-queued    : ${plan.embeddingsRequeued}`);
    lines.push(`Batches committed       : ${plan.batchesCommitted ?? 0}`);
    lines.push(`Longest committed batch : ${Math.round(plan.longestBatchLockMs ?? 0)} ms holding the write lock`);
    if (plan.runId) lines.push(`Audit run id            : ${plan.runId}`);
  }

  if (plan.rowChanges.length > 0) {
    lines.push('', 'Rows (previews already redacted):');
    const byTable = new Map<string, number>();
    for (const change of plan.rowChanges) {
      byTable.set(`${change.table}.${change.column}`, (byTable.get(`${change.table}.${change.column}`) ?? 0) + 1);
    }
    for (const [key, count] of Array.from(byTable.entries()).sort()) {
      lines.push(`  ${key}: ${count}`);
    }
    for (const change of plan.rowChanges.slice(0, 5)) {
      const row = change.rowRef === change.rowId ? change.rowId.slice(0, 8) : change.rowRef;
      lines.push(`  - ${change.table}.${change.column} [${row}] ${change.preview}`);
    }
    if (plan.rowChanges.length > 5) lines.push(`  … and ${plan.rowChanges.length - 5} more`);
  }

  if (plan.fileChanges.length > 0) {
    lines.push('', 'Markdown files:');
    for (const change of plan.fileChanges.slice(0, 10)) {
      lines.push(`  - ${change.filePath}${change.writeFailed ? ' (write failed)' : ''}`);
    }
    if (plan.fileChanges.length > 10) lines.push(`  … and ${plan.fileChanges.length - 10} more`);
  }

  if (plan.dryRun && (plan.rowChanges.length > 0 || plan.fileChanges.length > 0)) {
    lines.push('', 'Re-run with --apply to write these changes.');
  }
  const unfinished = unfinishedRedaction(plan);
  if (unfinished.length > 0) {
    lines.push('', 'NOT FINISHED — credentials may remain:');
    for (const note of unfinished) lines.push(note.startsWith('    ') ? note : `  - ${note}`);
  }
  lines.push(
    '',
    'Redacting local copies does not un-expose a credential: rotate anything found here.'
  );
  return lines.join('\n');
}
