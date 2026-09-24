import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { EventStore } from '../../src/core/event-store.js';
import { ConsolidatedStore } from '../../src/core/consolidated-store.js';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cml-consolidated-'));
  tempDirs.push(dir);
  return join(dir, 'events.sqlite');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('ConsolidatedStore source-event index', () => {
  it('indexes source events and reports them via a single lookup', async () => {
    const store = new EventStore(tempDbPath());
    await store.initialize();
    const consolidated = new ConsolidatedStore(store);

    await consolidated.create({ summary: 's', topics: ['t'], sourceEvents: ['evt_1', 'evt_2'], confidence: 0.7 });

    expect(await consolidated.isAlreadyConsolidated(['evt_2'])).toBe(true);
    expect(await consolidated.isAlreadyConsolidated(['evt_unknown'])).toBe(false);
    expect(await consolidated.isAlreadyConsolidated([])).toBe(false);

    await store.close();
  });

  it('does not match a substring event id (the old LIKE false positive)', async () => {
    const store = new EventStore(tempDbPath());
    await store.initialize();
    const consolidated = new ConsolidatedStore(store);

    await consolidated.create({ summary: 's', topics: ['t'], sourceEvents: ['evt_12'], confidence: 0.7 });

    // evt_1 is a substring of evt_12 but must not be treated as consolidated.
    expect(await consolidated.isAlreadyConsolidated(['evt_1'])).toBe(false);
    expect(await consolidated.isAlreadyConsolidated(['evt_12'])).toBe(true);

    await store.close();
  });

  it('drops junction rows on delete so stale ids are not reported consolidated', async () => {
    const store = new EventStore(tempDbPath());
    await store.initialize();
    const consolidated = new ConsolidatedStore(store);

    const id = await consolidated.create({ summary: 's', topics: ['t'], sourceEvents: ['evt_9'], confidence: 0.7 });
    expect(await consolidated.isAlreadyConsolidated(['evt_9'])).toBe(true);

    await consolidated.delete(id);
    expect(await consolidated.isAlreadyConsolidated(['evt_9'])).toBe(false);

    await store.close();
  });

  it('backfills the junction from legacy source_events JSON on initialize', async () => {
    const dbPath = tempDbPath();

    // Simulate pre-migration data: a consolidated memory whose source_events
    // exist only as JSON, with no junction rows.
    const store1 = new EventStore(dbPath);
    await store1.initialize();
    const db = store1.getDatabase();
    db.prepare('DELETE FROM consolidated_memory_events').run();
    db.prepare(
      `INSERT INTO consolidated_memories (memory_id, summary, topics, source_events, confidence)
       VALUES (?, ?, ?, ?, ?)`
    ).run('legacy-1', 'old', '["t"]', '["evt_legacy"]', 0.5);
    await store1.close();

    // Re-opening runs initialize(), which should backfill the junction.
    const store2 = new EventStore(dbPath);
    await store2.initialize();
    const consolidated = new ConsolidatedStore(store2);

    expect(await consolidated.isAlreadyConsolidated(['evt_legacy'])).toBe(true);

    await store2.close();
  });
});
