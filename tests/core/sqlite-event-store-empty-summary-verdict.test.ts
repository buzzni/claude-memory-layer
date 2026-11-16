import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteExec } from '../../src/core/sqlite-wrapper.js';

const tempDirs: string[] = [];
const stores: SQLiteEventStore[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cml-empty-summary-verdict-'));
  tempDirs.push(dir);
  return join(dir, 'events.sqlite');
}

async function openStore(dbPath = tempDbPath()): Promise<SQLiteEventStore> {
  const store = new SQLiteEventStore(dbPath);
  stores.push(store);
  await store.initialize();
  return store;
}

afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function seedSession(store: SQLiteEventStore, sessionId: string, day: number, count = 3): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await store.append({
      eventType: i % 2 === 0 ? 'user_prompt' : 'agent_response',
      sessionId,
      timestamp: new Date(Date.UTC(2026, 10, day, 0, i)),
      content: `${sessionId} event ${i}`
    });
  }
}

describe('SQLiteEventStore empty summary verdicts', () => {
  it('drops a session judged empty from the backfill window so older sessions can reach it', async () => {
    const store = await openStore();
    await seedSession(store, 'older-failed', 1);
    await seedSession(store, 'recent-empty', 2);

    await expect(store.getSessionsWithoutSummary('current', 1)).resolves.toEqual(['recent-empty']);

    await store.markSessionSummaryEmpty('recent-empty', 3);

    await expect(store.getSessionsWithoutSummary('current', 1)).resolves.toEqual(['older-failed']);
  });

  it('makes the session eligible again once it gains events after the verdict', async () => {
    const store = await openStore();
    await seedSession(store, 'resumed', 1);
    await store.markSessionSummaryEmpty('resumed', 3);
    await expect(store.getSessionsWithoutSummary('current', 5)).resolves.toEqual([]);

    await store.append({
      eventType: 'user_prompt',
      sessionId: 'resumed',
      timestamp: new Date(Date.UTC(2026, 10, 3)),
      content: 'resumed with new work'
    });

    await expect(store.getSessionsWithoutSummary('current', 5)).resolves.toEqual(['resumed']);
  });

  it('keeps the latest verdict when a session is judged empty again', async () => {
    const store = await openStore();
    await seedSession(store, 'twice', 1);
    await store.markSessionSummaryEmpty('twice', 3);
    await store.append({
      eventType: 'agent_response',
      sessionId: 'twice',
      timestamp: new Date(Date.UTC(2026, 10, 3)),
      content: 'still nothing durable'
    });
    await store.markSessionSummaryEmpty('twice', 4);

    await expect(store.getSessionsWithoutSummary('current', 5)).resolves.toEqual([]);
  });

  it('counts the verdict over the same non-quarantined events the summarizer was shown', async () => {
    const store = await openStore();
    await seedSession(store, 'with-quarantine', 1);
    await store.append({
      eventType: 'agent_response',
      sessionId: 'with-quarantine',
      timestamp: new Date(Date.UTC(2026, 10, 1, 1)),
      content: 'quarantined response',
      metadata: { quarantine: { status: 'active' } }
    });

    const judged = await store.getSessionEvents('with-quarantine');
    expect(judged).toHaveLength(3);
    await store.markSessionSummaryEmpty('with-quarantine', judged.length);

    await expect(store.getSessionsWithoutSummary('current', 5)).resolves.toEqual([]);
  });

  it('still lists unsummarized sessions from a read-only handle on a store without the verdict table', async () => {
    const dbPath = tempDbPath();
    const writer = await openStore(dbPath);
    await seedSession(writer, 'legacy', 1);
    sqliteExec(writer.getDatabase(), 'DROP TABLE empty_summary_sessions');

    const reader = new SQLiteEventStore(dbPath, { readonly: true });
    stores.push(reader);
    await reader.initialize();

    await expect(reader.getSessionsWithoutSummary('current', 5)).resolves.toEqual(['legacy']);
  });
});
