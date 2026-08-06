import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cml-recent-type-filter-'));
  tempDirs.push(dir);
  return join(dir, 'events.sqlite');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function seed(store: SQLiteEventStore): Promise<void> {
  // Mirrors the real distribution: tool observations dominate, so an unfiltered
  // recency window is almost entirely made of them.
  for (let i = 0; i < 20; i += 1) {
    await store.append({
      eventType: 'tool_observation',
      sessionId: 's1',
      timestamp: new Date(Date.UTC(2026, 7, 6, 0, i)),
      content: `{"toolName":"Bash","toolInput":{"command":"echo ${i}"}}`
    });
  }
  await store.append({
    eventType: 'session_summary',
    sessionId: 's1',
    timestamp: new Date(Date.UTC(2026, 7, 1)),
    content: '- 결정: 워크트리 해시를 메인 체크아웃으로 리다이렉트'
  });
  await store.append({
    eventType: 'agent_response',
    sessionId: 's1',
    timestamp: new Date(Date.UTC(2026, 7, 2)),
    content: 'Root cause: the outbox lock was never released.'
  });
}

describe('SQLiteEventStore.getRecentEvents event type filter', () => {
  it('returns every type when no filter is given', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    await seed(store);

    const events = await store.getRecentEvents(5);

    expect(events.map((e) => e.eventType)).toEqual(Array(5).fill('tool_observation'));
    await store.close();
  });

  it('reaches rare types without loading the dominant ones', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    await seed(store);

    const events = await store.getRecentEvents(5, {
      eventTypes: ['session_summary', 'agent_response']
    });

    expect(events.map((e) => e.eventType).sort()).toEqual(['agent_response', 'session_summary']);
    await store.close();
  });

  it('still orders newest first inside the filter', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    await seed(store);

    const events = await store.getRecentEvents(5, {
      eventTypes: ['session_summary', 'agent_response']
    });

    expect(events.map((e) => e.eventType)).toEqual(['agent_response', 'session_summary']);
    await store.close();
  });

  it('resolves the filtered scan from an index instead of walking the table', async () => {
    // Without a (event_type, timestamp) index SQLite walks idx_events_timestamp
    // backwards and evaluates the json_extract quarantine predicate on every
    // row it visits. A store whose injectable types number fewer than the limit
    // degrades to a full scan — on a 312MB store that measured 1.2s cold, on
    // the SessionStart hook's critical path.
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    await seed(store);

    const plan = store.getDatabase()
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT * FROM events
         WHERE 1=1 AND event_type IN ('session_summary', 'agent_response')
         ORDER BY timestamp DESC LIMIT 60`
      )
      .all() as Array<{ detail: string }>;

    expect(plan.map((row) => row.detail).join(' ')).toContain('idx_events_type_timestamp');
    await store.close();
  });

  it('treats an empty filter list as no filter rather than as "match nothing"', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    await seed(store);

    expect(await store.getRecentEvents(3, { eventTypes: [] })).toHaveLength(3);
    await store.close();
  });
});
