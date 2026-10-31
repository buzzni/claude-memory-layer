/**
 * Mongo sync audit: compares the local store with the shared Mongo collection per source.instanceId, so a document a
 * pull skipped (a pusher that stalled past the late-insert window, or clock skew between machines) shows up as a gap
 * instead of silently never arriving. The fake collection evaluates only the read-only operators the audit sends.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { auditMongoSync, type MongoAuditCollection } from '../../src/core/mongo-sync-audit.js';
import { mongoPullCursorTarget, mongoPushCursorTarget } from '../../src/core/mongo-sync-worker.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import type { MemoryEvent } from '../../src/core/types.js';

type Doc = Record<string, unknown> & { seq: number; eventId: string };
type Filter = Record<string, unknown>;

const INSERTED_AT = new Date('2026-10-30T00:00:00.000Z');

function remoteDoc(seq: number, instanceId: string, hostname: string, eventId = `event-${seq}`): Doc {
  return {
    _id: `team:${eventId}`,
    projectKey: 'team',
    seq,
    eventId,
    insertedAt: new Date(INSERTED_AT.getTime() + seq * 1000),
    source: { hostname, instanceId }
  };
}

function localEvent(eventId: string): MemoryEvent {
  return {
    id: eventId,
    eventType: 'user_prompt',
    sessionId: `session-${eventId}`,
    timestamp: INSERTED_AT,
    content: `memory ${eventId}`,
    canonicalKey: `memory ${eventId}`,
    dedupeKey: `dedupe-${eventId}`
  };
}

function field(doc: Record<string, unknown>, fieldPath: string): unknown {
  return fieldPath.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], doc);
}

function matches(doc: Doc, filter: Filter): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    const value = field(doc, key);
    if (typeof condition !== 'object' || condition === null) return value === condition;
    const ops = condition as Record<string, unknown>;
    if (ops.$in && !(ops.$in as unknown[]).includes(value)) return false;
    if (ops.$gt !== undefined && !((value as number) > (ops.$gt as number))) return false;
    if (ops.$gte !== undefined && !((value as number) >= (ops.$gte as number))) return false;
    if (ops.$lte !== undefined && !((value as number) <= (ops.$lte as number))) return false;
    return true;
  });
}

function accumulate(rows: Doc[], spec: Record<string, unknown>): unknown {
  const [op, arg] = Object.entries(spec)[0];
  const values = rows.map((row) => (typeof arg === 'string' ? field(row, arg.slice(1)) : arg));
  if (op === '$sum') return values.reduce<number>((sum, v) => sum + (v as number), 0);
  if (op === '$first') return values[0] ?? null;
  if (op === '$push') return values;
  const sorted = [...values].sort((a, b) => Number(a) - Number(b));
  return op === '$min' ? sorted[0] : sorted[sorted.length - 1];
}

/** Records every query so tests can check the audit never reads documents back, only counts and grouped rows. */
function fakeCollection(docs: Doc[]) {
  const calls: Array<{ op: 'countDocuments' | 'aggregate'; arg: unknown; options?: unknown }> = [];
  const collection: MongoAuditCollection = {
    countDocuments: async (filter, options) => {
      calls.push({ op: 'countDocuments', arg: filter, options });
      return docs.filter((doc) => matches(doc, filter)).length;
    },
    aggregate: (pipeline, options) => {
      calls.push({ op: 'aggregate', arg: pipeline, options });
      return {
        toArray: async () => {
          const [{ $match }, { $group }] = pipeline as [{ $match: Filter }, { $group: Record<string, unknown> }];
          const groups = new Map<unknown, Doc[]>();
          for (const doc of docs.filter((d) => matches(d, $match))) {
            const key = field(doc, String($group._id).slice(1)) ?? null;
            groups.set(key, [...(groups.get(key) ?? []), doc]);
          }
          return [...groups].map(([key, rows]) => Object.fromEntries([
            ['_id', key],
            ...Object.entries($group).filter(([name]) => name !== '_id')
              .map(([name, spec]) => [name, accumulate(rows, spec as Record<string, unknown>)])
          ])) as never[];
        }
      };
    }
  };
  return { collection, calls };
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
});
