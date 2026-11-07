/**
 * Mongo Sync Worker
 * Optional: sync per-project SQLite events to a shared MongoDB database.
 *
 * Design goals:
 * - Optional and decoupled (doesn't affect default local-only flow)
 * - Idempotent (safe to retry)
 * - Incremental push (SQLite rowid) and incremental pull (one Mongo originSeq cursor per pushing store)
 *
 * NOTE:
 * - We only sync immutable L0 events (events table). Derived tables can be rebuilt.
 */

import { randomUUID } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { MongoClient } from 'mongodb';
import type { Collection, Db } from 'mongodb';

import type { MemoryEvent } from './types.js';
import { SQLiteEventStore } from './sqlite-event-store.js';
import { machineFingerprint } from './machine-id.js';
import { describeMongoConnectionError, redactMongoUri } from './mongo-sync-config.js';
import { WorkerLock } from './worker-lock.js';

export type MongoSyncDirection = 'push' | 'pull' | 'both';

export interface MongoSyncWorkerConfig {
  uri: string;
  dbName: string;
  projectKey: string;
  direction?: MongoSyncDirection;
  intervalMs?: number;
  batchSize?: number;
  /** This store's origin (source.instanceId on pushed documents). Defaults to the id persisted in the store. */
  instanceId?: string;
  /** Lock that keeps two processes from pushing for the same store at once. Defaults to one per origin in tmpdir. */
  pushLockPath?: string;
  /**
   * This machine's project. Pulled events carry the scope of the machine that wrote them (its path hash), which
   * project-scoped search here filters out, so pull re-homes them to this project and keeps the origin under
   * `metadata.mongoSync`. Left unset, pulled metadata is stored as received.
   */
  localProject?: { hash: string; path?: string };
}

export interface MongoSyncStats {
  lastSyncAt: Date | null;
  pushedEvents: number;
  pulledEvents: number;
  errors: number;
  status: 'idle' | 'syncing' | 'error' | 'stopped';
}

interface CounterDoc {
  _id: string;
  seq: number;
}

/** One row per (project key, origin): lists the origins a pull reads and the highest originSeq each has reserved. */
interface OriginDoc {
  _id: string;
  projectKey: string;
  origin: string;
  maxOriginSeq: number;
  hostname?: string;
  updatedAt?: Date;
}

interface RemoteEventDoc {
  _id: string;
  projectKey: string;
  /** Project-wide seq. Older versions pull by it alone, so every pusher still assigns it. */
  seq: number;
  /** Seq within source.instanceId, assigned by versions with per-origin pull cursors; absent on older pushers' docs. */
  originSeq?: number;
  eventId: string;
  eventType: string;
  sessionId: string;
  timestamp: Date;
  content: string;
  canonicalKey: string;
  dedupeKey: string;
  metadata?: Record<string, unknown> | null;
  insertedAt: Date;
  updatedAt: Date;
  source?: {
    hostname?: string;
    instanceId?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function localizePulledMetadata(
  doc: RemoteEventDoc,
  localProject: { hash: string; path?: string }
): Record<string, unknown> {
  const metadata = isRecord(doc.metadata) ? { ...doc.metadata } : {};
  const scope = isRecord(metadata.scope) ? { ...metadata.scope } : {};
  const originProject = isRecord(scope.project) ? scope.project : undefined;
  if (originProject?.hash === localProject.hash) return metadata;

  scope.project = { ...originProject, hash: localProject.hash, ...(localProject.path ? { path: localProject.path } : {}) };
  metadata.scope = scope;
  const originTag = typeof originProject?.hash === 'string' ? `proj:${originProject.hash}` : null;
  const localTag = `proj:${localProject.hash}`;
  const tags = (Array.isArray(metadata.tags) ? metadata.tags : []).map((tag) => (tag === originTag ? localTag : tag));
  metadata.tags = tags.includes(localTag) ? tags : [...tags, localTag];
  metadata.mongoSync = {
    ...(originProject ? { originProject } : {}),
    ...(doc.source?.hostname ? { originHostname: doc.source.hostname } : {})
  };
  return metadata;
}

/** How far before the previous pull a late insert below the cursor is still picked up (concurrent pushers, clock skew). */
export const LATE_INSERT_WINDOW_MS = 30 * 60 * 1000;

/**
 * sync_positions row holding this store's origin id (last_event_id) and the machine it belongs to (last_timestamp
 * holds machineFingerprint()), created once and kept, so every push from the store, across restarts and project
 * keys, carries the same source.instanceId. A store copied or restored onto another machine mints a new id there:
 * two stores pushing under one origin would skip each other's documents as their own and could interleave seqs.
 */
export const MONGO_ORIGIN_ID_TARGET = 'mongo_sync_origin_id';

/** sync_positions row holding the last local rowid pushed for a project key. */
export function mongoPushCursorTarget(projectKey: string): string {
  return `mongo_push_events_rowid:${projectKey}`;
}

/**
 * sync_positions row holding the last project-wide Mongo seq pulled (and when that pull started) for a project key.
 * Since per-origin cursors it covers only documents without originSeq, i.e. from pushers on older versions.
 */
export function mongoPullCursorTarget(projectKey: string): string {
  return `mongo_pull_events_seq:${projectKey}`;
}

/** sync_positions row holding the last originSeq pulled from one origin for a project key. */
export function mongoPullOriginCursorTarget(projectKey: string, origin: string): string {
  return `mongo_pull_events_origin:${projectKey}:${origin}`;
}

/**
 * sync_positions row marking that the project-wide pull cursor was reset once when this store moved to per-origin
 * cursors, so every document already in Mongo is read again a single time.
 */
export function mongoPullCutoverTarget(projectKey: string): string {
  return `mongo_pull_origin_cutover:${projectKey}`;
}

export function parseIntOrZero(value: string | null | undefined): number {
  if (!value) return 0;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

export class MongoSyncWorker {
  private readonly config: Required<Omit<MongoSyncWorkerConfig, 'instanceId' | 'localProject' | 'pushLockPath'>>
    & Pick<MongoSyncWorkerConfig, 'instanceId' | 'localProject' | 'pushLockPath'>;
  private originId: string | null = null;
  private intervalHandle: NodeJS.Timeout | null = null;
  private running = false;

  private client: MongoClient | null = null;
  private db: Db | null = null;
  private counters: Collection<CounterDoc> | null = null;
  private events: Collection<RemoteEventDoc> | null = null;
  private origins: Collection<OriginDoc> | null = null;
  private indexesEnsured = false;

  private stats: MongoSyncStats = {
    lastSyncAt: null,
    pushedEvents: 0,
    pulledEvents: 0,
    errors: 0,
    status: 'idle'
  };

  constructor(
    private readonly sqliteStore: SQLiteEventStore,
    config: MongoSyncWorkerConfig
  ) {
    this.config = {
      uri: config.uri,
      dbName: config.dbName,
      projectKey: config.projectKey,
      direction: config.direction ?? 'both',
      intervalMs: config.intervalMs ?? 30000,
      batchSize: config.batchSize ?? 500,
      instanceId: config.instanceId,
      localProject: config.localProject,
      pushLockPath: config.pushLockPath
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stats.status = 'idle';

    // Initial sync
    this.syncNow().catch((err) => {
      console.error('[MongoSyncWorker] Initial sync failed:', err);
    });

    // Periodic sync
    this.intervalHandle = setInterval(() => {
      this.syncNow().catch((err) => {
        console.error('[MongoSyncWorker] Periodic sync failed:', err);
      });
    }, this.config.intervalMs);
  }

  stop(): void {
    this.running = false;
    this.stats.status = 'stopped';

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  async shutdown(): Promise<void> {
    this.stop();
    await this.disconnect();
  }

  getStats(): MongoSyncStats {
    return { ...this.stats };
  }

  isRunning(): boolean {
    return this.running;
  }

  async syncNow(): Promise<{ pushed: number; pulled: number }> {
    if (this.stats.status === 'syncing') return { pushed: 0, pulled: 0 };

    this.stats.status = 'syncing';
    let pushed = 0;
    let pulled = 0;

    try {
      await this.sqliteStore.initialize();
      await this.resolveOriginId();
      await this.ensureConnected();
      await this.ensureIndexes();

      if (this.config.direction === 'push' || this.config.direction === 'both') {
        pushed = await this.pushEvents();
        this.stats.pushedEvents += pushed;
      }

      if (this.config.direction === 'pull' || this.config.direction === 'both') {
        pulled = await this.pullEvents();
        this.stats.pulledEvents += pulled;
      }

      this.stats.lastSyncAt = new Date();
      this.stats.status = 'idle';
      return { pushed, pulled };
    } catch (error) {
      this.stats.errors++;
      this.stats.status = 'error';
      throw error;
    }
  }

  private async resolveOriginId(): Promise<string> {
    if (this.originId) return this.originId;
    if (this.config.instanceId) return (this.originId = this.config.instanceId);

    const machine = machineFingerprint();
    let stored = await this.sqliteStore.getOrCreateSyncPosition(MONGO_ORIGIN_ID_TARGET, randomUUID(), machine);
    if (stored.lastEventId && stored.lastTimestamp !== machine) {
      // Conditional, so concurrent processes on this machine all end up with the one id the first of them wrote.
      await this.sqliteStore.replaceSyncPositionIf(MONGO_ORIGIN_ID_TARGET, stored.lastEventId, randomUUID(), machine);
      stored = await this.sqliteStore.getSyncPosition(MONGO_ORIGIN_ID_TARGET);
    }
    if (!stored.lastEventId) throw new Error('Failed to persist the Mongo sync origin id');
    this.originId = stored.lastEventId;
    return this.originId;
  }

  private async ensureConnected(): Promise<void> {
    if (this.client && this.db && this.counters && this.events && this.origins) return;

    try {
      this.client = new MongoClient(this.config.uri, {
        appName: 'claude-memory-layer',
        serverSelectionTimeoutMS: 5000
      });
      await this.client.connect();
      this.db = this.client.db(this.config.dbName);
      this.counters = this.db.collection<CounterDoc>('cml_counters');
      this.events = this.db.collection<RemoteEventDoc>('cml_events');
      this.origins = this.db.collection<OriginDoc>('cml_origins');
    } catch (err) {
      // Avoid leaking credentials in logs; the driver's own message quotes the whole connection string.
      const safeUri = redactMongoUri(this.config.uri);
      const reason = describeMongoConnectionError(err, this.config.uri);
      throw new Error(`MongoDB connection failed (${safeUri}, db=${this.config.dbName}): ${reason}`);
    }
  }

  private async disconnect(): Promise<void> {
    try {
      await this.client?.close();
    } finally {
      this.client = null;
      this.db = null;
      this.counters = null;
      this.events = null;
      this.origins = null;
      this.indexesEnsured = false;
    }
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesEnsured) return;
    if (!this.events || !this.counters || !this.origins) throw new Error('Mongo not connected');

    // Best-effort: if the user lacks index privileges, sync can still work (slower)
    try {
      await this.events.createIndex({ projectKey: 1, seq: 1 }, { unique: true });
      await this.events.createIndex({ projectKey: 1, eventId: 1 }, { unique: true });
      await this.events.createIndex({ projectKey: 1, dedupeKey: 1 });
      await this.events.createIndex({ projectKey: 1, insertedAt: 1 });
      // Partial: documents from older pushers have no originSeq and would all collide on a missing key.
      await this.events.createIndex(
        { projectKey: 1, 'source.instanceId': 1, originSeq: 1 },
        { unique: true, partialFilterExpression: { originSeq: { $exists: true } } }
      );
      await this.origins.createIndex({ projectKey: 1 });
    } catch (err) {
      console.warn('[MongoSyncWorker] Failed to ensure indexes (continuing):', err);
    }

    this.indexesEnsured = true;
  }

  private counterKey(origin?: string): string {
    return origin ? `events:${this.config.projectKey}:${origin}` : `events:${this.config.projectKey}`;
  }

  private async allocateSeqRange(key: string, count: number): Promise<number> {
    if (!this.counters) throw new Error('Mongo not connected');
    if (count <= 0) return 1;

    const doc = await this.counters.findOneAndUpdate(
      { _id: key },
      { $inc: { seq: count } },
      { upsert: true, returnDocument: 'after' }
    );

    const endSeq = doc?.seq;
    if (typeof endSeq !== 'number') {
      throw new Error(`Failed to allocate seq range for ${key}`);
    }

    return endSeq - count + 1;
  }

  private pushTargetName(): string {
    return mongoPushCursorTarget(this.config.projectKey);
  }

  private pullTargetName(): string {
    return mongoPullCursorTarget(this.config.projectKey);
  }

  /**
   * Holds a per-store lock, so documents of one origin are reserved and inserted strictly one batch after another.
   * Another process already pushing for this store is left to finish; its next tick or ours picks up the rest.
   */
  private async pushEvents(): Promise<number> {
    const origin = await this.resolveOriginId();
    const lock = new WorkerLock(
      this.config.pushLockPath ?? path.join(os.tmpdir(), 'claude-memory-layer', `mongo-sync-push-${origin}.lock`)
    );
    if (!lock.acquire().acquired) return 0;
    try {
      return await this.pushEventsLocked(origin);
    } finally {
      lock.release();
    }
  }

  /**
   * Pushes only events Mongo does not have yet. Pulled events also get local rowids past the push cursor; pushing them
   * again would spend this origin's seqs on another origin's documents (the upsert leaves the document unchanged).
   *
   * Per batch: reserve the project seq and this origin's seq, raise the origin's maxOriginSeq in cml_origins, then
   * insert in order. Raising maxOriginSeq first keeps pullers asking for this origin until the insert lands, however
   * long it stalls; the ordered insert makes each origin's documents visible as a prefix of its seqs.
   */
  private async pushEventsLocked(origin: string): Promise<number> {
    if (!this.events || !this.origins) throw new Error('Mongo not connected');

    const position = await this.sqliteStore.getSyncPosition(this.pushTargetName());
    let lastRowid = parseIntOrZero(position.lastEventId);

    let pushed = 0;

    while (true) {
      const batch = await this.sqliteStore.getEventsSinceRowid(lastRowid, this.config.batchSize);
      if (batch.length === 0) break;

      const docId = (eventId: string) => `${this.config.projectKey}:${eventId}`;
      const inMongo = new Set((await this.events.find(
        { _id: { $in: batch.map((item) => docId(item.event.id)) } },
        { projection: { _id: 1 } }
      ).toArray()).map((doc) => doc._id));
      const fresh = batch.filter((item) => !inMongo.has(docId(item.event.id)));

      if (fresh.length > 0) {
        const startSeq = await this.allocateSeqRange(this.counterKey(), fresh.length);
        const startOriginSeq = await this.allocateSeqRange(this.counterKey(origin), fresh.length);
        const now = new Date();
        const hostname = os.hostname();

        await this.origins.updateOne(
          { _id: `${this.config.projectKey}:${origin}` },
          {
            $setOnInsert: { projectKey: this.config.projectKey, origin },
            $set: { hostname, updatedAt: now },
            $max: { maxOriginSeq: startOriginSeq + fresh.length - 1 }
          },
          { upsert: true }
        );

        const ops = fresh.map((item, idx) => {
          const event = item.event as unknown as MemoryEvent;
          const id = docId(event.id);

          return {
            updateOne: {
              filter: { _id: id },
              update: {
                $setOnInsert: {
                  _id: id,
                  projectKey: this.config.projectKey,
                  seq: startSeq + idx,
                  originSeq: startOriginSeq + idx,
                  eventId: event.id,
                  eventType: event.eventType,
                  sessionId: event.sessionId,
                  timestamp: event.timestamp,
                  content: event.content,
                  canonicalKey: event.canonicalKey,
                  dedupeKey: event.dedupeKey,
                  metadata: event.metadata ?? null,
                  insertedAt: now,
                  updatedAt: now,
                  source: { hostname, instanceId: origin }
                }
              },
              upsert: true
            }
          };
        });

        await this.events.bulkWrite(ops, { ordered: true });
      }

      const last = batch[batch.length - 1];
      lastRowid = last.rowid;
      await this.sqliteStore.updateSyncPosition(
        this.pushTargetName(),
        String(lastRowid),
        last.event.timestamp.toISOString()
      );

      pushed += fresh.length;
      if (batch.length < this.config.batchSize) break;
    }

    return pushed;
  }

  /**
   * Delivery is decided by cursors only; event timestamps stay for display and merge order.
   *
   * Each origin is read past its own originSeq cursor. Within an origin seqs are reserved and inserted one batch
   * after another under the push lock, so nothing can land below an origin's cursor, and no clocks are compared.
   * This store's own origin is skipped. Documents without originSeq (pushers on older versions) still go through the
   * project-wide seq cursor and its late-insert window, so a mixed-version fleet loses nothing it did not lose before.
   */
  private async pullEvents(): Promise<number> {
    await this.cutOverToOriginCursors();
    return (await this.pullLegacyEvents()) + (await this.pullOriginEvents());
  }

  /**
   * Documents pushed before per-origin cursors carry no originSeq, and the global cursor may have skipped some of them
   * for good. Resetting it once re-reads everything; import skips what this store already has (by id and dedupeKey).
   * The reset is written before the marker, so a crash in between only repeats the reset.
   */
  private async cutOverToOriginCursors(): Promise<void> {
    const marker = mongoPullCutoverTarget(this.config.projectKey);
    if ((await this.sqliteStore.getSyncPosition(marker)).lastEventId) return;
    await this.sqliteStore.updateSyncPosition(this.pullTargetName(), '0', '');
    await this.sqliteStore.updateSyncPosition(marker, '1', new Date().toISOString());
  }

  private async pullOriginEvents(): Promise<number> {
    if (!this.events || !this.origins) throw new Error('Mongo not connected');

    const self = await this.resolveOriginId();
    const origins = await this.listOrigins(self);
    let pulled = 0;

    for (const { origin, maxOriginSeq } of origins) {
      if (origin === self) continue;
      const target = mongoPullOriginCursorTarget(this.config.projectKey, origin);
      let cursor = parseIntOrZero((await this.sqliteStore.getSyncPosition(target)).lastEventId);

      while (cursor < maxOriginSeq) {
        const docs = await this.events.find(
          { projectKey: this.config.projectKey, 'source.instanceId': origin, originSeq: { $exists: true, $gt: cursor } },
          { sort: { originSeq: 1 }, limit: this.config.batchSize }
        ).toArray();
        if (docs.length === 0) break;

        pulled += await this.importPulled(docs);
        cursor = docs[docs.length - 1].originSeq ?? cursor;
        await this.sqliteStore.updateSyncPosition(target, String(cursor), new Date().toISOString());
        if (docs.length < this.config.batchSize) break;
      }
    }

    return pulled;
  }

  /**
   * cml_origins is only an index of cml_events: an origin whose row is gone (dropped collection, partial restore)
   * would never be read again. One limit-1 query on the per-origin index, skipping the known origins, checks for
   * such documents; if any exist, origins are derived from the documents and written back (best effort, a puller may
   * lack write access).
   */
  private async listOrigins(self: string): Promise<Array<Pick<OriginDoc, 'origin' | 'maxOriginSeq'>>> {
    if (!this.events || !this.origins) throw new Error('Mongo not connected');

    const projectKey = this.config.projectKey;
    const known = await this.origins.find({ projectKey }).toArray();
    const unknown = await this.events.find(
      { projectKey, 'source.instanceId': { $nin: [...known.map((row) => row.origin), self] }, originSeq: { $exists: true } },
      { projection: { _id: 1 }, limit: 1 }
    ).toArray();
    if (unknown.length === 0) return known;

    const derived = await this.events.aggregate<{ _id: string | null; maxOriginSeq: number }>([
      { $match: { projectKey, originSeq: { $exists: true } } },
      { $group: { _id: '$source.instanceId', maxOriginSeq: { $max: '$originSeq' } } }
    ]).toArray();
    const merged = new Map(known.map((row) => [row.origin, row.maxOriginSeq]));
    for (const { _id: origin, maxOriginSeq } of derived) {
      if (!origin || (merged.get(origin) ?? 0) >= maxOriginSeq) continue;
      merged.set(origin, maxOriginSeq);
      try {
        await this.origins.updateOne(
          { _id: `${projectKey}:${origin}` },
          { $setOnInsert: { projectKey, origin }, $max: { maxOriginSeq } },
          { upsert: true }
        );
      } catch (err) {
        console.warn(`[MongoSyncWorker] Failed to restore cml_origins row for ${origin} (continuing):`, err);
      }
    }
    return [...merged].map(([origin, maxOriginSeq]) => ({ origin, maxOriginSeq }));
  }

  /**
   * Documents without originSeq: an older pusher reserves its seq range before it inserts, so a document can appear
   * below a cursor that another machine's faster insert already moved past. Each pull therefore re-reads what was
   * inserted shortly before the previous pull started — import skips the events it already has — and then reads past
   * the cursor as before. The window also absorbs clock differences between machines (insertedAt is the pusher's
   * clock), but only up to LATE_INSERT_WINDOW_MS; that residual risk goes away once every pusher is upgraded.
   *
   * Reading past the cursor fetches only seqs first, so documents that per-origin cursors read are not transferred
   * twice, yet the cursor still moves past them and the query never rescans them.
   */
  private async pullLegacyEvents(): Promise<number> {
    if (!this.events) throw new Error('Mongo not connected');

    const position = await this.sqliteStore.getSyncPosition(this.pullTargetName());
    let lastSeq = parseIntOrZero(position.lastEventId);
    const startedAt = new Date();
    const previousPullAt = position.lastTimestamp ? new Date(position.lastTimestamp) : null;
    const legacy = { originSeq: { $exists: false } };

    let pulled = 0;

    if (lastSeq > 0 && previousPullAt && !Number.isNaN(previousPullAt.getTime())) {
      const since = new Date(previousPullAt.getTime() - LATE_INSERT_WINDOW_MS);
      let afterSeq = 0;
      while (true) {
        const docs = await this.events.find(
          { projectKey: this.config.projectKey, seq: { $gt: afterSeq, $lte: lastSeq }, insertedAt: { $gte: since }, ...legacy },
          { sort: { seq: 1 }, limit: this.config.batchSize }
        ).toArray();
        if (docs.length === 0) break;
        pulled += await this.importPulled(docs);
        afterSeq = docs[docs.length - 1].seq;
        if (docs.length < this.config.batchSize) break;
      }
    }

    while (true) {
      const seqs = await this.events.find(
        { projectKey: this.config.projectKey, seq: { $gt: lastSeq } },
        { sort: { seq: 1 }, limit: this.config.batchSize, projection: { _id: 1, seq: 1, originSeq: 1 } }
      ).toArray();

      if (seqs.length === 0) break;

      const legacyIds = seqs.filter((doc) => doc.originSeq === undefined).map((doc) => doc._id);
      if (legacyIds.length > 0) {
        const docs = await this.events.find(
          { projectKey: this.config.projectKey, _id: { $in: legacyIds } },
          { sort: { seq: 1 } }
        ).toArray();
        pulled += await this.importPulled(docs);
      }

      lastSeq = seqs[seqs.length - 1].seq;
      await this.sqliteStore.updateSyncPosition(this.pullTargetName(), String(lastSeq), startedAt.toISOString());

      if (seqs.length < this.config.batchSize) break;
    }

    // The next pull's re-read window starts from this pull, even when it found nothing new.
    await this.sqliteStore.updateSyncPosition(this.pullTargetName(), String(lastSeq), startedAt.toISOString());
    return pulled;
  }

  private async importPulled(docs: RemoteEventDoc[]): Promise<number> {
    const events: MemoryEvent[] = docs.map((d) => ({
      id: d.eventId,
      eventType: d.eventType as any,
      sessionId: d.sessionId,
      timestamp: d.timestamp instanceof Date ? d.timestamp : new Date(d.timestamp),
      content: d.content,
      canonicalKey: d.canonicalKey,
      dedupeKey: d.dedupeKey,
      metadata: this.config.localProject ? localizePulledMetadata(d, this.config.localProject) : d.metadata ?? undefined
    }));
    return (await this.sqliteStore.importEvents(events)).inserted;
  }
}
