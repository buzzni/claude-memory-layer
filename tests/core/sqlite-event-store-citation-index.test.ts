import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { generateCitationId } from '../../src/core/citation-generator.js';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cml-citation-index-'));
  tempDirs.push(dir);
  return join(dir, 'events.sqlite');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('SQLiteEventStore citation index', () => {
  it('resolves an event by its citation id and returns null for unknown ids', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();

    const appended = await store.append({
      eventType: 'user_prompt',
      sessionId: 's1',
      timestamp: new Date(),
      content: 'citation lookup target'
    });
    expect(appended.success).toBe(true);

    const citationId = generateCitationId(appended.eventId!);
    const found = await store.getEventByCitationId(citationId);
    expect(found?.id).toBe(appended.eventId);

    expect(await store.getEventByCitationId('ZZZZZZ')).toBeNull();

    await store.close();
  });

  it('self-heals: indexes events appended after the index was first built', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();

    const first = await store.append({
      eventType: 'user_prompt',
      sessionId: 's1',
      timestamp: new Date(),
      content: 'first event'
    });
    // Build the index via an initial lookup.
    await store.getEventByCitationId(generateCitationId(first.eventId!));

    // Append a new event *after* the index already exists; append does not
    // eagerly index, so this exercises the lazy backfill-on-miss.
    const second = await store.append({
      eventType: 'agent_response',
      sessionId: 's1',
      timestamp: new Date(),
      content: 'second event added after the citation index was built'
    });

    const found = await store.getEventByCitationId(generateCitationId(second.eventId!));
    expect(found?.id).toBe(second.eventId);

    await store.close();
  });

  it('stops resolving a citation after its event is deleted', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();

    const appended = await store.append({
      eventType: 'user_prompt',
      sessionId: 'doomed-session',
      timestamp: new Date(),
      content: 'event to be deleted'
    });
    const citationId = generateCitationId(appended.eventId!);
    expect((await store.getEventByCitationId(citationId))?.id).toBe(appended.eventId);

    await store.deleteSessionEvents('doomed-session');
    expect(await store.getEventByCitationId(citationId)).toBeNull();

    await store.close();
  });
});
