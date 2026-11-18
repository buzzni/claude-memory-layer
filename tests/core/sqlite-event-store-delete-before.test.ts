import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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
});
