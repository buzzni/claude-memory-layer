import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import {
  applyCredentialRedaction,
  credentialRedactionExitCode,
  formatRedactionPlan,
  planSqliteRedaction,
  REDACTION_BATCH_SIZE
} from '../../src/core/operations/credential-redaction.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteAll } from '../../src/core/sqlite-wrapper.js';

const roots: string[] = [];
const stores: SQLiteEventStore[] = [];
const connections: Database.Database[] = [];

afterEach(async () => {
  for (const db of connections.splice(0)) db.close();
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SECRET = 'api_key=sk-live-1234567890abcdef';
const leakedText = (n: number) => `call ${n} with ${SECRET}`;

async function openStore(): Promise<{ store: SQLiteEventStore; storagePath: string }> {
  const storagePath = mkdtempSync(path.join(tmpdir(), 'cml-redact-audit-'));
  roots.push(storagePath);
  const store = new SQLiteEventStore(path.join(storagePath, 'events.sqlite'));
  await store.initialize();
  stores.push(store);
  return { store, storagePath };
}

let tick = Date.parse('2026-01-01T00:00:00.000Z');
async function leakEvents(store: SQLiteEventStore, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let n = 1; n <= count; n++) {
    const { eventId } = await store.append({
      eventType: 'user_prompt', sessionId: 's1', timestamp: new Date(tick++), content: `placeholder ${tick}`
    });
    // Rows written before the ingest-side filter existed still hold the raw secret.
    store.getDatabase().prepare('UPDATE events SET content = ? WHERE id = ?').run(leakedText(n), eventId);
    ids.push(eventId!);
  }
  return ids;
}

async function seededStore(): Promise<{ store: SQLiteEventStore; storagePath: string; leakedId: string }> {
  const { store, storagePath } = await openStore();
  const [leakedId] = await leakEvents(store, 1);
  return { store, storagePath, leakedId };
}

function writeMirrorFile(storagePath: string): string {
  const dir = path.join(storagePath, 'memory', 'default', 'user_prompt');
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, '2026-01-01.md');
  writeFileSync(filePath, `## 00:00\n${leakedText(0)}\n`, 'utf8');
  return filePath;
}

interface AuditRow { after: Record<string, unknown>; sourceEventIds: string[]; raw: Record<string, string> }

function auditRows(store: SQLiteEventStore): AuditRow[] {
  return sqliteAll<Record<string, string>>(
    store.getDatabase(),
    `SELECT * FROM memory_governance_audit WHERE operation = 'credential_redact' ORDER BY created_at, rowid`
  ).map((raw) => ({ after: JSON.parse(raw.after_json), sourceEventIds: JSON.parse(raw.source_event_ids), raw }));
}

const batchRows = (store: SQLiteEventStore) => auditRows(store).filter((row) => row.after.summary !== true);
const summaryRows = (store: SQLiteEventStore) => auditRows(store).filter((row) => row.after.summary === true);

function contentOf(store: SQLiteEventStore, eventId: string): string {
  return sqliteAll<{ content: string }>(store.getDatabase(), 'SELECT content FROM events WHERE id = ?', [eventId])[0].content;
}

function plaintextEvents(store: SQLiteEventStore): number {
  return sqliteAll<{ n: number }>(store.getDatabase(), `SELECT COUNT(*) AS n FROM events WHERE content LIKE '%sk-live%'`)[0].n;
}

/** An embedding job queued before the redaction, carrying its own copy of the text. */
function queuePlaintextJob(store: SQLiteEventStore, eventId: string, content: string): void {
  store.getDatabase().prepare(
    `INSERT INTO embedding_outbox (id, event_id, content, status, retry_count) VALUES (?, ?, ?, 'pending', 0)`
  ).run(`job-${eventId}`, eventId, content);
}

function outboxRows(store: SQLiteEventStore, eventId: string): Array<{ id: string; content: string }> {
  return sqliteAll(store.getDatabase(), 'SELECT id, content FROM embedding_outbox WHERE event_id = ?', [eventId]);
}

/** A real write failure, raised by a temp trigger. */
function failWrites(store: SQLiteEventStore, name: string, on: string, raise: 'ABORT' | 'ROLLBACK' = 'ABORT', when = '1'): void {
  store.getDatabase().exec(
    `CREATE TEMP TRIGGER ${name} BEFORE ${on} WHEN ${when} BEGIN SELECT RAISE(${raise}, '${name}'); END`
  );
}

const vectorCalls: string[][] = [];
const deleteEventVectors = async (eventIds: string[]): Promise<void> => { vectorCalls.push(eventIds); };
afterEach(() => { vectorCalls.length = 0; });

const apply = (store: SQLiteEventStore, storagePath: string, options: { batchSize?: number } = {}) =>
  applyCredentialRedaction(store.getDatabase(), storagePath, { actor: 'cli', deleteEventVectors, ...options });

describe('repair redact-credentials governance audit', () => {
  it('writes a batch row and a closing row with counts and event ids, never the secret or a preview', async () => {
    const { store, storagePath, leakedId } = await seededStore();
    writeMirrorFile(storagePath);

    const plan = await apply(store, storagePath);

    expect(contentOf(store, leakedId)).not.toContain('sk-live');
    const [batch] = batchRows(store);
    const [summary] = summaryRows(store);
    expect(auditRows(store)).toHaveLength(2);
    expect(batch.raw).toMatchObject({ operation: 'credential_redact', actor: 'cli', target_type: 'store', target_id: 'redact-credentials' });
    expect(batch.after).toEqual({
      runId: plan.runId, batch: 1, rowsRedacted: 1, rowsByColumn: { 'events.content': 1 }, rowsSkipped: 0, eventsAffected: 1
    });
    expect(batch.sourceEventIds).toEqual([leakedId]);
    expect(summary.after).toEqual({
      runId: plan.runId, summary: true, batches: 1, rowsRedacted: 1, rowsSkipped: 0, rowsFailed: 0, stoppedBusy: false,
      eventsAffected: 1, mirrorFilesRedacted: 1, mirrorFilesFailed: 0, vectorDeleteFailures: 0, requeueFailures: 0
    });
    expect(summary.sourceEventIds).toEqual([]);
    const stored = JSON.stringify(auditRows(store).map((row) => row.raw));
    expect(stored).not.toContain('sk-live');
    // The redacted text around the secret, which the CLI prints as a preview, stays out too.
    expect(stored).not.toContain('with [REDACTED]');
    expect(stored).not.toContain(plan.rowChanges[0].preview);
  });

  it('commits in batches of the given size, each with its own audit row under one run id', async () => {
    const { store, storagePath } = await openStore();
    const ids = await leakEvents(store, 5);

    const plan = await apply(store, storagePath, { batchSize: 2 });

    expect(plaintextEvents(store)).toBe(0);
    const batches = batchRows(store);
    expect(batches.map((row) => [row.after.batch, row.after.rowsRedacted])).toEqual([[1, 2], [2, 2], [3, 1]]);
    expect(new Set(auditRows(store).map((row) => row.after.runId))).toEqual(new Set([plan.runId]));
    expect(batches.flatMap((row) => row.sourceEventIds)).toEqual(ids);
    expect(Math.max(...batches.map((row) => row.sourceEventIds.length))).toBe(2);
    expect(summaryRows(store)[0].after).toMatchObject({ batches: 3, rowsRedacted: 5 });
    // Each batch's vectors are deleted right after it commits.
    expect(vectorCalls).toEqual([ids.slice(0, 2), ids.slice(2, 4), ids.slice(4)]);
    expect(plan).toMatchObject({ batchesCommitted: 3, vectorsDeleted: 5, embeddingsRequeued: 5 });
    expect(credentialRedactionExitCode(plan)).toBe(0);
  });

  it('dry-run and a clean store write nothing', async () => {
    const { store, storagePath, leakedId } = await seededStore();

    planSqliteRedaction(store.getDatabase());
    expect(auditRows(store)).toEqual([]);
    expect(contentOf(store, leakedId)).toBe(leakedText(1));

    await apply(store, storagePath);
    const second = await apply(store, storagePath);
    // The second apply finds nothing left to redact, so only the first left rows.
    expect(auditRows(store)).toHaveLength(2);
    expect(credentialRedactionExitCode(second)).toBe(0);
  });

  it('writes only a closing row for mirror-only changes', async () => {
    const { store, storagePath } = await openStore();
    writeMirrorFile(storagePath);

    await apply(store, storagePath);

    expect(batchRows(store)).toEqual([]);
    expect(summaryRows(store)[0].after).toMatchObject({ batches: 0, rowsRedacted: 0, mirrorFilesRedacted: 1 });
  });
});

describe('applyCredentialRedaction failures', () => {
  it('redacts the mirror and SQLite, deletes the old vectors and re-queues the events', async () => {
    const { store, storagePath, leakedId } = await seededStore();
    const mirrorFile = writeMirrorFile(storagePath);

    const plan = await apply(store, storagePath);

    expect(readFileSync(mirrorFile, 'utf8')).not.toContain('sk-live');
    expect(outboxRows(store, leakedId)).toEqual([{ id: `redact-${leakedId}`, content: contentOf(store, leakedId) }]);
    expect(plan).toMatchObject({ vectorsDeleted: 1, embeddingsRequeued: 1, rowsSkipped: 0, rowsFailed: 0 });
    const output = formatRedactionPlan(plan);
    expect(output).not.toContain('NOT FINISHED');
    expect(output).not.toContain('sk-live');
  });

  // #228 review: with the whole apply in one transaction, a failing helpfulness update took back
  // both event redactions that main's row-at-a-time commits keep.
  it.each(['ABORT', 'ROLLBACK'] as const)(
    'keeps the event redactions when a later helpfulness update fails (RAISE %s)',
    async (raise) => {
      const { store, storagePath } = await openStore();
      const [first] = await leakEvents(store, 2);
      store.getDatabase().prepare(
        `INSERT INTO memory_helpfulness (id, event_id, session_id, query_preview) VALUES ('h1', ?, 's1', ?)`
      ).run(first, leakedText(3));
      failWrites(store, 'helpfulness_down', 'UPDATE ON main.memory_helpfulness', raise);

      const plan = await apply(store, storagePath);

      expect(plaintextEvents(store)).toBe(0);
      expect(sqliteAll(store.getDatabase(), 'SELECT query_preview FROM memory_helpfulness')).toEqual([{ query_preview: leakedText(3) }]);
      expect(plan).toMatchObject({ rowsFailed: 1, rowError: 'helpfulness_down', affectedEventIds: expect.any(Array) });
      expect(plan.affectedEventIds).toHaveLength(2);
      // The batch was retried row by row, so each event committed with its own audit row.
      expect(batchRows(store).map((row) => row.after.rowsRedacted)).toEqual([1, 1]);
      expect(credentialRedactionExitCode(plan)).toBe(1);
      expect(formatRedactionPlan(plan)).toContain('1 SQLite value(s) could not be updated (helpfulness_down)');
    }
  );

  it('keeps the batches committed before a later batch fails on its audit row', async () => {
    const { store, storagePath } = await openStore();
    const ids = await leakEvents(store, 4);
    failWrites(store, 'audit_down', 'INSERT ON main.memory_governance_audit', 'ABORT', `json_extract(NEW.after_json, '$.batch') = 2`);

    const plan = await apply(store, storagePath, { batchSize: 2 });

    expect(ids.map((id) => contentOf(store, id).includes('sk-live'))).toEqual([false, false, true, true]);
    expect(batchRows(store).map((row) => row.sourceEventIds)).toEqual([ids.slice(0, 2)]);
    expect(plan).toMatchObject({ batchesCommitted: 1, rowsFailed: 2, rowError: 'audit_down' });
    expect(vectorCalls).toEqual([ids.slice(0, 2)]);
    expect(credentialRedactionExitCode(plan)).toBe(1);
  });

  it('leaves every row unredacted and unaudited when no audit row can be written', async () => {
    const { store, storagePath } = await openStore();
    await leakEvents(store, 2);
    failWrites(store, 'audit_down', 'INSERT ON main.memory_governance_audit');

    const plan = await apply(store, storagePath);

    expect(plaintextEvents(store)).toBe(2);
    expect(auditRows(store)).toEqual([]);
    expect(vectorCalls).toEqual([]);
    expect(plan).toMatchObject({ batchesCommitted: 0, rowsFailed: 2 });
    expect(credentialRedactionExitCode(plan)).toBe(1);
  });

  it('stops the SQLite pass while the database stays busy, and still redacts the mirror', async () => {
    const { store, storagePath } = await openStore();
    await leakEvents(store, 2);
    const mirrorFile = writeMirrorFile(storagePath);
    const other = new Database(path.join(storagePath, 'events.sqlite'));
    connections.push(other);
    other.exec('BEGIN IMMEDIATE');
    store.getDatabase().pragma('busy_timeout = 20');

    const plan = await apply(store, storagePath);
    other.exec('ROLLBACK');

    expect(plan.sqliteBusy).toBeDefined();
    expect(plan.rowsFailed).toBe(0);
    expect(plaintextEvents(store)).toBe(2);
    expect(readFileSync(mirrorFile, 'utf8')).not.toContain('sk-live');
    expect(credentialRedactionExitCode(plan)).toBe(1);
    expect(formatRedactionPlan(plan)).toContain('SQLite stayed busy');
  });

  it('reports mirror files it could not rewrite', async () => {
    if (process.getuid?.() === 0) return; // root ignores the read-only mode
    const { store, storagePath, leakedId } = await seededStore();
    const mirrorFile = writeMirrorFile(storagePath);
    chmodSync(mirrorFile, 0o444);

    const plan = await apply(store, storagePath);

    expect(readFileSync(mirrorFile, 'utf8')).toContain('sk-live');
    expect(contentOf(store, leakedId)).not.toContain('sk-live');
    expect(plan.fileChanges).toEqual([expect.objectContaining({ filePath: mirrorFile, writeFailed: true })]);
    expect(summaryRows(store)[0].after).toMatchObject({ mirrorFilesRedacted: 0, mirrorFilesFailed: 1 });
    expect(credentialRedactionExitCode(plan)).toBe(1);
    expect(formatRedactionPlan(plan)).toContain('1 Markdown file(s) could not be rewritten');
  });

  it('reports an old mirror file a replacement left that it cannot finish', async () => {
    if (process.getuid?.() === 0) return; // root ignores the read-only mode
    const { store, storagePath } = await seededStore();
    const mirrorFile = writeMirrorFile(storagePath);
    const keptFile = `${mirrorFile}.0b5e6f7a-1c2d-4e3f-8a9b-0c1d2e3f4a5b.old`;
    writeFileSync(keptFile, `## 00:00\n${leakedText(1)}\n`, 'utf8');
    chmodSync(mirrorFile, 0o444); // so the old file's entries cannot be added to it

    const plan = await apply(store, storagePath);

    expect(readFileSync(keptFile, 'utf8')).toContain('sk-live');
    expect(plan.fileChanges).toContainEqual(expect.objectContaining({ filePath: keptFile, writeFailed: true }));
    expect(credentialRedactionExitCode(plan)).toBe(1);
    const output = formatRedactionPlan(plan);
    expect(output.slice(output.indexOf('NOT FINISHED'))).toContain(keptFile);
  });

  it('lists every event whose old vectors could not be deleted in a file, and still re-queues them', async () => {
    const { store, storagePath } = await openStore();
    const ids = await leakEvents(store, 7);

    const plan = await applyCredentialRedaction(store.getDatabase(), storagePath, {
      actor: 'cli',
      batchSize: 3,
      deleteEventVectors: async () => { throw new Error('vector store is locked'); }
    });

    expect(plaintextEvents(store)).toBe(0);
    expect(plan).toMatchObject({ vectorsDeleted: 0, vectorDeleteFailures: ids, vectorDeleteFailuresHidden: 0, embeddingsRequeued: 7 });
    expect(readFileSync(plan.vectorDeleteFailuresFile!, 'utf8').trim().split('\n')).toEqual(ids);
    expect(statSync(plan.vectorDeleteFailuresFile!).mode & 0o777).toBe(0o600);
    expect(summaryRows(store)[0].after).toMatchObject({ vectorDeleteFailures: 7 });
    expect(credentialRedactionExitCode(plan)).toBe(1);
    const output = formatRedactionPlan(plan);
    expect(output).toContain(`Every event is listed in ${plan.vectorDeleteFailuresFile}`);
    expect(output).not.toContain('still queued');
  });

  it('names an imported event whose id holds a credential by its rowid, never by the id', async () => {
    const { store, storagePath } = await openStore();
    const leakyId = `imported-${SECRET}`;
    await store.importEvents([{
      id: leakyId, eventType: 'user_prompt', sessionId: 's1', timestamp: new Date(tick++),
      content: leakedText(1), canonicalKey: 'imported', dedupeKey: 'imported'
    }]);
    const [plainId] = await leakEvents(store, 1);
    const rowid = sqliteAll<{ rowid: number }>(store.getDatabase(), 'SELECT rowid FROM events WHERE id = ?', [leakyId])[0].rowid;
    const failVectors = { actor: 'cli', deleteEventVectors: async () => { throw new Error('vector store is locked'); } };

    const plan = await applyCredentialRedaction(store.getDatabase(), storagePath, failVectors);

    expect(plan).toMatchObject({ vectorDeleteFailures: [`events rowid ${rowid}`, plainId], vectorDeleteFailuresHidden: 1 });
    expect(readFileSync(plan.vectorDeleteFailuresFile!, 'utf8')).toBe(`events rowid ${rowid}\n${plainId}\n`);
    const output = formatRedactionPlan(plan);
    expect(output).not.toContain('sk-live');
    expect(output).toContain('1 of those event ids look like they hold a credential');
    expect(output).toContain('SELECT id FROM events WHERE rowid = <n>');
    expect(sqliteAll(store.getDatabase(), 'SELECT id FROM events WHERE rowid = ?', [rowid])).toEqual([{ id: leakyId }]);
  });

  // Built at run time so no complete token sits in the source. Each is a shape the privacy filter knows;
  // the audit sanitizer alone does not catch all of them (`ghp_…` among others).
  const TOKEN_SHAPES: Array<[string, string]> = [
    ['api_key assignment', `api_key=sk-live-${'1'.repeat(16)}`],
    ['GitHub token', `ghp_${'a'.repeat(36)}`],
    ['OpenAI key', `sk-${'b'.repeat(48)}`],
    ['Anthropic key', `sk-ant-${'c'.repeat(24)}`],
    ['AWS access key id', `AKIA${'ABCDEFGHIJKLMNOP'}`],
    ['Slack token', `xoxb-${'1'.repeat(12)}`],
    ['GitLab token', `glpat-${'d'.repeat(20)}`],
    ['Hugging Face token', `hf_${'e'.repeat(32)}`]
  ];

  it.each(TOKEN_SHAPES)('keeps an imported event id holding a credential (%s) out of the file, the output, the preview and the audit', async (_shape, token) => {
    const { store, storagePath } = await openStore();
    const leakyId = `evt-${token}`;
    await store.importEvents([{
      id: leakyId, eventType: 'user_prompt', sessionId: 's1', timestamp: new Date(tick++),
      content: leakedText(1), canonicalKey: 'imported', dedupeKey: 'imported'
    }]);
    const rowid = sqliteAll<{ rowid: number }>(store.getDatabase(), 'SELECT rowid FROM events WHERE id = ?', [leakyId])[0].rowid;
    const ref = `events rowid ${rowid}`;

    const { rowChanges, affectedEventIds } = planSqliteRedaction(store.getDatabase());
    const preview = formatRedactionPlan({
      dryRun: true, rowChanges, fileChanges: [], affectedEventIds, vectorsDeleted: 0, embeddingsRequeued: 0
    });
    const plan = await applyCredentialRedaction(store.getDatabase(), storagePath, {
      actor: 'cli', deleteEventVectors: async () => { throw new Error('vector store is locked'); }
    });
    const audit = JSON.stringify(sqliteAll(store.getDatabase(), 'SELECT * FROM memory_governance_audit'));

    expect(plan).toMatchObject({ vectorDeleteFailures: [ref], vectorDeleteFailuresHidden: 1 });
    expect(batchRows(store)[0].sourceEventIds).toEqual([ref]);
    const places = {
      file: readFileSync(plan.vectorDeleteFailuresFile!, 'utf8'),
      output: formatRedactionPlan(plan),
      preview,
      audit
    };
    for (const [place, text] of Object.entries(places)) {
      expect({ place, leaks: text.includes(token) }).toEqual({ place, leaks: false });
    }
    expect(places.file).toBe(`${ref}\n`);
    expect(places.preview).toContain(`[${ref}]`);
  });

  it('names a credential-holding row id by its rowid in the dry-run and apply previews', async () => {
    const { store, storagePath } = await openStore();
    // Starts with the secret, so even the 8-character prefix the preview shows would leak it.
    const leakyId = `${SECRET}-imported`;
    await store.importEvents([{
      id: leakyId, eventType: 'user_prompt', sessionId: 's1', timestamp: new Date(tick++),
      content: leakedText(1), canonicalKey: 'imported', dedupeKey: 'imported'
    }]);
    const [plainId] = await leakEvents(store, 1);
    const rowid = sqliteAll<{ rowid: number }>(store.getDatabase(), 'SELECT rowid FROM events WHERE id = ?', [leakyId])[0].rowid;

    const { rowChanges, affectedEventIds } = planSqliteRedaction(store.getDatabase());
    const dryRun = formatRedactionPlan({
      dryRun: true, rowChanges, fileChanges: [], affectedEventIds, vectorsDeleted: 0, embeddingsRequeued: 0
    });
    const applied = formatRedactionPlan(await apply(store, storagePath));

    for (const output of [dryRun, applied]) {
      expect(output).toContain(`[events rowid ${rowid}]`);
      expect(output).toContain(`[${plainId.slice(0, 8)}]`);
      expect(output).not.toContain('api_key');
      expect(output).not.toContain('sk-live');
    }
  });

  it('prints the failed events, never a credential-holding id, when the failure file cannot be written', async () => {
    if (process.getuid?.() === 0) return; // root ignores the read-only mode
    const { store, storagePath } = await openStore();
    await store.importEvents([{
      id: `imported-${SECRET}`, eventType: 'user_prompt', sessionId: 's1', timestamp: new Date(tick++),
      content: leakedText(1), canonicalKey: 'imported', dedupeKey: 'imported'
    }]);
    chmodSync(storagePath, 0o555);
    try {
      const plan = await applyCredentialRedaction(store.getDatabase(), storagePath, {
        actor: 'cli', deleteEventVectors: async () => { throw new Error('vector store is locked'); }
      });

      expect(plan.vectorDeleteFailuresFile).toBeUndefined();
      const output = formatRedactionPlan(plan);
      expect(output).toMatch(/The events:\n {4}events rowid \d+/);
      expect(output).not.toContain('sk-live');
    } finally {
      chmodSync(storagePath, 0o700);
    }
  });

  it('drops a queued job holding the old text with the update, so a failed re-queue cannot leave it', async () => {
    const { store, storagePath, leakedId } = await seededStore();
    queuePlaintextJob(store, leakedId, leakedText(1));
    failWrites(store, 'outbox_down', 'INSERT ON main.embedding_outbox');

    const plan = await apply(store, storagePath);

    expect(contentOf(store, leakedId)).not.toContain('sk-live');
    expect(outboxRows(store, leakedId)).toEqual([]);
    expect(plan).toMatchObject({ requeueFailures: [leakedId], requeueError: 'outbox_down' });
    expect(credentialRedactionExitCode(plan)).toBe(1);
  });

  // Accepted (#228 review): the value is redacted only together with the removal of its queued jobs.
  it('leaves a value unredacted, and says so, when its queued jobs cannot be removed', async () => {
    const { store, storagePath, leakedId } = await seededStore();
    queuePlaintextJob(store, leakedId, leakedText(1));
    failWrites(store, 'queue_delete_down', 'DELETE ON main.embedding_outbox');

    const plan = await apply(store, storagePath);

    expect(contentOf(store, leakedId)).toBe(leakedText(1));
    expect(outboxRows(store, leakedId)).toEqual([{ id: `job-${leakedId}`, content: leakedText(1) }]);
    expect(plan).toMatchObject({ batchesCommitted: 0, rowsFailed: 1, rowError: 'queue_delete_down' });
    expect(credentialRedactionExitCode(plan)).toBe(1);
  });

  it('keeps the queued job when its batch rolls back', async () => {
    const { store, storagePath, leakedId } = await seededStore();
    queuePlaintextJob(store, leakedId, leakedText(1));
    failWrites(store, 'audit_down', 'INSERT ON main.memory_governance_audit');

    await apply(store, storagePath);

    // The event keeps its text too, so the job is no worse than the row; the next run drops both.
    expect(contentOf(store, leakedId)).toBe(leakedText(1));
    expect(outboxRows(store, leakedId)).toEqual([{ id: `job-${leakedId}`, content: leakedText(1) }]);
  });

  it('stops the SQLite pass when a re-queue finds the store busy', async () => {
    const { store, storagePath } = await openStore();
    const [first, second] = await leakEvents(store, 2);
    const other = new Database(path.join(storagePath, 'events.sqlite'));
    connections.push(other);
    store.getDatabase().pragma('busy_timeout = 20');

    const plan = await applyCredentialRedaction(store.getDatabase(), storagePath, {
      actor: 'cli',
      batchSize: 1,
      // Another writer takes the lock between the first batch's commit and its re-queue.
      deleteEventVectors: async () => { if (!other.inTransaction) other.exec('BEGIN IMMEDIATE'); }
    });
    other.exec('ROLLBACK');

    expect(contentOf(store, first)).not.toContain('sk-live');
    expect(contentOf(store, second)).toBe(leakedText(2));
    expect(plan.sqliteBusy).toBeDefined();
    expect(plan).toMatchObject({ batchesCommitted: 1, requeueFailures: [first] });
    expect(credentialRedactionExitCode(plan)).toBe(1);
  });

  it('refuses a batch size outside 1 to REDACTION_BATCH_SIZE', async () => {
    const { store, storagePath } = await seededStore();

    for (const batchSize of [0, 1.5, REDACTION_BATCH_SIZE + 1]) {
      await expect(apply(store, storagePath, { batchSize })).rejects.toThrow(RangeError);
    }
    expect(auditRows(store)).toEqual([]);
  });

  it('reports events it could not re-queue with the command that queues them', async () => {
    const { store, storagePath, leakedId } = await seededStore();
    failWrites(store, 'outbox_down', 'INSERT ON main.embedding_outbox');

    const plan = await apply(store, storagePath);

    expect(contentOf(store, leakedId)).not.toContain('sk-live');
    expect(plan).toMatchObject({ requeueFailures: [leakedId], requeueError: 'outbox_down', embeddingsRequeued: 0 });
    expect(credentialRedactionExitCode(plan)).toBe(1);
    expect(formatRedactionPlan(plan)).toContain('repair backfill-vectors --apply');
  });

  it('reports a closing audit row it could not write', async () => {
    const { store, storagePath } = await seededStore();
    failWrites(store, 'summary_down', 'INSERT ON main.memory_governance_audit', 'ABORT', `json_extract(NEW.after_json, '$.summary') = 1`);

    const plan = await apply(store, storagePath);

    expect(batchRows(store)).toHaveLength(1);
    expect(plan.summaryAuditError).toBe('summary_down');
    expect(credentialRedactionExitCode(plan)).toBe(1);
  });

  it('reports rows skipped by the guard with a re-run hint', () => {
    const plan = {
      dryRun: false, rowChanges: [], fileChanges: [], affectedEventIds: [],
      vectorsDeleted: 0, embeddingsRequeued: 0, rowsSkipped: 2
    };

    expect(credentialRedactionExitCode(plan)).toBe(1);
    expect(formatRedactionPlan(plan)).toContain('2 SQLite value(s) changed or were deleted after the scan read them');
    expect(formatRedactionPlan(plan)).toContain('Re-run with --apply to redact them');
  });
});
