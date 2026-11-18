import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import Database from 'better-sqlite3';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cml-delete-before-'));
  tempDirs.push(dir);
  return join(dir, 'events.sqlite');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function seed(store: SQLiteEventStore): Promise<{ oldTool: string; newTool: string; oldPrompt: string }> {
  const oldTool = await store.append({
    eventType: 'tool_observation', sessionId: 's1', timestamp: new Date('2026-01-01T00:00:00.000Z'), content: 'old tool output'
  });
  const newTool = await store.append({
    eventType: 'tool_observation', sessionId: 's1', timestamp: new Date('2026-03-01T00:00:00.000Z'), content: 'new tool output'
  });
  const oldPrompt = await store.append({
    eventType: 'user_prompt', sessionId: 's1', timestamp: new Date('2026-01-01T00:00:00.000Z'), content: 'old prompt'
  });
  return { oldTool: oldTool.eventId!, newTool: newTool.eventId!, oldPrompt: oldPrompt.eventId! };
}

describe('SQLiteEventStore.deleteEventsBefore', () => {
  it('counts and deletes only events of the given type older than the cutoff', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    const ids = await seed(store);
    const cutoff = new Date('2026-02-01T00:00:00.000Z');

    const planned = await store.countEventsBefore(cutoff, 'tool_observation');
    expect(planned).toEqual({ rows: 1, contentBytes: Buffer.byteLength('old tool output') });

    const result = await store.deleteEventsBefore(cutoff, 'tool_observation');
    expect(result).toEqual({ deleted: 1, eventIds: [ids.oldTool] });

    expect(await store.getEvent(ids.oldTool)).toBeNull();
    expect(await store.getEvent(ids.newTool)).not.toBeNull();
    expect(await store.getEvent(ids.oldPrompt)).not.toBeNull();
    await store.close();
  });

  it('deletes every type older than the cutoff when no type is given', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    const ids = await seed(store);

    const result = await store.deleteEventsBefore(new Date('2026-02-01T00:00:00.000Z'));
    expect(result.deleted).toBe(2);
    expect(new Set(result.eventIds)).toEqual(new Set([ids.oldTool, ids.oldPrompt]));
    expect(await store.getEvent(ids.newTool)).not.toBeNull();
    await store.close();
  });

  it('removes deleted events from the FTS index and keeps the rest searchable', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    const ids = await seed(store);
    const db = store.getDatabase();
    const indexed = (eventId: string): number => (db
      .prepare('SELECT COUNT(*) AS n FROM events_fts WHERE event_id = ?')
      .get(eventId) as { n: number }).n;

    await store.deleteEventsBefore(new Date('2026-02-01T00:00:00.000Z'), 'tool_observation');

    expect(indexed(ids.oldTool)).toBe(0);
    expect(indexed(ids.newTool)).toBe(1);
    await store.close();
  });

  // vector_outbox 는 item_id 로 키를 잡아 관련 테이블 목록에서 빠졌었다. tool_observation 은
  // 큐에 들어가지 않으므로 프롬프트로 본다.
  it('drops the vector outbox jobs of the deleted events and keeps the rest', async () => {
    const store = new SQLiteEventStore(tempDbPath(), { vectorOutbox: {} });
    await store.initialize();
    const oldPrompt = await store.append({
      eventType: 'user_prompt', sessionId: 's1', timestamp: new Date('2026-01-01T00:00:00.000Z'), content: 'old prompt'
    });
    const newPrompt = await store.append({
      eventType: 'user_prompt', sessionId: 's1', timestamp: new Date('2026-03-01T00:00:00.000Z'), content: 'new prompt'
    });
    const db = store.getDatabase();
    db.prepare(`INSERT INTO vector_outbox (job_id, item_kind, item_id, embedding_version) VALUES ('other-kind', 'task', ?, 'v1')`)
      .run(oldPrompt.eventId!);
    const jobs = (itemId: string) => db
      .prepare('SELECT item_kind FROM vector_outbox WHERE item_id = ? ORDER BY item_kind')
      .all(itemId);
    expect(jobs(oldPrompt.eventId!)).toEqual([{ item_kind: 'event' }, { item_kind: 'task' }]);

    await store.deleteEventsBefore(new Date('2026-02-01T00:00:00.000Z'));

    expect(jobs(oldPrompt.eventId!)).toEqual([{ item_kind: 'task' }]);
    expect(jobs(newPrompt.eventId!)).toEqual([{ item_kind: 'event' }]);
    await store.close();
  });

  // 다른 연결(훅, 데몬)이 삭제 대상을 고른 직후 남을 행의 timestamp 를 cutoff 이전으로 옮긴다.
  // 반환 id, 지운 행, 지운 작업, audit 건수가 같은 집합이어야 한다(#265 와 같은 규칙).
  it('returns exactly the rows it deleted when another connection moves a row before the cutoff while it picks them', async () => {
    const dbPath = tempDbPath();
    const store = new SQLiteEventStore(dbPath, { vectorOutbox: {} });
    await store.initialize();
    const other = new Database(dbPath, { timeout: 0 });
    try {
      const doomed = await store.append({
        eventType: 'user_prompt', sessionId: 's1', timestamp: new Date('2026-01-01T00:00:00.000Z'), content: 'old prompt'
      });
      const contested = await store.append({
        eventType: 'user_prompt', sessionId: 's1', timestamp: new Date('2026-03-01T00:00:00.000Z'), content: 'new prompt'
      });
      const db = store.getDatabase();
      const prepare = db.prepare.bind(db);
      let otherWrite: unknown = 'not run';
      db.prepare = ((sql: string) => {
        const statement = prepare(sql);
        if (!/^\s*SELECT id FROM events WHERE timestamp < \?/.test(sql)) return statement;
        const all = statement.all.bind(statement);
        return Object.assign(statement, {
          all: (...params: unknown[]) => {
            const rows = all(...params);
            try {
              other.prepare('UPDATE events SET timestamp = (SELECT timestamp FROM events WHERE id = ?) WHERE id = ?')
                .run(doomed.eventId!, contested.eventId!);
              otherWrite = 'committed';
            } catch (error) {
              otherWrite = (error as { code?: string }).code;
            }
            return rows;
          }
        });
      }) as typeof db.prepare;

      const { deleted, eventIds } = await store.deleteEventsBefore(new Date('2026-02-01T00:00:00.000Z'), undefined, {
        operation: 'event_delete', actor: 'cli', targetType: 'events_before', targetId: '2026-02-01'
      });

      const jobs = db.prepare(`SELECT item_id FROM vector_outbox WHERE item_kind = 'event'`).all()
        .map((row) => (row as { item_id: string }).item_id);
      const audited = db.prepare(`SELECT after_json FROM memory_governance_audit WHERE operation = 'event_delete'`).all()
        .map((row) => JSON.parse((row as { after_json: string }).after_json));
      expect(deleted).toBe(eventIds.length);
      expect(eventIds).toEqual([doomed.eventId]);
      expect(await store.getEvent(contested.eventId!)).not.toBeNull();
      expect(jobs).toEqual([contested.eventId]);
      expect(audited).toEqual([{ deletedEvents: 1 }]);
      // The other connection waits for the delete instead of changing the rows it picked.
      expect(otherWrite).toBe('SQLITE_BUSY');
    } finally {
      other.close();
      await store.close();
    }
  });
});
