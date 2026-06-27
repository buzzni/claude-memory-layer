import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cml-aggregates-'));
  tempDirs.push(dir);
  return join(dir, 'events.sqlite');
}

async function seed(store: SQLiteEventStore): Promise<void> {
  const day1 = new Date('2026-06-01T10:00:00.000Z');
  const day2 = new Date('2026-06-02T10:00:00.000Z');
  await store.append({ eventType: 'user_prompt', sessionId: 's1', timestamp: day1, content: 'prompt one' });
  await store.append({ eventType: 'agent_response', sessionId: 's1', timestamp: day1, content: 'response one' });
  await store.append({ eventType: 'user_prompt', sessionId: 's2', timestamp: day2, content: 'prompt two' });
  await store.append({ eventType: 'tool_observation', sessionId: 's2', timestamp: day2, content: 'tool two' });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('SQLiteEventStore SQL aggregates', () => {
  it('counts events by type', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    await seed(store);

    const counts = Object.fromEntries((await store.getEventTypeCounts()).map((c) => [c.eventType, c.count]));
    expect(counts).toMatchObject({ user_prompt: 2, agent_response: 1, tool_observation: 1 });

    await store.close();
  });

  it('counts distinct sessions', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    await seed(store);

    expect(await store.getDistinctSessionCount()).toBe(2);

    await store.close();
  });

  it('groups daily counts with a type breakdown and honours the cutoff', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    await seed(store);

    expect(await store.getDailyEventCounts('2026-06-01T00:00:00.000Z')).toEqual([
      { day: '2026-06-01', total: 2, prompts: 1, responses: 1, tools: 0 },
      { day: '2026-06-02', total: 2, prompts: 1, responses: 0, tools: 1 }
    ]);

    // A later cutoff excludes the first day.
    const fromDay2 = await store.getDailyEventCounts('2026-06-02T00:00:00.000Z');
    expect(fromDay2.map((d) => d.day)).toEqual(['2026-06-02']);

    await store.close();
  });
});
