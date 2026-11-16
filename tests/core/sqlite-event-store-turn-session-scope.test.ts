import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cml-turn-session-scope-'));
  tempDirs.push(dir);
  return join(dir, 'events.sqlite');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A forked or re-imported Codex transcript keeps the host's native turn id
// under a new session id, so the same turn id exists in two sessions.
async function seedSharedTurn(store: SQLiteEventStore): Promise<void> {
  await store.append({
    eventType: 'user_prompt',
    sessionId: 'session-a',
    timestamp: new Date(Date.UTC(2026, 10, 1, 0, 0)),
    content: 'prompt in session a',
    metadata: { turnId: 'shared' }
  });
  await store.append({
    eventType: 'agent_response',
    sessionId: 'session-a',
    timestamp: new Date(Date.UTC(2026, 10, 1, 0, 1)),
    content: 'answer in session a',
    metadata: { turnId: 'shared' }
  });
  await store.append({
    eventType: 'user_prompt',
    sessionId: 'session-b',
    timestamp: new Date(Date.UTC(2026, 10, 2, 0, 0)),
    content: 'prompt in session b',
    metadata: { turnId: 'shared' }
  });
}

describe('SQLiteEventStore turn lookup session scope', () => {
  it('returns only the given session\'s events for a turn id shared by two sessions', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    await seedSharedTurn(store);

    const a = await store.getEventsByTurn('shared', { sessionId: 'session-a' });
    const b = await store.getEventsByTurn('shared', { sessionId: 'session-b' });

    expect(a.map((e) => e.content)).toEqual(['prompt in session a', 'answer in session a']);
    expect(b.map((e) => e.content)).toEqual(['prompt in session b']);
    await store.close();
  });

  it('keeps each session\'s turn list to its own events', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    await seedSharedTurn(store);

    const [turnB] = await store.getSessionTurns('session-b');

    expect(turnB.events.map((e) => e.sessionId)).toEqual(['session-b']);
    expect(turnB.eventCount).toBe(1);
    expect(turnB.hasResponse).toBe(false);
    await store.close();
  });
});
