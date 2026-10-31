/**
 * Mongo Sync Audit
 * Read-only check that the local store holds every document the shared Mongo collection has for a project key,
 * broken down by the pusher's source.instanceId.
 *
 * Pull reads past a single seq cursor and re-reads only a 30-minute window below it, comparing the puller's clock with
 * the pusher's insertedAt. A pusher that stalls between reserving and inserting its seq range, or clock skew beyond
 * the window, leaves documents below the cursor that no later pull reads. This audit makes that loss visible.
 *
 * Cost: the common no-gap case sends only countDocuments on { projectKey } and { projectKey, eventId: { $in } },
 * which the sync worker's indexes answer without fetching documents. Only when counts differ does it group by
 * instanceId (an index-bounded fetch of the project's documents, never a collection scan) and bisect seq ranges with
 * index-only counts.
 */

import type { MemoryEvent } from './types.js';
import { LATE_INSERT_WINDOW_MS, mongoPullCursorTarget, mongoPushCursorTarget, parseIntOrZero } from './mongo-sync-worker.js';

export interface MongoAuditCollection {
  countDocuments(filter: Record<string, unknown>, options?: { hint?: Record<string, number> }): Promise<number>;
  aggregate(pipeline: Record<string, unknown>[], options?: { hint?: Record<string, number> }): { toArray(): Promise<unknown[]> };
}

export interface MongoAuditLocalStore {
  getSyncPosition(targetName: string): Promise<{ lastEventId: string | null; lastTimestamp: string | null }>;
  getEventsSinceRowid(lastRowid: number, limit: number): Promise<Array<{ rowid: number; event: MemoryEvent }>>;
}

export interface MongoSyncInstanceAudit {
  instanceId: string | null;
  hostname: string | null;
  mongo: number;
  local: number;
  missing: number;
  firstSeq: number;
  lastSeq: number;
  firstInsertedAt: Date;
  lastInsertedAt: Date;
}

export interface MongoSyncGap {
  fromSeq: number;
  toSeq: number;
  count: number;
  firstInsertedAt: Date;
  lastInsertedAt: Date;
  instances: Array<{ instanceId: string | null; hostname: string | null; count: number }>;
}

export interface MongoSyncAuditReport {
  /** fail: documents below the pull cursor that no pull will read; warn: the next push or pull closes the difference. */
  status: 'pass' | 'warn' | 'fail';
  projectKey: string;
  mongoTotal: number;
  localTotal: number;
  /** Mongo documents whose eventId is not in the local store. */
  missing: number;
  lostBelowPullCursor: number;
  notYetPulled: number;
  /** Local events Mongo does not have; pendingPush of them are past the push cursor. */
  localOnly: number;
  pendingPush: number;
  pushCursor: number;
  pullCursor: number;
  /** The late-insert window of the next pull re-reads documents below the cursor inserted at or after this time. */
  pullWindowStart: Date | null;
  /** Filled only when documents are missing; sorted by first seq. */
  instances: MongoSyncInstanceAudit[];
  /** The oldest run of consecutive missing documents below the pull cursor. */
  oldestGap?: MongoSyncGap;
}

interface InstanceGroupRow {
  _id: string | null;
  hostname: string | null;
  count: number;
  firstSeq: number;
  lastSeq: number;
  firstInsertedAt: Date;
  lastInsertedAt: Date;
}

const LOCAL_PAGE_SIZE = 1000;
/**
 * The sync worker's unique index. Without the hint the planner can pick { projectKey, seq } for an eventId $in
 * (it returns early matches during plan trials) and then fetch every document of the project per page.
 */
const EVENT_ID_INDEX = { projectKey: 1, eventId: 1 };

function instanceGroupPipeline(match: Record<string, unknown>): Record<string, unknown>[] {
  return [
    { $match: match },
    {
      $group: {
        _id: '$source.instanceId',
        hostname: { $first: '$source.hostname' },
        count: { $sum: 1 },
        firstSeq: { $min: '$seq' },
        lastSeq: { $max: '$seq' },
        firstInsertedAt: { $min: '$insertedAt' },
        lastInsertedAt: { $max: '$insertedAt' }
      }
    }
  ];
}

/** Number of values in the sorted array that are <= bound. */
function countAtMost(sorted: number[], bound: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= bound) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export async function auditMongoSync(
  local: MongoAuditLocalStore,
  remote: MongoAuditCollection,
  options: { projectKey: string }
): Promise<MongoSyncAuditReport> {
  const { projectKey } = options;
  const pushCursor = parseIntOrZero((await local.getSyncPosition(mongoPushCursorTarget(projectKey))).lastEventId);
  const pullPosition = await local.getSyncPosition(mongoPullCursorTarget(projectKey));
  const pullCursor = parseIntOrZero(pullPosition.lastEventId);
  const previousPullAt = pullPosition.lastTimestamp ? new Date(pullPosition.lastTimestamp) : null;
  const pullWindowStart = previousPullAt && !Number.isNaN(previousPullAt.getTime())
    ? new Date(previousPullAt.getTime() - LATE_INSERT_WINDOW_MS)
    : null;

  const countInMongo = async (ids: string[]): Promise<number> =>
    ids.length === 0 ? 0 : remote.countDocuments({ projectKey, eventId: { $in: ids } }, { hint: EVENT_ID_INDEX });

  // Same rows push reads (quarantined events are never pushed), split at the push cursor.
  const idPages: string[][] = [];
  let localTotal = 0;
  let matched = 0;
  let pendingPush = 0;
  let lastRowid = 0;
  while (true) {
    const batch = await local.getEventsSinceRowid(lastRowid, LOCAL_PAGE_SIZE);
    if (batch.length === 0) break;
    const pushed = batch.filter((item) => item.rowid <= pushCursor).map((item) => item.event.id);
    const unpushed = batch.filter((item) => item.rowid > pushCursor).map((item) => item.event.id);
    const unpushedFound = await countInMongo(unpushed);
    matched += await countInMongo(pushed) + unpushedFound;
    pendingPush += unpushed.length - unpushedFound;
    idPages.push(batch.map((item) => item.event.id));
    localTotal += batch.length;
    lastRowid = batch[batch.length - 1].rowid;
    if (batch.length < LOCAL_PAGE_SIZE) break;
  }

  const mongoTotal = await remote.countDocuments({ projectKey });
  const missing = mongoTotal - matched;
  const localOnly = localTotal - matched;
  const report: MongoSyncAuditReport = {
    status: localOnly > 0 ? 'warn' : 'pass',
    projectKey,
    mongoTotal,
    localTotal,
    missing,
    lostBelowPullCursor: 0,
    notYetPulled: 0,
    localOnly,
    pendingPush,
    pushCursor,
    pullCursor,
    pullWindowStart,
    instances: []
  };
  if (missing <= 0) return report;

  const groups = await remote.aggregate(instanceGroupPipeline({ projectKey })).toArray() as InstanceGroupRow[];
  const localByInstance = new Map<string | null, number>();
  const localSeqs: number[] = [];
  for (const ids of idPages) {
    const rows = await remote.aggregate([
      { $match: { projectKey, eventId: { $in: ids } } },
      { $group: { _id: '$source.instanceId', seqs: { $push: '$seq' } } }
    ], { hint: EVENT_ID_INDEX }).toArray() as Array<{ _id: string | null; seqs: number[] }>;
    for (const row of rows) {
      localByInstance.set(row._id, (localByInstance.get(row._id) ?? 0) + row.seqs.length);
      localSeqs.push(...row.seqs);
    }
  }
  localSeqs.sort((a, b) => a - b);

  report.instances = groups
    .map((group) => {
      const localCount = localByInstance.get(group._id) ?? 0;
      return {
        instanceId: group._id,
        hostname: group.hostname,
        mongo: group.count,
        local: localCount,
        missing: group.count - localCount,
        firstSeq: group.firstSeq,
        lastSeq: group.lastSeq,
        firstInsertedAt: group.firstInsertedAt,
        lastInsertedAt: group.lastInsertedAt
      };
    })
    .sort((a, b) => a.firstSeq - b.firstSeq);

  // Counted on each side of the cursor separately, so a push landing above it during the audit cannot mask a loss.
  const localBelow = countAtMost(localSeqs, pullCursor);
  const mongoBelow = await remote.countDocuments({ projectKey, seq: { $lte: pullCursor } });
  const mongoAbove = await remote.countDocuments({ projectKey, seq: { $gt: pullCursor } });
  report.lostBelowPullCursor = mongoBelow - localBelow;
  report.notYetPulled = mongoAbove - (localSeqs.length - localBelow);
  report.status = report.lostBelowPullCursor > 0 ? 'fail' : 'warn';
  if (report.lostBelowPullCursor > 0) {
    report.oldestGap = await findOldestGap(remote, projectKey, localSeqs, pullCursor);
  }
  return report;
}

/**
 * Local seqs are a subset of Mongo's, so a range holds a missing document exactly when Mongo counts more documents in
 * it than the local store has. Bisecting on that finds the oldest missing seq with index-only counts; the gap then
 * runs up to the next seq the local store has.
 */
async function findOldestGap(
  remote: MongoAuditCollection,
  projectKey: string,
  localSeqs: number[],
  pullCursor: number
): Promise<MongoSyncGap | undefined> {
  const hasMissing = async (from: number, to: number): Promise<boolean> => {
    const mongoCount = await remote.countDocuments({ projectKey, seq: { $gte: from, $lte: to } });
    return mongoCount > countAtMost(localSeqs, to) - countAtMost(localSeqs, from - 1);
  };

  let lo = 1;
  let hi = pullCursor;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await hasMissing(lo, mid)) hi = mid;
    else lo = mid + 1;
  }

  const nextLocalIndex = countAtMost(localSeqs, lo);
  const end = nextLocalIndex < localSeqs.length ? Math.min(localSeqs[nextLocalIndex] - 1, pullCursor) : pullCursor;
  const rows = await remote.aggregate(
    instanceGroupPipeline({ projectKey, seq: { $gte: lo, $lte: end } })
  ).toArray() as InstanceGroupRow[];
  if (rows.length === 0) return undefined;

  return {
    fromSeq: Math.min(...rows.map((row) => row.firstSeq)),
    toSeq: Math.max(...rows.map((row) => row.lastSeq)),
    count: rows.reduce((sum, row) => sum + row.count, 0),
    firstInsertedAt: new Date(Math.min(...rows.map((row) => new Date(row.firstInsertedAt).getTime()))),
    lastInsertedAt: new Date(Math.max(...rows.map((row) => new Date(row.lastInsertedAt).getTime()))),
    instances: rows
      .sort((a, b) => a.firstSeq - b.firstSeq)
      .map((row) => ({ instanceId: row._id, hostname: row.hostname, count: row.count }))
  };
}
