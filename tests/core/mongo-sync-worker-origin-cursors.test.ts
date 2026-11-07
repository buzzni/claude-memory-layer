/**
 * Mongo sync pull reads each pusher (origin) past its own cursor instead of one project-wide seq cursor plus a
 * 30-minute re-read window. The window compared the puller's clock with the pusher's insertedAt, so a pusher that
 * stalled between reserving and inserting its seqs, or a clock skewed past the window, left documents below the
 * cursor that no later pull read (#142).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { auditMongoSync, type MongoAuditCollection } from '../../src/core/mongo-sync-audit.js';
import { mongoPullCursorTarget, MongoSyncWorker, type MongoSyncDirection } from '../../src/core/mongo-sync-worker.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { WorkerLock } from '../../src/core/worker-lock.js';
import { connectFakeMongo, createGate, FakeMongo, type FakeMongoHooks } from '../helpers/fake-mongo.js';

const T0 = new Date('2026-11-01T00:00:00.000Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

describe('MongoSyncWorker per-origin pull cursors', () => {
  let tempDirs: string[];
  let stores: SQLiteEventStore[];
  let mongo: FakeMongo;

  beforeEach(() => {
    tempDirs = [];
    stores = [];
    mongo = new FakeMongo();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const store of stores) {
      try { await store.close(); } catch {}
    }
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function machine(name: string): Promise<{ store: SQLiteEventStore; dir: string }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cml-mongo-origin-${name}-`));
    tempDirs.push(dir);
    const store = new SQLiteEventStore(path.join(dir, 'events.sqlite'));
    await store.initialize();
    stores.push(store);
    return { store, dir };
  }

  function worker(
    m: { store: SQLiteEventStore; dir: string },
    direction: MongoSyncDirection,
    hooks: FakeMongoHooks = {}
  ): MongoSyncWorker {
    const sync = new MongoSyncWorker(m.store, {
      uri: 'mongodb://unused',
      dbName: 'unused',
      projectKey: 'team',
      direction,
      pushLockPath: path.join(m.dir, 'mongo-sync-push.lock')
    } as ConstructorParameters<typeof MongoSyncWorker>[1]);
    connectFakeMongo(sync, mongo, hooks);
    return sync;
  }

  async function remember(store: SQLiteEventStore, content: string): Promise<string> {
    const result = await store.append({ eventType: 'user_prompt', sessionId: `session-${content}`, timestamp: new Date(), content });
    if (!result.success) throw new Error('append failed');
    return result.eventId;
  }

  it('keeps one origin id per store across worker restarts', async () => {
    const a = await machine('a');
    await remember(a.store, 'first');
    await worker(a, 'push').syncNow();
    await remember(a.store, 'second');
    await worker(a, 'push').syncNow();

    const docs = mongo.events.docs;
    expect(docs).toHaveLength(2);
    expect(new Set(docs.map((doc) => doc.source.instanceId)).size).toBe(1);
  });

  it('skips a push while another process holds the store push lock', async () => {
    const a = await machine('a');
    await remember(a.store, 'first');
    const held = new WorkerLock(path.join(a.dir, 'mongo-sync-push.lock'), { pid: process.pid });
    expect(held.acquire().acquired).toBe(true);

    expect(await worker(a, 'push').syncNow()).toEqual({ pushed: 0, pulled: 0 });
    held.release();
    expect(await worker(a, 'push').syncNow()).toEqual({ pushed: 1, pulled: 0 });
  });
});
