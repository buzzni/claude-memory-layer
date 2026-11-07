/**
 * In-memory stand-in for the Mongo collections the sync worker and audit use (cml_counters, cml_events, cml_origins).
 * It evaluates only the operators they send, so several workers on separate SQLite stores can sync through one
 * shared "database" and a test can hold one pusher between reserving its seqs and inserting them.
 */

type Doc = Record<string, any>;
type Filter = Record<string, unknown>;

function field(doc: Doc, fieldPath: string): unknown {
  return fieldPath.split('.').reduce<unknown>((value, key) => (value as Doc | undefined)?.[key], doc);
}

function comparable(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

export function matchesFilter(doc: Doc, filter: Filter): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    const value = field(doc, key);
    if (typeof condition !== 'object' || condition === null || condition instanceof Date) {
      return comparable(value) === comparable(condition);
    }
    const ops = condition as Record<string, unknown>;
    const v = comparable(value) as number;
    if (ops.$exists !== undefined && (value !== undefined) !== ops.$exists) return false;
    if (ops.$in && !(ops.$in as unknown[]).includes(value)) return false;
    if (ops.$gt !== undefined && !(value !== undefined && v > (comparable(ops.$gt) as number))) return false;
    if (ops.$gte !== undefined && !(value !== undefined && v >= (comparable(ops.$gte) as number))) return false;
    if (ops.$lt !== undefined && !(value !== undefined && v < (comparable(ops.$lt) as number))) return false;
    if (ops.$lte !== undefined && !(value !== undefined && v <= (comparable(ops.$lte) as number))) return false;
    return true;
  });
}

function accumulate(rows: Doc[], spec: Record<string, unknown>): unknown {
  const [op, arg] = Object.entries(spec)[0];
  const values = rows.map((row) => (typeof arg === 'string' ? field(row, arg.slice(1)) : arg));
  if (op === '$sum') return values.reduce<number>((sum, v) => sum + (v as number), 0);
  if (op === '$first') return values[0] ?? null;
  if (op === '$push') return values.filter((v) => v !== undefined);
  const present = values.filter((v) => v !== undefined).sort((a, b) => Number(comparable(a)) - Number(comparable(b)));
  return op === '$min' ? present[0] : present[present.length - 1];
}

function project(doc: Doc, projection: Record<string, number> | undefined): Doc {
  if (!projection) return { ...doc };
  return Object.fromEntries(Object.keys(projection).filter((key) => key in doc).map((key) => [key, doc[key]]));
}

class FakeCollection {
  docs: Doc[] = [];
  /** Documents handed back by find, so a test can tell an idle pull from one that re-read everything. */
  returned = 0;
  /** Read queries the audit sends, so a test can check it only counts and groups, and which index it pins. */
  readonly calls: Array<{ op: 'countDocuments' | 'aggregate'; arg: unknown; options?: unknown }> = [];

  async createIndex(): Promise<string> {
    return 'index';
  }

  find(filter: Filter, options: { sort?: Record<string, 1 | -1>; limit?: number; projection?: Record<string, number> } = {}) {
    return {
      toArray: async () => {
        let rows = this.docs.filter((doc) => matchesFilter(doc, filter));
        const [sortKey, direction] = Object.entries(options.sort ?? {})[0] ?? [];
        if (sortKey) rows = rows.sort((a, b) => (Number(field(a, sortKey)) - Number(field(b, sortKey))) * (direction ?? 1));
        if (options.limit) rows = rows.slice(0, options.limit);
        this.returned += rows.length;
        return rows.map((doc) => project(doc, options.projection));
      }
    };
  }

  async countDocuments(filter: Filter, options?: unknown): Promise<number> {
    this.calls.push({ op: 'countDocuments', arg: filter, options });
    return this.docs.filter((doc) => matchesFilter(doc, filter)).length;
  }

  aggregate(pipeline: Record<string, unknown>[], options?: unknown) {
    this.calls.push({ op: 'aggregate', arg: pipeline, options });
    return {
      toArray: async () => {
        const [{ $match }, { $group }] = pipeline as [{ $match: Filter }, { $group: Record<string, unknown> }];
        const groups = new Map<unknown, Doc[]>();
        for (const doc of this.docs.filter((d) => matchesFilter(d, $match))) {
          const key = field(doc, String($group._id).slice(1)) ?? null;
          groups.set(key, [...(groups.get(key) ?? []), doc]);
        }
        return [...groups].map(([key, rows]) => Object.fromEntries([
          ['_id', key],
          ...Object.entries($group).filter(([name]) => name !== '_id')
            .map(([name, spec]) => [name, accumulate(rows, spec as Record<string, unknown>)])
        ]));
      }
    };
  }

  async findOneAndUpdate(filter: Filter, update: { $inc: Record<string, number> }): Promise<Doc> {
    let doc = this.docs.find((d) => matchesFilter(d, filter));
    if (!doc) {
      doc = { ...filter };
      this.docs.push(doc);
    }
    for (const [key, by] of Object.entries(update.$inc)) doc[key] = (doc[key] ?? 0) + by;
    return { ...doc };
  }

  async updateOne(
    filter: Filter,
    update: { $setOnInsert?: Doc; $set?: Doc; $max?: Record<string, number> },
    options: { upsert?: boolean } = {}
  ): Promise<void> {
    let doc = this.docs.find((d) => matchesFilter(d, filter));
    if (!doc) {
      if (!options.upsert) return;
      doc = { ...filter, ...update.$setOnInsert };
      this.docs.push(doc);
    }
    Object.assign(doc, update.$set ?? {});
    for (const [key, value] of Object.entries(update.$max ?? {})) {
      if (doc[key] === undefined || value > doc[key]) doc[key] = value;
    }
  }

  async bulkWrite(ops: Array<{ updateOne: { filter: Filter; update: Doc; upsert?: boolean } }>): Promise<void> {
    for (const { updateOne } of ops) await this.updateOne(updateOne.filter, updateOne.update, updateOne);
  }
}

export class FakeMongo {
  readonly counters = new FakeCollection();
  readonly events = new FakeCollection();
  readonly origins = new FakeCollection();

  /** An event document as an older (pre per-origin) pusher writes it: a global seq and a per-run instanceId only. */
  insertLegacyDoc(projectKey: string, seq: number, insertedAt: Date, extra: Doc = {}): void {
    const eventId = `legacy-${seq}`;
    this.events.docs.push({
      _id: `${projectKey}:${eventId}`,
      projectKey,
      seq,
      eventId,
      eventType: 'user_prompt',
      sessionId: `legacy-session-${seq}`,
      timestamp: insertedAt,
      content: `legacy memory ${seq}`,
      canonicalKey: `legacy memory ${seq}`,
      dedupeKey: `legacy-dedupe-${seq}`,
      metadata: null,
      insertedAt,
      updatedAt: insertedAt,
      source: { hostname: 'old-machine', instanceId: `run-${seq}` },
      ...extra
    });
  }
}

export interface FakeMongoHooks {
  /** Awaited before this worker's events bulkWrite: a pusher that already reserved its seqs and then stalls. */
  beforeBulkWrite?: () => Promise<void>;
}

/** Points a MongoSyncWorker at the shared fake instead of a real connection. */
export function connectFakeMongo(worker: unknown, mongo: FakeMongo, hooks: FakeMongoHooks = {}): void {
  const events = {
    createIndex: () => mongo.events.createIndex(),
    find: (...args: Parameters<FakeCollection['find']>) => mongo.events.find(...args),
    bulkWrite: async (ops: Parameters<FakeCollection['bulkWrite']>[0]) => {
      await hooks.beforeBulkWrite?.();
      return mongo.events.bulkWrite(ops);
    }
  };
  Object.assign(worker as Record<string, unknown>, {
    client: {},
    db: {},
    counters: mongo.counters,
    events,
    origins: mongo.origins
  });
}

/** A gate a hooked call waits on: `reached` resolves when the call arrives, `release()` lets it continue. */
export function createGate(): { wait: () => Promise<void>; reached: Promise<void>; release: () => void } {
  let release!: () => void;
  let arrive!: () => void;
  const opened = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { arrive = resolve; });
  return { wait: async () => { arrive(); await opened; }, reached, release };
}
