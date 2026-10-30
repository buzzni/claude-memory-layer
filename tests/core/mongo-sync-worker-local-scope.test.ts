/**
 * Mongo sync pull: events written on another machine carry that machine's project scope (its path hash), so strict
 * project-scoped search on this machine filtered every pulled event out. Pull re-homes them to the local project.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { MongoSyncWorker } from '../../src/core/mongo-sync-worker.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

function remoteDoc(seq: number, metadata: Record<string, unknown> | null) {
  return {
    _id: `team-project:event-${seq}`,
    projectKey: 'team-project',
    seq,
    eventId: `event-${seq}`,
    eventType: 'user_prompt',
    sessionId: 'session-from-machine-a',
    timestamp: new Date('2026-10-30T01:00:00.000Z'),
    content: `remote memory ${seq}`,
    canonicalKey: `remote memory ${seq}`,
    dedupeKey: `dedupe-${seq}`,
    metadata,
    insertedAt: new Date(),
    updatedAt: new Date(),
    source: { hostname: 'machine-a' }
  };
}

/** Stands in for the connected Mongo collections so `syncNow` runs its real pull loop against SQLite. */
function connectFake(worker: MongoSyncWorker, docs: ReturnType<typeof remoteDoc>[]): void {
  const fake = worker as unknown as Record<string, unknown>;
  fake.client = {};
  fake.db = {};
  fake.counters = {};
  fake.events = {
    createIndex: async () => undefined,
    find: (filter: { seq: { $gt: number } }) => ({
      toArray: async () => docs.filter((doc) => doc.seq > filter.seq.$gt)
    })
  };
}

describe('MongoSyncWorker pull re-homes events to the local project', () => {
  let tempDir: string;
  let store: SQLiteEventStore;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cml-mongo-local-scope-'));
    store = new SQLiteEventStore(path.join(tempDir, 'events.sqlite'));
    await store.initialize();
  });

  afterEach(async () => {
    try { await store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function worker(localProject?: { hash: string; path: string }): MongoSyncWorker {
    return new MongoSyncWorker(store, {
      uri: 'mongodb://unused',
      dbName: 'unused',
      projectKey: 'team-project',
      direction: 'pull',
      localProject
    });
  }

  it('replaces the origin project scope and tag with the local project and keeps the origin', async () => {
    const sync = worker({ hash: 'bbbbbbbb', path: '/home/b/work/proj' });
    connectFake(sync, [remoteDoc(1, {
      scope: { project: { hash: 'aaaaaaaa', path: '/home/a/proj' } },
      tags: ['proj:aaaaaaaa', 'topic:build'],
      importedFrom: 'claude'
    })]);

    expect(await sync.syncNow()).toEqual({ pushed: 0, pulled: 1 });

    const event = await store.getEvent('event-1');
    expect(event?.metadata).toEqual({
      scope: { project: { hash: 'bbbbbbbb', path: '/home/b/work/proj' } },
      tags: ['proj:bbbbbbbb', 'topic:build'],
      importedFrom: 'claude',
      mongoSync: { originProject: { hash: 'aaaaaaaa', path: '/home/a/proj' }, originHostname: 'machine-a' }
    });
  });

  it('gives events without any project scope the local project', async () => {
    const sync = worker({ hash: 'bbbbbbbb', path: '/home/b/work/proj' });
    connectFake(sync, [remoteDoc(1, null)]);

    await sync.syncNow();

    const event = await store.getEvent('event-1');
    expect(event?.metadata).toEqual({
      scope: { project: { hash: 'bbbbbbbb', path: '/home/b/work/proj' } },
      tags: ['proj:bbbbbbbb'],
      mongoSync: { originHostname: 'machine-a' }
    });
  });

  it('leaves pulled metadata as it was when no local project is configured', async () => {
    const sync = worker();
    const metadata = { scope: { project: { hash: 'aaaaaaaa' } }, tags: ['proj:aaaaaaaa'] };
    connectFake(sync, [remoteDoc(1, metadata)]);

    await sync.syncNow();

    expect((await store.getEvent('event-1'))?.metadata).toEqual(metadata);
  });
});
