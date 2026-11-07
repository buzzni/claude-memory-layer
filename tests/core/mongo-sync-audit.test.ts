/**
 * Mongo sync audit: compares the local store with the shared Mongo collection per source.instanceId, so a document a
 * pull skipped (a pusher that stalled past the late-insert window, or clock skew between machines) shows up as a gap
 * instead of silently never arriving. The shared fake Mongo evaluates the read-only operators the audit sends.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { machineFingerprint } from '../../src/core/machine-id.js';
import { auditMongoSync, type MongoAuditCollection } from '../../src/core/mongo-sync-audit.js';
import {
  MONGO_ORIGIN_ID_TARGET,
  mongoPullCursorTarget,
  mongoPullOriginCursorTarget,
  mongoPushCursorTarget
} from '../../src/core/mongo-sync-worker.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import type { MemoryEvent } from '../../src/core/types.js';
import { FakeMongo } from '../helpers/fake-mongo.js';

type Doc = Record<string, unknown> & { seq: number; eventId: string };

const INSERTED_AT = new Date('2026-10-30T00:00:00.000Z');
/** setCursors records the previous pull at 2026-10-31T00:00Z, so its late-insert window opens 30 minutes before. */
const INSIDE_PULL_WINDOW = new Date('2026-10-30T23:45:00.000Z');

function remoteDoc(seq: number, instanceId: string, hostname: string, insertedAt = new Date(INSERTED_AT.getTime() + seq * 1000)): Doc {
  const eventId = `event-${seq}`;
  return {
    _id: `team:${eventId}`,
    projectKey: 'team',
    seq,
    eventId,
    insertedAt,
    source: { hostname, instanceId }
  };
}

function localEvent(eventId: string, metadata?: Record<string, unknown>): MemoryEvent {
  return {
    ...(metadata ? { metadata } : {}),
    id: eventId,
    eventType: 'user_prompt',
    sessionId: `session-${eventId}`,
    timestamp: INSERTED_AT,
    content: `memory ${eventId}`,
    canonicalKey: `memory ${eventId}`,
    dedupeKey: `dedupe-${eventId}`
  };
}

/** The shared fake records every query, so tests can check the audit never reads documents back. */
function fakeCollection(docs: Doc[]) {
  const mongo = new FakeMongo();
  mongo.events.docs = docs;
  return { collection: mongo.events as unknown as MongoAuditCollection, calls: mongo.events.calls };
}

describe('auditMongoSync', () => {
  let tempDir: string;
  let store: SQLiteEventStore;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cml-mongo-audit-'));
    store = new SQLiteEventStore(path.join(tempDir, 'events.sqlite'));
    await store.initialize();
  });

  afterEach(async () => {
    try { await store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function setCursors(pushRowid: number, pullSeq: number): Promise<void> {
    await store.updateSyncPosition(mongoPushCursorTarget('team'), String(pushRowid), INSERTED_AT.toISOString());
    await store.updateSyncPosition(mongoPullCursorTarget('team'), String(pullSeq), '2026-10-31T00:00:00.000Z');
  }

  it('passes with index-only counts when every Mongo document is already local', async () => {
    await store.importEvents([localEvent('event-1'), localEvent('event-2')]);
    await setCursors(2, 2);
    const { collection, calls } = fakeCollection([
      remoteDoc(1, 'run-a', 'machine-a'),
      remoteDoc(2, 'run-b', 'machine-b')
    ]);

    const report = await auditMongoSync(store, collection, { projectKey: 'team' });

    expect(report).toMatchObject({
      status: 'pass',
      mongoTotal: 2,
      localTotal: 2,
      missing: 0,
      lostBelowPullCursor: 0,
      notYetPulled: 0,
      localOnly: 0,
      instances: []
    });
    expect(calls.every((call) => call.op === 'countDocuments')).toBe(true);
    // Pinned to the eventId index: the planner may otherwise walk { projectKey, seq } and fetch the whole project.
    const idLookups = calls.filter((call) => JSON.stringify(call.arg).includes('$in'));
    expect(idLookups.length).toBeGreaterThan(0);
    expect(idLookups.every((call) => JSON.stringify(call.options) === JSON.stringify({ hint: { projectKey: 1, eventId: 1 } }))).toBe(true);
  });

  it('reports the instance whose documents a pull skipped and the oldest missing seq range', async () => {
    // machine-b reserved seq 3-4, stalled past the late-insert window, and inserted after this machine pulled to 5.
    await store.importEvents([localEvent('event-1'), localEvent('event-2'), localEvent('event-5')]);
    await setCursors(3, 5);
    const { collection } = fakeCollection([
      remoteDoc(1, 'run-a', 'machine-a'),
      remoteDoc(2, 'run-a', 'machine-a'),
      remoteDoc(3, 'run-b', 'machine-b'),
      remoteDoc(4, 'run-b', 'machine-b'),
      remoteDoc(5, 'run-a', 'machine-a'),
      remoteDoc(6, 'run-c', 'machine-c')
    ]);

    const report = await auditMongoSync(store, collection, { projectKey: 'team' });

    expect(report).toMatchObject({
      status: 'fail',
      mongoTotal: 6,
      missing: 3,
      lostBelowPullCursor: 2,
      recoverableByNextPull: 0,
      notYetPulled: 1,
      pullCursor: 5
    });
    expect(report.instances).toEqual([
      expect.objectContaining({ instanceId: 'run-a', hostname: 'machine-a', mongo: 3, local: 3, missing: 0 }),
      expect.objectContaining({ instanceId: 'run-b', hostname: 'machine-b', mongo: 2, local: 0, missing: 2, firstSeq: 3, lastSeq: 4 }),
      expect.objectContaining({ instanceId: 'run-c', hostname: 'machine-c', mongo: 1, local: 0, missing: 1 })
    ]);
    expect(report.oldestGap).toEqual({
      fromSeq: 3,
      toSeq: 4,
      count: 2,
      firstInsertedAt: new Date(INSERTED_AT.getTime() + 3000),
      lastInsertedAt: new Date(INSERTED_AT.getTime() + 4000),
      instances: [{ instanceId: 'run-b', hostname: 'machine-b', count: 2 }]
    });
  });

  it('warns about local events that are not in Mongo yet without treating them as lost', async () => {
    await store.importEvents([localEvent('event-1'), localEvent('local-unpushed')]);
    await setCursors(1, 1);
    const { collection } = fakeCollection([remoteDoc(1, 'run-a', 'machine-a')]);

    const report = await auditMongoSync(store, collection, { projectKey: 'team' });

    expect(report).toMatchObject({
      status: 'warn',
      mongoTotal: 1,
      localTotal: 2,
      missing: 0,
      lostBelowPullCursor: 0,
      localOnly: 1,
      pendingPush: 1
    });
    expect(report.oldestGap).toBeUndefined();
  });

  it('counts a missing document the next pull will still re-read as recoverable, not lost', async () => {
    await store.importEvents([localEvent('event-1'), localEvent('event-3')]);
    await setCursors(2, 3);
    const { collection } = fakeCollection([
      remoteDoc(1, 'run-a', 'machine-a'),
      remoteDoc(2, 'run-b', 'machine-b', INSIDE_PULL_WINDOW),
      remoteDoc(3, 'run-a', 'machine-a')
    ]);

    const report = await auditMongoSync(store, collection, { projectKey: 'team' });

    expect(report).toMatchObject({ status: 'warn', missing: 1, lostBelowPullCursor: 0, recoverableByNextPull: 1 });
    expect(report.oldestGap).toMatchObject({ fromSeq: 2, toSeq: 2, count: 1 });
  });

  it('treats quarantined local events as present and never as pending push', async () => {
    const quarantine = { quarantine: { status: 'active' } };
    await store.importEvents([
      localEvent('event-1'),
      localEvent('event-2', quarantine),
      localEvent('quarantined-unpushed', quarantine)
    ]);
    await setCursors(1, 2);
    const { collection } = fakeCollection([remoteDoc(1, 'run-a', 'machine-a'), remoteDoc(2, 'run-a', 'machine-a')]);

    const report = await auditMongoSync(store, collection, { projectKey: 'team' });

    expect(report).toMatchObject({ status: 'pass', localTotal: 3, missing: 0, localOnly: 0, pendingPush: 0 });
  });

  it('classifies documents with originSeq by their origin cursor instead of the project-wide one', async () => {
    // Global cursor at 6 and every insert far outside the late-insert window: only origin cursors decide.
    await store.importEvents([localEvent('event-1'), localEvent('event-6')]);
    await setCursors(0, 6);
    await store.updateSyncPosition(MONGO_ORIGIN_ID_TARGET, 'origin-self', machineFingerprint());
    await store.updateSyncPosition(mongoPullOriginCursorTarget('team', 'origin-b'), '2', INSERTED_AT.toISOString());
    const withOriginSeq = (doc: Doc, originSeq: number) => ({ ...doc, originSeq });
    const { collection } = fakeCollection([
      withOriginSeq(remoteDoc(1, 'origin-b', 'machine-b'), 1),
      withOriginSeq(remoteDoc(2, 'origin-b', 'machine-b'), 2),
      withOriginSeq(remoteDoc(3, 'origin-b', 'machine-b'), 3),
      withOriginSeq(remoteDoc(4, 'origin-c', 'machine-c'), 1),
      withOriginSeq(remoteDoc(5, 'origin-self', 'this-machine'), 1),
      withOriginSeq(remoteDoc(6, 'origin-b', 'machine-b'), 4)
    ]);

    const report = await auditMongoSync(store, collection, { projectKey: 'team' });

    // origin-b: seq 2 is at its cursor but missing (lost); 3 is past it. origin-c has no cursor yet. Own origin: lost.
    expect(report).toMatchObject({ status: 'fail', missing: 4, lostBelowPullCursor: 2, notYetPulled: 2 });
    expect(report.oldestGap).toBeUndefined();
  });
});
