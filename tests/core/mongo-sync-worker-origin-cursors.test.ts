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

/** The machine the next worker resolves its origin on; tests switch it to put two stores on different machines. */
const host = vi.hoisted(() => ({ machine: 'machine-default' }));
vi.mock('../../src/core/machine-id.js', () => ({ machineFingerprint: () => host.machine }));

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
    host.machine = 'machine-default';
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

  /** Copies a store directory as a backup restore or a cloned home directory would, onto another machine. */
  async function copyOf(m: { store: SQLiteEventStore; dir: string }, name: string): Promise<{ store: SQLiteEventStore; dir: string }> {
    await m.store.close();
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), `cml-mongo-origin-${name}-`));
    tempDirs.push(copy);
    for (const file of fs.readdirSync(m.dir)) fs.copyFileSync(path.join(m.dir, file), path.join(copy, file));
    m.store = new SQLiteEventStore(path.join(m.dir, 'events.sqlite'));
    const store = new SQLiteEventStore(path.join(copy, 'events.sqlite'));
    stores.push(m.store, store);
    return { store, dir: copy };
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

  it('loses nothing when a pusher stalls more than 30 minutes between reserving and inserting its seqs', async () => {
    const a = await machine('a');
    const b = await machine('b');
    const c = await machine('c');
    const stalled = createGate();
    const aEvent = await remember(a.store, 'from a');
    await remember(b.store, 'from b');

    // A reserves its seqs at T0 and then sleeps (laptop lid closed) before its bulkWrite reaches Mongo.
    const aPush = worker(a, 'push', { beforeBulkWrite: stalled.wait }).syncNow();
    await stalled.reached;

    vi.setSystemTime(minutes(1));
    expect(await worker(b, 'push').syncNow()).toEqual({ pushed: 1, pulled: 0 });

    const puller = worker(c, 'pull');
    vi.setSystemTime(minutes(2));
    expect(await puller.syncNow()).toEqual({ pushed: 0, pulled: 1 });
    vi.setSystemTime(minutes(35));
    expect(await puller.syncNow()).toEqual({ pushed: 0, pulled: 0 });

    vi.setSystemTime(minutes(40));
    stalled.release();
    expect(await aPush).toEqual({ pushed: 1, pulled: 0 });

    vi.setSystemTime(minutes(41));
    expect(await puller.syncNow()).toEqual({ pushed: 0, pulled: 1 });
    expect(await c.store.getEvent(aEvent)).not.toBeNull();
  });

  it('loses nothing when the pusher clock is more than 30 minutes behind the puller', async () => {
    const a = await machine('a');
    const b = await machine('b');
    const c = await machine('c');
    const slowInsert = createGate();
    const aEvent = await remember(a.store, 'from a');
    await remember(b.store, 'from b');

    // A's clock runs 40 minutes behind; its insert lands just after B's, which C has already pulled past.
    vi.setSystemTime(minutes(-40));
    const aPush = worker(a, 'push', { beforeBulkWrite: slowInsert.wait }).syncNow();
    await slowInsert.reached;

    vi.setSystemTime(minutes(0));
    expect(await worker(b, 'push').syncNow()).toEqual({ pushed: 1, pulled: 0 });
    const puller = worker(c, 'pull');
    expect(await puller.syncNow()).toEqual({ pushed: 0, pulled: 1 });

    vi.setSystemTime(minutes(-40));
    slowInsert.release();
    expect(await aPush).toEqual({ pushed: 1, pulled: 0 });

    vi.setSystemTime(minutes(1));
    expect(await puller.syncNow()).toEqual({ pushed: 0, pulled: 1 });
    expect(await c.store.getEvent(aEvent)).not.toBeNull();
  });

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

  it('numbers the documents of one origin consecutively and records the latest in cml_origins', async () => {
    const a = await machine('a');
    await remember(a.store, 'first');
    await worker(a, 'push').syncNow();
    await remember(a.store, 'second');
    await worker(a, 'push').syncNow();

    const docs = mongo.events.docs;
    expect(docs.map((doc) => doc.originSeq)).toEqual([1, 2]);
    // The global seq stays, so pullers on older versions keep reading new documents.
    expect(docs.map((doc) => doc.seq)).toEqual([1, 2]);
    expect(mongo.origins.docs).toEqual([
      expect.objectContaining({ projectKey: 'team', origin: docs[0].source.instanceId, maxOriginSeq: 2 })
    ]);
  });

  it('never pushes pulled events back under its own origin', async () => {
    const a = await machine('a');
    const c = await machine('c');
    await remember(a.store, 'from a');
    await worker(a, 'push').syncNow();

    const both = worker(c, 'both');
    expect(await both.syncNow()).toEqual({ pushed: 0, pulled: 1 });
    expect(await both.syncNow()).toEqual({ pushed: 0, pulled: 0 });

    expect(mongo.events.docs).toHaveLength(1);
    expect(mongo.counters.docs.map((doc) => doc._id).sort()).toEqual([
      'events:team',
      `events:team:${mongo.events.docs[0].source.instanceId}`
    ]);
  });

  it('still pulls documents from pushers on older versions, including one inserted late below the cursor', async () => {
    const c = await machine('c');
    const puller = worker(c, 'pull');
    mongo.insertLegacyDoc('team', 2, minutes(0));
    expect(await puller.syncNow()).toEqual({ pushed: 0, pulled: 1 });

    vi.setSystemTime(minutes(1));
    mongo.insertLegacyDoc('team', 1, minutes(0));
    expect(await puller.syncNow()).toEqual({ pushed: 0, pulled: 1 });
    expect(await c.store.getEvent('legacy-1')).not.toBeNull();
  });

  it('re-pulls everything once at cutover, recovering a document the global cursor had skipped', async () => {
    const c = await machine('c');
    // Before the upgrade: pulled through seq 5 an hour ago, but seq 3 came in late and outside the window.
    for (const seq of [1, 2, 3, 4, 5]) mongo.insertLegacyDoc('team', seq, minutes(-120));
    await c.store.importEvents(mongo.events.docs.filter((doc) => doc.seq !== 3).map((doc) => ({
      id: doc.eventId,
      eventType: doc.eventType,
      sessionId: doc.sessionId,
      timestamp: doc.timestamp,
      content: doc.content,
      canonicalKey: doc.canonicalKey,
      dedupeKey: doc.dedupeKey
    })));
    await c.store.updateSyncPosition(mongoPullCursorTarget('team'), '5', minutes(-60).toISOString());
    const audit = () => auditMongoSync(c.store, mongo.events as unknown as MongoAuditCollection, { projectKey: 'team' });
    expect(await audit()).toMatchObject({ status: 'fail', lostBelowPullCursor: 1 });

    const puller = worker(c, 'pull');
    expect(await puller.syncNow()).toEqual({ pushed: 0, pulled: 1 });
    expect(await c.store.getEvent('legacy-3')).not.toBeNull();
    expect(await audit()).toMatchObject({ status: 'pass', missing: 0, lostBelowPullCursor: 0 });

    // The reset runs once per store and project key: the next pull reads nothing it already has.
    mongo.events.returned = 0;
    vi.setSystemTime(minutes(1));
    expect(await worker(c, 'pull').syncNow()).toEqual({ pushed: 0, pulled: 0 });
    expect(mongo.events.returned).toBe(0);
  });

  it('audits a document of a stalled origin as not pulled yet rather than lost below the cursor', async () => {
    const a = await machine('a');
    const b = await machine('b');
    const c = await machine('c');
    const stalled = createGate();
    await remember(a.store, 'from a');
    await remember(b.store, 'from b');

    const aPush = worker(a, 'push', { beforeBulkWrite: stalled.wait }).syncNow();
    await stalled.reached;
    vi.setSystemTime(minutes(1));
    await worker(b, 'push').syncNow();
    const puller = worker(c, 'pull');
    await puller.syncNow();
    vi.setSystemTime(minutes(40));
    await puller.syncNow();
    stalled.release();
    await aPush;

    const report = await auditMongoSync(c.store, mongo.events as unknown as MongoAuditCollection, { projectKey: 'team' });
    expect(report).toMatchObject({ status: 'warn', missing: 1, lostBelowPullCursor: 0, notYetPulled: 1 });

    await puller.syncNow();
    expect(await auditMongoSync(c.store, mongo.events as unknown as MongoAuditCollection, { projectKey: 'team' }))
      .toMatchObject({ status: 'pass', missing: 0, lostBelowPullCursor: 0 });
  });

  it('gives a store copied to another machine its own origin, so both keep syncing with each other', async () => {
    host.machine = 'machine-1';
    const e1 = await machine('e1');
    await remember(e1.store, 'before copy');
    await worker(e1, 'push').syncNow();
    const e2 = await copyOf(e1, 'e2');

    host.machine = 'machine-2';
    const e2Event = await remember(e2.store, 'on the copy');
    expect(await worker(e2, 'both').syncNow()).toEqual({ pushed: 1, pulled: 0 });

    host.machine = 'machine-1';
    const e1Event = await remember(e1.store, 'on the original');
    expect(await worker(e1, 'both').syncNow()).toEqual({ pushed: 1, pulled: 1 });
    expect(await e1.store.getEvent(e2Event)).not.toBeNull();

    // The original keeps its origin; the copy got a new one.
    const originOf = (eventId: string) => mongo.events.docs.find((doc) => doc.eventId === eventId)?.source.instanceId;
    expect(originOf(e1Event)).toBe(mongo.events.docs[0].source.instanceId);
    expect(originOf(e2Event)).not.toBe(originOf(e1Event));

    host.machine = 'machine-2';
    expect(await worker(e2, 'both').syncNow()).toEqual({ pushed: 0, pulled: 1 });
    expect(await e2.store.getEvent(e1Event)).not.toBeNull();
  });

  it('loses nothing when the original and its copy push while a third machine pulls', async () => {
    host.machine = 'machine-1';
    const e1 = await machine('e1');
    const c = await machine('c');
    await remember(e1.store, 'before copy');
    await worker(e1, 'push').syncNow();
    const e2 = await copyOf(e1, 'e2');

    const stalled = createGate();
    const e1Event = await remember(e1.store, 'on the original');
    const e1Push = worker(e1, 'push', { beforeBulkWrite: stalled.wait }).syncNow();
    await stalled.reached;

    host.machine = 'machine-2';
    await remember(e2.store, 'on the copy');
    expect(await worker(e2, 'push').syncNow()).toEqual({ pushed: 1, pulled: 0 });

    host.machine = 'machine-3';
    const puller = worker(c, 'pull');
    expect(await puller.syncNow()).toEqual({ pushed: 0, pulled: 2 });
    stalled.release();
    await e1Push;
    expect(await puller.syncNow()).toEqual({ pushed: 0, pulled: 1 });
    expect(await c.store.getEvent(e1Event)).not.toBeNull();
    expect(await auditMongoSync(c.store, mongo.events as unknown as MongoAuditCollection, { projectKey: 'team' }))
      .toMatchObject({ status: 'pass', missing: 0, lostBelowPullCursor: 0 });
  });

  it('rebuilds origins missing from cml_origins from the documents themselves', async () => {
    const a = await machine('a');
    const b = await machine('b');
    const c = await machine('c');
    await remember(a.store, 'from a');
    await remember(b.store, 'from b');
    await worker(a, 'push').syncNow();
    await worker(b, 'push').syncNow();
    const originA = mongo.events.docs[0].source.instanceId;

    // cml_origins lost A's row (dropped collection, restore of cml_events only): A's documents must stay reachable.
    mongo.origins.docs = mongo.origins.docs.filter((doc) => doc.origin !== originA);
    expect(await worker(c, 'pull').syncNow()).toEqual({ pushed: 0, pulled: 2 });
    expect(mongo.origins.docs).toContainEqual(expect.objectContaining({ projectKey: 'team', origin: originA, maxOriginSeq: 1 }));

    mongo.origins.docs = [];
    await remember(a.store, 'from a again');
    await worker(a, 'push').syncNow();
    mongo.origins.docs = [];
    expect(await worker(c, 'pull').syncNow()).toEqual({ pushed: 0, pulled: 1 });
  });
});
