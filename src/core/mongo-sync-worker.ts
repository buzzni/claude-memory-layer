/**
 * Mongo Sync Worker
 * Optional: sync per-project SQLite events to a shared MongoDB database.
 *
 * Design goals:
 * - Optional and decoupled (doesn't affect default local-only flow)
 * - Idempotent (safe to retry)
 * - Incremental push (SQLite rowid) and incremental pull (Mongo seq per project)
 *
 * NOTE:
 * - We only sync immutable L0 events (events table). Derived tables can be rebuilt.
 */

import { randomUUID } from 'crypto';
import * as os from 'os';
import { MongoClient } from 'mongodb';
import type { Collection, Db } from 'mongodb';

import type { MemoryEvent } from './types.js';
import { SQLiteEventStore } from './sqlite-event-store.js';

export type MongoSyncDirection = 'push' | 'pull' | 'both';

export interface MongoSyncWorkerConfig {
  uri: string;
  dbName: string;
  projectKey: string;
  direction?: MongoSyncDirection;
  intervalMs?: number;
  batchSize?: number;
  instanceId?: string;
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

interface RemoteEventDoc {
  _id: string;
  projectKey: string;
  seq: number;
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

function redactMongoUri(uri: string): string {
  // mongodb://user:pass@host:port/  -> mongodb://user:***@host:port/
  // mongodb+srv://user:pass@host/  -> mongodb+srv://user:***@host/
  const schemeIdx = uri.indexOf('://');
  if (schemeIdx === -1) return uri;
  const atIdx = uri.indexOf('@', schemeIdx + 3);
  if (atIdx === -1) return uri;

  const creds = uri.slice(schemeIdx + 3, atIdx); // user:pass
  const colonIdx = creds.indexOf(':');
  if (colonIdx === -1) return uri;

  const prefix = uri.slice(0, schemeIdx + 3 + colonIdx + 1);
  const suffix = uri.slice(atIdx);
  return `${prefix}***${suffix}`;
}

function parseIntOrZero(value: string | null | undefined): number {
  if (!value) return 0;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

export class MongoSyncWorker {
  private readonly config: Required<Omit<MongoSyncWorkerConfig, 'instanceId'>> & { instanceId: string };
  private intervalHandle: NodeJS.Timeout | null = null;
  private running = false;

  private client: MongoClient | null = null;
  private db: Db | null = null;
  private counters: Collection<CounterDoc> | null = null;
  private events: Collection<RemoteEventDoc> | null = null;
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
      instanceId: config.instanceId ?? randomUUID()
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

  private async ensureConnected(): Promise<void> {
    if (this.client && this.db && this.counters && this.events) return;

    try {
      this.client = new MongoClient(this.config.uri, {
        appName: 'claude-memory-layer',
        serverSelectionTimeoutMS: 5000
      });
      await this.client.connect();
      this.db = this.client.db(this.config.dbName);
      this.counters = this.db.collection<CounterDoc>('cml_counters');
      this.events = this.db.collection<RemoteEventDoc>('cml_events');
    } catch (err) {
      // Avoid leaking credentials in logs
      const safeUri = redactMongoUri(this.config.uri);
      throw new Error(`MongoDB connection failed (${safeUri}, db=${this.config.dbName}): ${String(err)}`);
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
      this.indexesEnsured = false;
    }
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesEnsured) return;
    if (!this.events || !this.counters) throw new Error('Mongo not connected');

    // Best-effort: if the user lacks index privileges, sync can still work (slower)
    try {
      await this.events.createIndex({ projectKey: 1, seq: 1 }, { unique: true });
      await this.events.createIndex({ projectKey: 1, eventId: 1 }, { unique: true });
      await this.events.createIndex({ projectKey: 1, dedupeKey: 1 });
    } catch (err) {
      console.warn('[MongoSyncWorker] Failed to ensure indexes (continuing):', err);
    }

    this.indexesEnsured = true;
  }

  private counterKey(kind: 'events'): string {
    return `${kind}:${this.config.projectKey}`;
  }

  private async allocateSeqRange(kind: 'events', count: number): Promise<number> {
    if (!this.counters) throw new Error('Mongo not connected');
    if (count <= 0) return 1;

    const key = this.counterKey(kind);
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
    return `mongo_push_events_rowid:${this.config.projectKey}`;
  }

  private pullTargetName(): string {
    return `mongo_pull_events_seq:${this.config.projectKey}`;
  }

  private async pushEvents(): Promise<number> {
    if (!this.events) throw new Error('Mongo not connected');

    const position = await this.sqliteStore.getSyncPosition(this.pushTargetName());
    let lastRowid = parseIntOrZero(position.lastEventId);

    let pushed = 0;

    while (true) {
      const batch = await this.sqliteStore.getEventsSinceRowid(lastRowid, this.config.batchSize);
      if (batch.length === 0) break;

      const startSeq = await this.allocateSeqRange('events', batch.length);
      const now = new Date();
      const hostname = os.hostname();

      const ops = batch.map((item, idx) => {
        const event = item.event as unknown as MemoryEvent;
        const seq = startSeq + idx;
        const docId = `${this.config.projectKey}:${event.id}`;

        return {
          updateOne: {
            filter: { _id: docId },
            update: {
              $setOnInsert: {
                _id: docId,
                projectKey: this.config.projectKey,
                seq,
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
                source: { hostname, instanceId: this.config.instanceId }
              }
            },
            upsert: true
          }
        };
      });

      await this.events.bulkWrite(ops, { ordered: false });

      const last = batch[batch.length - 1];
      lastRowid = last.rowid;
      await this.sqliteStore.updateSyncPosition(
        this.pushTargetName(),
        String(lastRowid),
        last.event.timestamp.toISOString()
      );

      pushed += batch.length;
      if (batch.length < this.config.batchSize) break;
    }

    return pushed;
  }

  private async pullEvents(): Promise<number> {
    if (!this.events) throw new Error('Mongo not connected');

    const position = await this.sqliteStore.getSyncPosition(this.pullTargetName());
    let lastSeq = parseIntOrZero(position.lastEventId);

    let pulled = 0;

    while (true) {
      const docs = await this.events.find(
        { projectKey: this.config.projectKey, seq: { $gt: lastSeq } },
        { sort: { seq: 1 }, limit: this.config.batchSize }
      ).toArray();

      if (docs.length === 0) break;

      const events: MemoryEvent[] = docs.map((d) => ({
        id: d.eventId,
        eventType: d.eventType as any,
        sessionId: d.sessionId,
        timestamp: d.timestamp instanceof Date ? d.timestamp : new Date(d.timestamp),
        content: d.content,
        canonicalKey: d.canonicalKey,
        dedupeKey: d.dedupeKey,
        metadata: d.metadata ?? undefined
      }));

      const result = await this.sqliteStore.importEvents(events);
      pulled += result.inserted;

      lastSeq = docs[docs.length - 1].seq;
      await this.sqliteStore.updateSyncPosition(
        this.pullTargetName(),
        String(lastSeq),
        new Date().toISOString()
      );

      if (docs.length < this.config.batchSize) break;
    }

    return pulled;
  }
}
