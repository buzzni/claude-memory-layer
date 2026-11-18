import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cml-delete-event-'));
  tempDirs.push(dir);
  return join(dir, 'events.sqlite');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('SQLiteEventStore.deleteEventById', () => {
  it('removes the event and reports that it deleted something', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    const appended = await store.append({
      eventType: 'user_prompt',
      sessionId: 's1',
      timestamp: new Date(),
      content: 'keep me'
    });
    const doomed = await store.append({
      eventType: 'user_prompt',
      sessionId: 's1',
      timestamp: new Date(),
      content: 'delete me'
    });

    await expect(store.deleteEventById(doomed.eventId!)).resolves.toBe(true);

    expect(await store.getEvent(doomed.eventId!)).toBeNull();
    // 같은 세션의 다른 이벤트는 살아 있어야 한다 — 단건 삭제이지 세션 삭제가 아니다.
    expect(await store.getEvent(appended.eventId!)).not.toBeNull();

    await store.close();
  });

  it('reports false for an id that does not exist', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();

    await expect(store.deleteEventById('no-such-event')).resolves.toBe(false);

    await store.close();
  });

  // keywordSearch 는 events 와 조인하므로 행만 지워도 결과에서 빠진다 — 그래서 검색 결과로는
  // FTS 정리를 증명할 수 없다. 인덱스 자체를 직접 본다. 여기가 낡으면 FTS 가 계속 커지고,
  // 재색인·마이그레이션 때 없는 event_id 를 가리키는 고아 행이 남는다.
  it('removes the deleted event from the FTS index itself, not just from joined results', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    const doomed = await store.append({
      eventType: 'user_prompt',
      sessionId: 's1',
      timestamp: new Date(),
      content: 'zzqqxx unique needle'
    });

    const db = store.getDatabase();
    const countIndexed = (): number => (db
      .prepare(`SELECT COUNT(*) AS n FROM events_fts WHERE event_id = ?`)
      .get(doomed.eventId!) as { n: number }).n;

    expect(countIndexed()).toBe(1);

    await store.deleteEventById(doomed.eventId!);

    expect(countIndexed()).toBe(0);

    await store.close();
  });

  it('leaves other sessions untouched', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    const other = await store.append({
      eventType: 'user_prompt', sessionId: 's2', timestamp: new Date(), content: 'other session'
    });
    const doomed = await store.append({
      eventType: 'user_prompt', sessionId: 's1', timestamp: new Date(), content: 'doomed'
    });

    await store.deleteEventById(doomed.eventId!);

    expect(await store.getEvent(other.eventId!)).not.toBeNull();
    await store.close();
  });

  // vector_outbox 는 event_id 가 아니라 item_id 로 키를 잡아서 관련 테이블 목록에서 빠졌었다.
  // 남은 done 작업은 통계에 잡히고, pending 작업은 워커가 집어 들어 내용 없는 이벤트를 만난다.
  it('drops the deleted event\'s vector outbox jobs and keeps the others', async () => {
    const store = new SQLiteEventStore(tempDbPath(), { vectorOutbox: {} });
    await store.initialize();
    const kept = await store.append({
      eventType: 'user_prompt', sessionId: 's1', timestamp: new Date(), content: 'keep my embedding job'
    });
    const doomed = await store.append({
      eventType: 'user_prompt', sessionId: 's1', timestamp: new Date(), content: 'drop my embedding job'
    });
    const db = store.getDatabase();
    // 같은 id 를 쓰는 다른 종류의 작업은 이벤트 삭제와 무관하다.
    db.prepare(`INSERT INTO vector_outbox (job_id, item_kind, item_id, embedding_version) VALUES ('other-kind', 'task', ?, 'v1')`)
      .run(doomed.eventId!);
    const jobs = (itemId: string) => db
      .prepare('SELECT item_kind FROM vector_outbox WHERE item_id = ? ORDER BY item_kind')
      .all(itemId);
    expect(jobs(doomed.eventId!)).toEqual([{ item_kind: 'event' }, { item_kind: 'task' }]);

    await store.deleteEventById(doomed.eventId!);

    expect(jobs(doomed.eventId!)).toEqual([{ item_kind: 'task' }]);
    expect(jobs(kept.eventId!)).toEqual([{ item_kind: 'event' }]);
    await store.close();
  });
});
