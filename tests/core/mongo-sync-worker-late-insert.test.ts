/**
 * Mongo sync pull with concurrent writers: a pusher reserves its seq range before inserting, so another machine can
 * insert a higher seq first. A puller that already advanced its cursor past the reserved range used to skip the late
 * insert forever. Pull now re-reads recently inserted documents below the cursor (import dedupes them by id).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { MongoSyncWorker } from '../../src/core/mongo-sync-worker.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { connectFakeMongo, FakeMongo } from '../helpers/fake-mongo.js';

type Doc = ReturnType<typeof remoteDoc>;

function remoteDoc(seq: number, insertedAt: Date) {
  return {
    _id: `team:event-${seq}`,
    projectKey: 'team',
    seq,
    eventId: `event-${seq}`,
    eventType: 'user_prompt',
    sessionId: `session-${seq}`,
    timestamp: insertedAt,
    content: `memory ${seq}`,
    canonicalKey: `memory ${seq}`,
    dedupeKey: `dedupe-${seq}`,
    metadata: null,
    insertedAt,
    updatedAt: insertedAt,
    source: { hostname: 'machine-a' }
  };
}

/** Pull runs against the shared fake collections; `docs` stays the live document list so a test can add to it. */
function connectFake(worker: MongoSyncWorker, docs: Doc[]): void {
  const mongo = new FakeMongo();
  mongo.events.docs = docs;
  connectFakeMongo(worker, mongo);
}

describe('MongoSyncWorker pull picks up documents another machine inserted late', () => {
  let tempDir: string;
  let store: SQLiteEventStore;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cml-mongo-late-insert-'));
    store = new SQLiteEventStore(path.join(tempDir, 'events.sqlite'));
    await store.initialize();
  });

  afterEach(async () => {
    try { await store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('imports a lower seq that was inserted after the cursor moved past it, once', async () => {
    const docs: Doc[] = [remoteDoc(2, new Date())];
    const sync = new MongoSyncWorker(store, { uri: 'mongodb://unused', dbName: 'unused', projectKey: 'team', direction: 'pull' });
    connectFake(sync, docs);

    expect(await sync.syncNow()).toEqual({ pushed: 0, pulled: 1 });

    // Machine A had reserved seq 1 before machine B inserted seq 2, and only now finishes its insert.
    docs.push(remoteDoc(1, new Date(Date.now() - 1000)));
    expect(await sync.syncNow()).toEqual({ pushed: 0, pulled: 1 });
    expect(await store.getEvent('event-1')).not.toBeNull();

    expect(await sync.syncNow()).toEqual({ pushed: 0, pulled: 0 });
  });
});
