import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cml-session-turns-'));
  tempDirs.push(dir);
  return join(dir, 'events.sqlite');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('SQLiteEventStore.getSessionTurns', () => {
  it('keeps another session’s events out of a turn whose id both sessions use', async () => {
    // A forked or re-imported transcript keeps its host turn ids under a new session id.
    const store = new SQLiteEventStore(tempDbPath());
    await store.append({
      eventType: 'user_prompt', sessionId: 'session-a', timestamp: new Date(Date.UTC(2026, 10, 1, 0, 0)),
      content: 'Prompt from session A', metadata: { turnId: 'shared-turn' }
    });
    await store.append({
      eventType: 'user_prompt', sessionId: 'session-b', timestamp: new Date(Date.UTC(2026, 10, 1, 0, 1)),
      content: 'Prompt from session B', metadata: { turnId: 'shared-turn' }
    });

    const turns = await store.getSessionTurns('session-a');
    await store.close();

    expect(turns).toHaveLength(1);
    expect(turns[0].events.map((event) => event.content)).toEqual(['Prompt from session A']);
    expect(turns[0].eventCount).toBe(1);
  });
});
