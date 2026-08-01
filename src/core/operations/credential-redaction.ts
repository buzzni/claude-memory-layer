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

import * as fs from 'fs';
import * as path from 'path';

import { sqliteAll, sqliteRun, type SQLiteDatabase } from '../sqlite-wrapper.js';
import { applyPrivacyFilter } from '../privacy/filter.js';
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
}

export interface RedactionFileChange {
  filePath: string;
  occurrences: number;
}

export interface CredentialRedactionPlan {
  dryRun: boolean;
  rowChanges: RedactionRowChange[];
  fileChanges: RedactionFileChange[];
  /** Event ids whose vectors must be rebuilt from the redacted text. */
  affectedEventIds: string[];
  vectorsDeleted: number;
  embeddingsRequeued: number;
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

/**
 * Scan SQLite for values the privacy filter would change, and optionally write
 * the redacted form back.
 */
export function planSqliteRedaction(
  db: SQLiteDatabase,
  options: { apply: boolean }
): { rowChanges: RedactionRowChange[]; affectedEventIds: string[] } {
  const rowChanges: RedactionRowChange[] = [];
  const affectedEventIds = new Set<string>();

  for (const target of SQLITE_TARGETS) {
    if (!tableExists(db, target.table)) continue;
    for (const column of target.columns) {
      if (!columnExists(db, target.table, column)) continue;

      const rows = sqliteAll<Record<string, unknown>>(
        db,
        `SELECT ${target.idColumn} AS row_id, ${column} AS value
         FROM ${target.table}
         WHERE ${column} IS NOT NULL AND ${column} <> ''`
      );

      for (const row of rows) {
        const value = typeof row.value === 'string' ? row.value : null;
        const rowId = row.row_id === null || row.row_id === undefined ? null : String(row.row_id);
        if (!value || !rowId) continue;

        const redacted = redactText(value);
        if (redacted === value) continue;

        rowChanges.push({
          table: target.table,
          rowId,
          column,
          preview: previewOf(redacted)
        });
        if (target.table === 'events') affectedEventIds.add(rowId);

        if (options.apply) {
          sqliteRun(
            db,
            `UPDATE ${target.table} SET ${column} = ? WHERE ${target.idColumn} = ?`,
            [redacted, rowId]
          );
        }
      }
    }
  }

  return { rowChanges, affectedEventIds: Array.from(affectedEventIds) };
}

function walkMarkdown(dir: string, found: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, found);
    else if (entry.isFile() && entry.name.endsWith('.md')) found.push(full);
  }
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
  walkMarkdown(memoryRoot, files);

  const changes: RedactionFileChange[] = [];
  for (const filePath of files) {
    let original: string;
    try {
      original = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const redacted = redactText(original);
    if (redacted === original) continue;

    const occurrences = redacted.split('[REDACTED]').length - original.split('[REDACTED]').length;
    changes.push({ filePath, occurrences: Math.max(1, occurrences) });
    if (options.apply) {
      try {
        fs.writeFileSync(filePath, redacted, 'utf8');
      } catch {
        // Reported as a planned change; a write failure must not abort the rest.
      }
    }
  }
  return changes;
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

    sqliteRun(db, `DELETE FROM embedding_outbox WHERE event_id = ?`, [eventId]);
    sqliteRun(
      db,
      `INSERT INTO embedding_outbox (id, event_id, content, status, retry_count, created_at)
       VALUES (?, ?, ?, 'pending', 0, datetime('now'))`,
      [`redact-${eventId}`, eventId, content]
    );
  }
  return queued;
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
    lines.push(`Vectors deleted         : ${plan.vectorsDeleted}`);
    lines.push(`Embeddings re-queued    : ${plan.embeddingsRequeued}`);
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
      lines.push(`  - ${change.table}.${change.column} [${change.rowId.slice(0, 8)}] ${change.preview}`);
    }
    if (plan.rowChanges.length > 5) lines.push(`  … and ${plan.rowChanges.length - 5} more`);
  }

  if (plan.fileChanges.length > 0) {
    lines.push('', 'Markdown files:');
    for (const change of plan.fileChanges.slice(0, 10)) {
      lines.push(`  - ${change.filePath}`);
    }
    if (plan.fileChanges.length > 10) lines.push(`  … and ${plan.fileChanges.length - 10} more`);
  }

  if (plan.dryRun && (plan.rowChanges.length > 0 || plan.fileChanges.length > 0)) {
    lines.push('', 'Re-run with --apply to write these changes.');
  }
  lines.push(
    '',
    'Redacting local copies does not un-expose a credential: rotate anything found here.'
  );
  return lines.join('\n');
}
