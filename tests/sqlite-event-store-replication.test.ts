/**
 * Tests for SQLiteEventStore replication helpers used by Mongo sync.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { SQLiteEventStore } from '../src/core/sqlite-event-store.js';

describe('SQLiteEventStore replication helpers', () => {
  let tempDir: string;
  let storeA: SQLiteEventStore;
  let storeB: SQLiteEventStore;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-memory-layer-test-'));
    storeA = new SQLiteEventStore(path.join(tempDir, 'a.sqlite'));
    storeB = new SQLiteEventStore(path.join(tempDir, 'b.sqlite'));
    await storeA.initialize();
    await storeB.initialize();
  });

  afterEach(() => {
    try { storeA.close(); } catch {}
    try { storeB.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('getEventsSinceRowid returns incremental batches in insertion order', async () => {
    const sessionId = 'session-1';

    await storeA.append({ eventType: 'user_prompt', sessionId, timestamp: new Date(), content: 'a' });
    await storeA.append({ eventType: 'user_prompt', sessionId, timestamp: new Date(), content: 'b' });
    await storeA.append({ eventType: 'user_prompt', sessionId, timestamp: new Date(), content: 'c' });

    const batch1 = await storeA.getEventsSinceRowid(0, 10);
    expect(batch1).toHaveLength(3);
    expect(batch1.map(x => x.event.content)).toEqual(['a', 'b', 'c']);

    // rowid should be strictly increasing
    expect(batch1[0].rowid).toBeLessThan(batch1[1].rowid);
    expect(batch1[1].rowid).toBeLessThan(batch1[2].rowid);

    const lastRowid = batch1[2].rowid;

    await storeA.append({ eventType: 'user_prompt', sessionId, timestamp: new Date(), content: 'd' });

    const batch2 = await storeA.getEventsSinceRowid(lastRowid, 10);
    expect(batch2).toHaveLength(1);
    expect(batch2[0].event.content).toBe('d');
  });

  it('importEvents preserves stable IDs and is idempotent via dedupeKey', async () => {
    const sessionId = 'session-2';
    const appendRes = await storeA.append({
      eventType: 'user_prompt',
      sessionId,
      timestamp: new Date(),
      content: 'hello world'
    });

    expect(appendRes.success).toBe(true);
    const sourceEvent = await storeA.getEvent(appendRes.eventId!);
    expect(sourceEvent).not.toBeNull();

    const imported1 = await storeB.importEvents([sourceEvent!]);
    expect(imported1.inserted).toBe(1);
    expect(imported1.skipped).toBe(0);

    const importedEvent = await storeB.getEvent(sourceEvent!.id);
    expect(importedEvent?.content).toBe('hello world');

    // Importing again should be a no-op
    const imported2 = await storeB.importEvents([sourceEvent!]);
    expect(imported2.inserted).toBe(0);
    expect(imported2.skipped).toBe(1);

    // append() should treat it as duplicate due to event_dedup entry
    const dup = await storeB.append({
      eventType: 'user_prompt',
      sessionId,
      timestamp: new Date(),
      content: 'hello world'
    });
    expect(dup.success).toBe(true);
    expect(dup.isDuplicate).toBe(true);
    expect(dup.eventId).toBe(sourceEvent!.id);
  });
});

