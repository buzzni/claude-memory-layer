import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';
import { tmpdir } from 'os';
import { Worker } from 'worker_threads';

import Database from 'better-sqlite3';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteAll } from '../../src/core/sqlite-wrapper.js';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cml-summary-supersede-'));
  tempDirs.push(dir);
  return join(dir, 'events.sqlite');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type Db = Parameters<typeof sqliteAll>[0];
const dbOf = (store: SQLiteEventStore) => (store as unknown as { db: Db }).db;

async function visibleSummaries(store: SQLiteEventStore, sessionId: string): Promise<string[]> {
  return (await store.getSessionEvents(sessionId))
    .filter((event) => event.eventType === 'session_summary')
    .map((event) => event.content);
}

// Issue #254: sessions summarized before the refresh (#221) hold two or more
// visible summaries, so retrieval returned both. Runs against a real store so
// "hidden" is proven on the read paths retrieval uses.
describe('SQLiteEventStore.supersedeDuplicateSessionSummaries', () => {
  async function setup() {
    const dbPath = tempDbPath();
    const store = new SQLiteEventStore(dbPath);
    await store.initialize();
    const at = (iso: string) => new Date(`2026-08-01T${iso}.000Z`);
    await store.append({ eventType: 'user_prompt', sessionId: 'legacy', timestamp: at('00:00:00'), content: '질문' });
    const oldest = await store.append({ eventType: 'session_summary', sessionId: 'legacy', timestamp: at('00:01:00'), content: '- oldestneedle 요약', metadata: { generated: 'rule' } });
    const middle = await store.append({ eventType: 'session_summary', sessionId: 'legacy', timestamp: at('00:02:00'), content: '- middleneedle 요약' });
    const newest = await store.append({ eventType: 'session_summary', sessionId: 'legacy', timestamp: at('00:03:00'), content: '- newestneedle 요약', metadata: { generated: 'llm' } });
    const single = await store.append({ eventType: 'session_summary', sessionId: 'single', timestamp: at('00:00:30'), content: '- singleneedle 요약' });
    return { dbPath, store, oldest: oldest.eventId!, middle: middle.eventId!, newest: newest.eventId!, single: single.eventId! };
  }

  it('keeps only the newest summary of each session visible to retrieval', async () => {
    const { store, oldest, middle, newest } = await setup();

    const result = await store.supersedeDuplicateSessionSummaries({ now: new Date('2026-11-18T00:00:00.000Z') });

    expect(result).toEqual({
      dryRun: false,
      sessions: 1,
      superseded: 2,
      keptByKind: { llm: 1 },
      supersededByKind: { rule: 1, unlabeled: 1 },
      samples: [{ sessionId: 'legacy', keptEventId: newest, supersededEventIds: [middle, oldest] }]
    });
    expect(await visibleSummaries(store, 'legacy')).toEqual(['- newestneedle 요약']);
    expect(await visibleSummaries(store, 'single')).toEqual(['- singleneedle 요약']);
    expect(await store.getEvent(oldest)).toBeNull();
    expect(await store.keywordSearch('oldestneedle')).toHaveLength(0);
    expect(await store.keywordSearch('middleneedle')).toHaveLength(0);
    expect(await store.keywordSearch('newestneedle')).toHaveLength(1);

    // Hidden, not deleted: the row and its previous state stay recoverable.
    const hidden = await store.getEvent(oldest, { includeQuarantined: true });
    expect(hidden?.metadata).toMatchObject({
      generated: 'rule',
      quarantine: {
        status: 'active',
        category: 'superseded',
        supersededBy: newest,
        detectedAt: '2026-11-18T00:00:00.000Z'
      }
    });
    expect(hidden?.metadata?.tags).toContain('quarantine:superseded');

    await store.close();
  });

  it('records a governance audit row for every summary it hides', async () => {
    const { store, oldest, middle, newest } = await setup();

    await store.supersedeDuplicateSessionSummaries();

    const rows = sqliteAll<{ operation: string; target_type: string; target_id: string; source_event_ids: string; after_json: string }>(
      dbOf(store),
      `SELECT operation, target_type, target_id, source_event_ids, after_json FROM memory_governance_audit ORDER BY target_id`
    );
    expect(rows.map((row) => row.target_id).sort()).toEqual([middle, oldest].sort());
    for (const row of rows) {
      expect(row.operation).toBe('quarantine');
      expect(row.target_type).toBe('event');
      expect(JSON.parse(row.source_event_ids)).toEqual([newest]);
      expect(JSON.parse(row.after_json)).toMatchObject({ quarantine: { category: 'superseded', supersededBy: newest } });
    }

    await store.close();
  });

  it('changes nothing in a dry run, even on a read-only store', async () => {
    const { dbPath, store, newest, middle, oldest } = await setup();
    const snapshot = (db: Db) => ({
      events: sqliteAll(db, `SELECT id, metadata FROM events ORDER BY id`),
      audit: sqliteAll(db, `SELECT COUNT(*) AS n FROM memory_governance_audit`),
      embeddingOutbox: sqliteAll(db, `SELECT * FROM embedding_outbox ORDER BY rowid`),
      vectorOutbox: sqliteAll(db, `SELECT * FROM vector_outbox ORDER BY rowid`)
    });
    const before = snapshot(dbOf(store));
    await store.close();

    const readonly = new SQLiteEventStore(dbPath, { readonly: true });
    const preview = await readonly.supersedeDuplicateSessionSummaries({ dryRun: true });
    await readonly.close();

    expect(preview).toEqual({
      dryRun: true,
      sessions: 1,
      superseded: 2,
      keptByKind: { llm: 1 },
      supersededByKind: { rule: 1, unlabeled: 1 },
      samples: [{ sessionId: 'legacy', keptEventId: newest, supersededEventIds: [middle, oldest] }]
    });
    const reopened = new SQLiteEventStore(dbPath);
    await reopened.initialize();
    expect(snapshot(dbOf(reopened))).toEqual(before);
    expect(await visibleSummaries(reopened, 'legacy')).toHaveLength(3);
    await reopened.close();
  });

  it('is idempotent and ignores summaries that are already hidden', async () => {
    const { store } = await setup();

    await store.supersedeDuplicateSessionSummaries();
    await expect(store.supersedeDuplicateSessionSummaries()).resolves.toEqual({
      dryRun: false, sessions: 0, superseded: 0, keptByKind: {}, supersededByKind: {}, samples: []
    });

    await store.close();
  });

  it('keeps an LLM summary over a later template summary of the same session', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    const llm = await store.append({ eventType: 'session_summary', sessionId: 'mixed', timestamp: new Date('2026-08-01T01:43:13.000Z'), content: '- 결정: llmneedle 설정 추가', metadata: { generated: 'llm' } });
    const template = await store.append({ eventType: 'session_summary', sessionId: 'mixed', timestamp: new Date('2026-08-01T02:02:59.000Z'), content: 'Session with 2 user prompts and 2 responses.' });

    const result = await store.supersedeDuplicateSessionSummaries();

    expect(result.samples).toEqual([{ sessionId: 'mixed', keptEventId: llm.eventId, supersededEventIds: [template.eventId] }]);
    expect(await visibleSummaries(store, 'mixed')).toEqual(['- 결정: llmneedle 설정 추가']);

    await store.close();
  });

  it('breaks a timestamp tie by insertion order, so the summary written last stays', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    const at = new Date('2026-08-01T00:00:00.000Z');
    const first = await store.append({ eventType: 'session_summary', sessionId: 'tie', timestamp: at, content: '- first' });
    const second = await store.append({ eventType: 'session_summary', sessionId: 'tie', timestamp: at, content: '- second' });

    const result = await store.supersedeDuplicateSessionSummaries();

    expect(result.samples).toEqual([{ sessionId: 'tie', keptEventId: second.eventId, supersededEventIds: [first.eventId] }]);
    expect(await visibleSummaries(store, 'tie')).toEqual(['- second']);

    await store.close();
  });
  // #256 hides the summaries a refresh replaces in append's transaction. The repair goes
  // through the same code, so a hidden legacy summary looks exactly like a refreshed one.
  it('hides a summary and audits it exactly as a summary refresh does', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    const at = new Date('2026-08-01T00:00:00.000Z');
    const refreshedOld = await store.append({ eventType: 'session_summary', sessionId: 'refreshed', timestamp: at, content: '- refreshed old' });
    await store.append(
      { eventType: 'session_summary', sessionId: 'refreshed', timestamp: at, content: '- refreshed new', metadata: { generated: 'llm' } },
      { replaces: { eventIds: [refreshedOld.eventId!], metadataOnDuplicate: {} } }
    );
    const legacyOld = await store.append({ eventType: 'session_summary', sessionId: 'legacy', timestamp: at, content: '- legacy old' });
    await store.append({ eventType: 'session_summary', sessionId: 'legacy', timestamp: at, content: '- legacy new', metadata: { generated: 'llm' } });

    await store.supersedeDuplicateSessionSummaries();

    const shape = async (eventId: string) => {
      const event = await store.getEvent(eventId, { includeQuarantined: true });
      const quarantine = { ...(event?.metadata?.quarantine as Record<string, unknown>) };
      delete quarantine.supersededBy;
      delete quarantine.detectedAt;
      const [audit] = sqliteAll<Record<string, unknown>>(
        dbOf(store),
        `SELECT operation, actor, target_type, before_json, after_json FROM memory_governance_audit WHERE target_id = ?`,
        [eventId]
      );
      const after = JSON.parse(String(audit.after_json));
      delete after.quarantine.supersededBy;
      delete after.quarantine.detectedAt;
      return { quarantine, tags: event?.metadata?.tags, audit: { ...audit, after_json: after } };
    };
    expect(await shape(legacyOld.eventId!)).toEqual(await shape(refreshedOld.eventId!));

    await store.close();
  });

  // The repair takes the write lock up front (BEGIN IMMEDIATE, as other read-then-write
  // paths do) and waits busy_timeout for it; if a hook holds it longer, it fails before
  // writing anything and can simply be run again.
  it('fails without changing anything while another connection holds the write lock, and succeeds when run again', async () => {
    const { dbPath, store, newest } = await setup();
    dbOf(store).pragma('busy_timeout = 50');
    const hook = new Database(dbPath);
    hook.exec('BEGIN IMMEDIATE');

    await expect(store.supersedeDuplicateSessionSummaries()).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
    expect(await visibleSummaries(store, 'legacy')).toHaveLength(3);

    hook.exec('ROLLBACK');
    hook.close();
    const retried = await store.supersedeDuplicateSessionSummaries();
    expect(retried.samples[0]?.keptEventId).toBe(newest);
    expect(await visibleSummaries(store, 'legacy')).toHaveLength(1);

    await store.close();
  });

  // A hook that writes while the repair waits for the lock: a deferred transaction reads
  // first, then cannot upgrade because the data changed under it (SQLITE_BUSY_SNAPSHOT,
  // which busy_timeout does not retry). The repair waits for the hook and then runs.
  it('waits for a hook that is writing and then hides the summaries', async () => {
    const { dbPath, store } = await setup();
    const hook = new Worker(`
      const { parentPort, workerData } = require('worker_threads');
      const Database = require(workerData.betterSqlite3);
      const db = new Database(workerData.dbPath);
      db.exec('BEGIN IMMEDIATE');
      db.exec('CREATE TABLE hook_write (x)');
      parentPort.postMessage('locked');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 200);
    `, { eval: true, workerData: { dbPath, betterSqlite3: createRequire(import.meta.url).resolve('better-sqlite3') } });
    await new Promise((resolve) => hook.once('message', resolve));

    const result = await store.supersedeDuplicateSessionSummaries();

    expect(result.superseded).toBe(2);
    expect(await visibleSummaries(store, 'legacy')).toHaveLength(1);
    await hook.terminate();
    await store.close();
  });

  it('rolls back every summary it hid when a later write fails', async () => {
    const { store, oldest } = await setup();
    // middle is hidden first, then oldest fails.
    dbOf(store).exec(`CREATE TRIGGER fail_on_oldest BEFORE UPDATE ON events WHEN OLD.id = '${oldest}'
      BEGIN SELECT RAISE(ABORT, 'disk went away'); END`);

    await expect(store.supersedeDuplicateSessionSummaries()).rejects.toThrow('disk went away');

    expect(await visibleSummaries(store, 'legacy')).toHaveLength(3);
    expect(sqliteAll(dbOf(store), `SELECT * FROM memory_governance_audit`)).toHaveLength(0);

    await store.close();
  });

  // #256 shows a superseded summary again when a later refresh writes the same text; that
  // applies to the rows the repair hid too, so the session still has one visible summary.
  it('lets a later refresh that repeats a hidden summary show it again in place of the kept one', async () => {
    const { store, middle, newest } = await setup();
    await store.supersedeDuplicateSessionSummaries();

    await store.append(
      { eventType: 'session_summary', sessionId: 'legacy', timestamp: new Date('2026-08-02T00:00:00.000Z'), content: '- middleneedle 요약', metadata: { generated: 'llm' } },
      { replaces: { eventIds: [newest], metadataOnDuplicate: { summarizedExchangeCount: 12 } } }
    );

    const visible = (await store.getSessionEvents('legacy')).filter((event) => event.eventType === 'session_summary');
    expect(visible.map((event) => event.id)).toEqual([middle]);
    expect(visible[0]?.metadata).toMatchObject({ summarizedExchangeCount: 12 });

    await store.close();
  });
});
