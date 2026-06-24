import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { PerspectiveObservationRepository } from '../../src/core/operations/perspective-observation-repository.js';
import { TaskResolver } from '../../src/core/task/task-resolver.js';
import type { MemoryEvent, OutboxItemKind } from '../../src/core/types.js';
import { DefaultContentProvider, VectorWorkerV2, type ContentProvider } from '../../src/core/vector-worker.js';
import { VectorOutbox } from '../../src/core/vector-outbox.js';

const dbs: Database.Database[] = [];
const tempDirs: string[] = [];

function createTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cml-vector-outbox-'));
  tempDirs.push(dir);
  return join(dir, 'memory.db');
}

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE vector_outbox (
      job_id TEXT PRIMARY KEY,
      item_kind TEXT NOT NULL,
      item_id TEXT NOT NULL,
      embedding_version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER DEFAULT 0,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(item_kind, item_id, embedding_version)
    );
    CREATE INDEX idx_outbox_status ON vector_outbox(status);

    CREATE TABLE perspective_observations (
      observation_id TEXT PRIMARY KEY,
      project_hash TEXT,
      observer_actor_id TEXT NOT NULL,
      observed_actor_id TEXT NOT NULL,
      session_id TEXT,
      level TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL NOT NULL,
      source_event_ids_json TEXT,
      source_observation_ids_json TEXT,
      source_hash TEXT,
      created_by TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
  `);
  dbs.push(db);
  return db;
}

type OutboxRow = {
  item_kind: string;
  item_id: string;
  embedding_version: string;
  status: string;
};

function readOutboxRows(db: Database.Database): OutboxRow[] {
  return db.prepare(`
    SELECT item_kind, item_id, embedding_version, status
    FROM vector_outbox
    ORDER BY item_kind, item_id, embedding_version
  `).all() as OutboxRow[];
}

function expectPrivateSentinelsAbsent(rows: unknown, sentinels: string[]): void {
  const serialized = JSON.stringify(rows);
  for (const sentinel of sentinels) {
    expect(serialized).not.toContain(sentinel);
  }
}

class FailingVectorOutbox extends VectorOutbox {
  enqueueSync(_itemKind: OutboxItemKind, _itemId: string, _embeddingVersion?: string): string {
    throw new Error('forced vector enqueue failure');
  }
}

afterEach(() => {
  while (dbs.length > 0) {
    const db = dbs.pop();
    if (db?.open) db.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('vector_outbox schema initialization', () => {
  it('creates an index for created_at ordering in SQLiteEventStore initialization', async () => {
    const dbPath = createTempDbPath();
    const store = new SQLiteEventStore(dbPath);
    await store.initialize();
    await store.close();

    const db = new Database(dbPath, { readonly: true });
    dbs.push(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get('idx_outbox_created')).toEqual({
      name: 'idx_outbox_created'
    });
  });
});

describe('automatic vector_outbox enqueue boundaries', () => {
  it('enqueues event jobs from append() once without storing raw event content', async () => {
    const dbPath = createTempDbPath();
    const store = new SQLiteEventStore(dbPath, {
      vectorOutbox: { embeddingVersion: 'auto-event-v1' }
    });

    try {
      await store.initialize();
      const first = await store.append({
        eventType: 'user_prompt',
        sessionId: 'session-auto-event',
        timestamp: new Date('2026-05-25T00:00:00.000Z'),
        content: 'PRIVATE_EVENT_CONTENT_SENTINEL PRIVATE_AUTO_EVENT_MARKER /Users/private/event.md',
        metadata: {
          rawPath: '/Users/private/event.md',
          note: 'PRIVATE_EVENT_METADATA_SENTINEL'
        }
      });
      const duplicate = await store.append({
        eventType: 'user_prompt',
        sessionId: 'session-auto-event',
        timestamp: new Date('2026-05-25T00:00:01.000Z'),
        content: 'PRIVATE_EVENT_CONTENT_SENTINEL PRIVATE_AUTO_EVENT_MARKER /Users/private/event.md',
        metadata: {
          rawPath: '/Users/private/event.md',
          note: 'PRIVATE_EVENT_METADATA_SENTINEL'
        }
      });

      expect(first).toMatchObject({ success: true, isDuplicate: false });
      if (!first.success) throw new Error('append failed');
      expect(duplicate).toMatchObject({ success: true, eventId: first.eventId, isDuplicate: true });
      const rows = readOutboxRows(store.getDatabase() as Database.Database);
      expect(rows).toEqual([
        {
          item_kind: 'event',
          item_id: first.eventId,
          embedding_version: 'auto-event-v1',
          status: 'pending'
        }
      ]);
      expectPrivateSentinelsAbsent(rows, [
        'PRIVATE_EVENT_CONTENT_SENTINEL',
        'PRIVATE_EVENT_METADATA_SENTINEL',
        'PRIVATE_AUTO_EVENT_MARKER',
        '/Users/private/event.md'
      ]);
    } finally {
      await store.close();
    }
  });

  it('enqueues only newly imported events and skips imported duplicates', async () => {
    const dbPath = createTempDbPath();
    const store = new SQLiteEventStore(dbPath, {
      vectorOutbox: { embeddingVersion: 'auto-import-v1' }
    });
    const eventA: MemoryEvent = {
      id: '00000000-0000-4000-8000-0000000000a1',
      eventType: 'agent_response',
      sessionId: 'session-import',
      timestamp: new Date('2026-05-25T00:01:00.000Z'),
      content: 'PRIVATE_IMPORT_EVENT_A_SENTINEL /Users/private/import-a.md',
      canonicalKey: 'canonical-import-a',
      dedupeKey: 'dedupe-import-a',
      metadata: { note: 'PRIVATE_IMPORT_METADATA_A_SENTINEL' }
    };
    const eventB: MemoryEvent = {
      id: '00000000-0000-4000-8000-0000000000b1',
      eventType: 'session_summary',
      sessionId: 'session-import',
      timestamp: new Date('2026-05-25T00:02:00.000Z'),
      content: 'PRIVATE_IMPORT_SUMMARY_SENTINEL /Users/private/summary.md',
      canonicalKey: 'canonical-import-b',
      dedupeKey: 'dedupe-import-b',
      metadata: { note: 'PRIVATE_IMPORT_METADATA_B_SENTINEL' }
    };
    const eventC: MemoryEvent = {
      id: '00000000-0000-4000-8000-0000000000c1',
      eventType: 'tool_observation',
      sessionId: 'session-import',
      timestamp: new Date('2026-05-25T00:03:00.000Z'),
      content: 'PRIVATE_IMPORT_EVENT_C_SENTINEL /Users/private/import-c.md',
      canonicalKey: 'canonical-import-c',
      dedupeKey: 'dedupe-import-c',
      metadata: { note: 'PRIVATE_IMPORT_METADATA_C_SENTINEL' }
    };

    try {
      expect(await store.importEvents([eventA, eventB])).toEqual({ inserted: 2, skipped: 0 });
      expect(await store.importEvents([eventA, eventC])).toEqual({ inserted: 1, skipped: 1 });

      const rows = readOutboxRows(store.getDatabase() as Database.Database);
      expect(rows).toEqual([
        { item_kind: 'event', item_id: eventA.id, embedding_version: 'auto-import-v1', status: 'pending' },
        { item_kind: 'event', item_id: eventB.id, embedding_version: 'auto-import-v1', status: 'pending' },
        { item_kind: 'event', item_id: eventC.id, embedding_version: 'auto-import-v1', status: 'pending' }
      ]);
      expectPrivateSentinelsAbsent(rows, [
        'PRIVATE_IMPORT_EVENT_A_SENTINEL',
        'PRIVATE_IMPORT_SUMMARY_SENTINEL',
        'PRIVATE_IMPORT_EVENT_C_SENTINEL',
        'PRIVATE_IMPORT_METADATA_A_SENTINEL',
        'PRIVATE_IMPORT_METADATA_B_SENTINEL',
        'PRIVATE_IMPORT_METADATA_C_SENTINEL',
        '/Users/private/import-a.md',
        '/Users/private/summary.md',
        '/Users/private/import-c.md'
      ]);
    } finally {
      await store.close();
    }
  });

  it('enqueues task_title jobs when a new task is materialized and not when it matches an existing task', async () => {
    const dbPath = createTempDbPath();
    const store = new SQLiteEventStore(dbPath);

    try {
      await store.initialize();
      const db = store.getDatabase() as Database.Database;
      const resolver = new TaskResolver(db, { sessionId: 'session-task', project: 'phase-5' }, {
        vectorOutbox: new VectorOutbox(db, { embeddingVersion: 'auto-task-v1' })
      });

      const first = await resolver.processTask({
        title: 'Ship automatic vector outbox enqueue',
        description: 'PRIVATE_TASK_DESCRIPTION_SENTINEL PRIVATE_TASK_MARKER /Users/private/task.md',
        priority: 'high',
        project: 'phase-5'
      });
      const matched = await resolver.processTask({
        title: 'Ship automatic vector outbox enqueue',
        description: 'PRIVATE_TASK_DESCRIPTION_SENTINEL PRIVATE_TASK_MARKER /Users/private/task.md',
        priority: 'high',
        project: 'phase-5'
      });

      expect(first.isNew).toBe(true);
      expect(matched).toMatchObject({ taskId: first.taskId, isNew: false });
      const rows = readOutboxRows(db);
      expect(rows).toEqual([
        {
          item_kind: 'task_title',
          item_id: first.taskId,
          embedding_version: 'auto-task-v1',
          status: 'pending'
        }
      ]);
      expectPrivateSentinelsAbsent(rows, [
        'Ship automatic vector outbox enqueue',
        'PRIVATE_TASK_DESCRIPTION_SENTINEL',
        'PRIVATE_TASK_MARKER',
        '/Users/private/task.md'
      ]);
    } finally {
      await store.close();
    }
  });

  it('enqueues perspective_observation jobs idempotently without storing raw observation evidence', async () => {
    const dbPath = createTempDbPath();
    const store = new SQLiteEventStore(dbPath);

    try {
      await store.initialize();
      const db = store.getDatabase() as Database.Database;
      const repo = new PerspectiveObservationRepository(db, {
        vectorOutbox: new VectorOutbox(db, { embeddingVersion: 'auto-observation-v1' })
      });
      const input = {
        projectHash: 'project-auto-observation',
        observerActorId: 'assistant:manager',
        observedActorId: 'assistant:coder',
        sessionId: 'session-observation',
        level: 'explicit',
        content: 'PRIVATE_OBSERVATION_CONTENT_SENTINEL PRIVATE_OBSERVATION_MARKER /Users/private/observation.md',
        confidence: 0.92,
        sourceEventIds: ['event-private-1', 'event-private-2'],
        sourceObservationIds: ['observation-private-1'],
        createdBy: 'manual',
        metadata: {
          rawPath: '/Users/private/observation.md',
          privateNote: 'PRIVATE_OBSERVATION_METADATA_SENTINEL'
        }
      };

      const first = await repo.create(input);
      const repeated = await repo.create(input);

      expect(repeated.observationId).toBe(first.observationId);
      const rows = readOutboxRows(db);
      expect(rows).toEqual([
        {
          item_kind: 'perspective_observation',
          item_id: first.observationId,
          embedding_version: 'auto-observation-v1',
          status: 'pending'
        }
      ]);
      expectPrivateSentinelsAbsent(rows, [
        'PRIVATE_OBSERVATION_CONTENT_SENTINEL',
        'PRIVATE_OBSERVATION_METADATA_SENTINEL',
        'PRIVATE_OBSERVATION_MARKER',
        'event-private-1',
        'observation-private-1',
        '/Users/private/observation.md'
      ]);
    } finally {
      await store.close();
    }
  });

  it('rolls back writer rows when automatic vector enqueue fails transactionally', async () => {
    const eventDbPath = createTempDbPath();
    const eventStore = new SQLiteEventStore(eventDbPath, {
      vectorOutbox: new FailingVectorOutbox(createDb(), { embeddingVersion: 'failing-v1' })
    });

    try {
      await eventStore.initialize();
      const result = await eventStore.append({
        eventType: 'user_prompt',
        sessionId: 'session-failing-event',
        timestamp: new Date('2026-05-25T00:05:00.000Z'),
        content: 'event content that must roll back'
      });
      expect(result).toMatchObject({ success: false });
      const eventDb = eventStore.getDatabase() as Database.Database;
      expect(eventDb.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 0 });
      expect(readOutboxRows(eventDb)).toEqual([]);
    } finally {
      await eventStore.close();
    }

    const taskDbPath = createTempDbPath();
    const taskStore = new SQLiteEventStore(taskDbPath);
    try {
      await taskStore.initialize();
      const taskDb = taskStore.getDatabase() as Database.Database;
      const resolver = new TaskResolver(taskDb, { sessionId: 'session-failing-task', project: 'phase-5' }, {
        vectorOutbox: new FailingVectorOutbox(taskDb, { embeddingVersion: 'failing-v1' })
      });
      await expect(resolver.processTask({
        title: 'Task row must roll back with failed enqueue',
        project: 'phase-5'
      })).rejects.toThrow('forced vector enqueue failure');
      expect(taskDb.prepare("SELECT COUNT(*) AS count FROM entities WHERE title = 'Task row must roll back with failed enqueue'").get()).toEqual({ count: 0 });
      expect(taskDb.prepare("SELECT COUNT(*) AS count FROM events WHERE session_id = 'session-failing-task'").get()).toEqual({ count: 0 });
      expect(readOutboxRows(taskDb)).toEqual([]);
    } finally {
      await taskStore.close();
    }

    const observationDbPath = createTempDbPath();
    const observationStore = new SQLiteEventStore(observationDbPath);
    try {
      await observationStore.initialize();
      const observationDb = observationStore.getDatabase() as Database.Database;
      const repo = new PerspectiveObservationRepository(observationDb, {
        vectorOutbox: new FailingVectorOutbox(observationDb, { embeddingVersion: 'failing-v1' })
      });
      await expect(repo.create({
        projectHash: 'project-failing-observation',
        observerActorId: 'assistant:manager',
        observedActorId: 'assistant:coder',
        level: 'explicit',
        content: 'observation row that must roll back',
        confidence: 0.9,
        sourceEventIds: [],
        sourceObservationIds: [],
        createdBy: 'manual'
      })).rejects.toThrow('forced vector enqueue failure');
      expect(observationDb.prepare('SELECT COUNT(*) AS count FROM perspective_observations').get()).toEqual({ count: 0 });
      expect(readOutboxRows(observationDb)).toEqual([]);
    } finally {
      await observationStore.close();
    }
  });

  it('leaves writers backwards-compatible when vector enqueue is explicitly disabled', async () => {
    const dbPath = createTempDbPath();
    const store = new SQLiteEventStore(dbPath, { vectorOutbox: false });

    try {
      await store.initialize();
      const result = await store.append({
        eventType: 'user_prompt',
        sessionId: 'session-disabled-outbox',
        timestamp: new Date('2026-05-25T00:04:00.000Z'),
        content: 'disabled outbox content'
      });

      expect(result).toMatchObject({ success: true, isDuplicate: false });
      expect(readOutboxRows(store.getDatabase() as Database.Database)).toEqual([]);
    } finally {
      await store.close();
    }
  });
});

describe('VectorOutbox V2', () => {
  it('idempotently returns the existing job id for duplicate item/version enqueues', async () => {
    const db = createDb();
    const outbox = new VectorOutbox(db, { embeddingVersion: 'test-v1' });

    const firstJobId = await outbox.enqueue('event', 'event-1');
    const duplicateJobId = await outbox.enqueue('event', 'event-1');
    const nextVersionJobId = await outbox.enqueue('event', 'event-1', 'test-v2');

    expect(duplicateJobId).toBe(firstJobId);
    expect(nextVersionJobId).not.toBe(firstJobId);

    const rows = db.prepare('SELECT job_id, item_kind, item_id, embedding_version FROM vector_outbox ORDER BY embedding_version').all();
    expect(rows).toHaveLength(2);
    expect(rows).toEqual([
      { job_id: firstJobId, item_kind: 'event', item_id: 'event-1', embedding_version: 'test-v1' },
      { job_id: nextVersionJobId, item_kind: 'event', item_id: 'event-1', embedding_version: 'test-v2' }
    ]);
  });

  it('batch enqueue reports which jobs were newly inserted versus already present', async () => {
    const db = createDb();
    const outbox = new VectorOutbox(db, { embeddingVersion: 'test-v1' });
    const existingJobId = await outbox.enqueue('event', 'event-1');

    const results = await outbox.enqueueBatch([
      { itemKind: 'event', itemId: 'event-1' },
      { itemKind: 'perspective_observation', itemId: 'obs-1', embeddingVersion: 'test-v2' }
    ]);

    expect(results).toEqual([
      { success: true, jobId: existingJobId, isNew: false },
      { success: true, jobId: expect.any(String), isNew: true }
    ]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM vector_outbox').get()).toEqual({ count: 2 });
  });

  it('keeps Lance commit conflicts retryable without consuming retry budget', async () => {
    const db = createDb();
    const outbox = new VectorOutbox(db, { embeddingVersion: 'test-v1', maxRetries: 1 });
    const jobId = await outbox.enqueue('event', 'event-transient-conflict');

    const claimed = await outbox.claimJobs(1);
    expect(claimed).toHaveLength(1);
    await outbox.markFailed(jobId, 'Lance commit conflict: concurrent writer committed first; please retry');

    expect(db.prepare('SELECT status, retry_count, error FROM vector_outbox WHERE job_id = ?').get(jobId)).toEqual({
      status: 'pending',
      retry_count: 0,
      error: 'Lance commit conflict: concurrent writer committed first; please retry'
    });
  });

  it('reports accurate reconcile and cleanup counts', async () => {
    const db = createDb();
    const outbox = new VectorOutbox(db, {
      embeddingVersion: 'test-v1',
      maxRetries: 3,
      stuckThresholdMs: 60_000,
      cleanupDays: 7
    });
    const now = new Date('2026-05-25T00:00:00.000Z');
    const oldProcessingAt = new Date(now.getTime() - 120_000).toISOString();
    const freshProcessingAt = new Date(now.getTime() - 10_000).toISOString();
    const oldDoneAt = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const freshDoneAt = new Date(now.getTime() - 1_000).toISOString();

    db.prepare(`INSERT INTO vector_outbox (job_id, item_kind, item_id, embedding_version, status, retry_count, created_at, updated_at)
      VALUES (?, 'event', ?, 'test-v1', ?, ?, ?, ?)`).run('stuck-job', 'event-stuck', 'processing', 0, oldProcessingAt, oldProcessingAt);
    db.prepare(`INSERT INTO vector_outbox (job_id, item_kind, item_id, embedding_version, status, retry_count, created_at, updated_at)
      VALUES (?, 'event', ?, 'test-v1', ?, ?, ?, ?)`).run('active-job', 'event-active', 'processing', 0, freshProcessingAt, freshProcessingAt);
    db.prepare(`INSERT INTO vector_outbox (job_id, item_kind, item_id, embedding_version, status, retry_count, created_at, updated_at)
      VALUES (?, 'event', ?, 'test-v1', ?, ?, ?, ?)`).run('retry-job', 'event-retry', 'failed', 1, oldProcessingAt, oldProcessingAt);
    db.prepare(`INSERT INTO vector_outbox (job_id, item_kind, item_id, embedding_version, status, retry_count, created_at, updated_at)
      VALUES (?, 'event', ?, 'test-v1', ?, ?, ?, ?)`).run('exhausted-job', 'event-exhausted', 'failed', 3, oldProcessingAt, oldProcessingAt);
    db.prepare(`INSERT INTO vector_outbox (job_id, item_kind, item_id, embedding_version, status, retry_count, created_at, updated_at)
      VALUES (?, 'event', ?, 'test-v1', ?, ?, ?, ?)`).run('old-done', 'event-old-done', 'done', 0, oldDoneAt, oldDoneAt);
    db.prepare(`INSERT INTO vector_outbox (job_id, item_kind, item_id, embedding_version, status, retry_count, created_at, updated_at)
      VALUES (?, 'event', ?, 'test-v1', ?, ?, ?, ?)`).run('fresh-done', 'event-fresh-done', 'done', 0, freshDoneAt, freshDoneAt);

    const reconciled = await outbox.reconcile(now);
    expect(reconciled).toEqual({ recovered: 1, retried: 1 });

    const statuses = db.prepare('SELECT job_id, status FROM vector_outbox ORDER BY job_id').all();
    expect(statuses).toEqual([
      { job_id: 'active-job', status: 'processing' },
      { job_id: 'exhausted-job', status: 'failed' },
      { job_id: 'fresh-done', status: 'done' },
      { job_id: 'old-done', status: 'done' },
      { job_id: 'retry-job', status: 'pending' },
      { job_id: 'stuck-job', status: 'pending' }
    ]);

    const deleted = await outbox.cleanup(now);
    expect(deleted).toBe(1);
    expect(db.prepare("SELECT job_id FROM vector_outbox WHERE status = 'done' ORDER BY job_id").all()).toEqual([
      { job_id: 'fresh-done' }
    ]);
  });
});

describe('VectorWorkerV2 runtime processing', () => {
  it('processes pending V2 jobs through content lookup, embedding, versioned upsert, and done marking', async () => {
    const db = createDb();
    const outbox = new VectorOutbox(db, { embeddingVersion: 'worker-v2' });
    const jobId = await outbox.enqueue('event', 'event-runtime-1');
    const upsertedRecords: unknown[] = [];
    const contentProvider: ContentProvider = {
      getContent: async (itemKind, itemId) => ({
        content: 'worker-content-under-test should be embedded but never stored in outbox rows',
        metadata: {
          itemKind,
          eventType: 'user_prompt',
          sessionId: 'session-runtime-1',
          sourceEventCount: 2
        }
      })
    };
    const embedder = {
      embed: async (content: string) => ({
        vector: content.includes('worker-content-under-test') ? [0.11, 0.22, 0.33] : [0]
      })
    };
    const vectorStore = {
      upsertBatch: async (records: unknown[]) => {
        upsertedRecords.push(...records);
      }
    };
    const worker = new VectorWorkerV2(
      db,
      vectorStore as never,
      embedder as never,
      { batchSize: 10, embeddingVersion: 'worker-v2' },
      contentProvider
    );

    await expect(worker.processAll()).resolves.toBe(1);

    expect(db.prepare('SELECT job_id, status, retry_count, error FROM vector_outbox').all()).toEqual([
      { job_id: jobId, status: 'done', retry_count: 0, error: null }
    ]);
    expect(upsertedRecords).toEqual([
      expect.objectContaining({
        id: 'event_event-runtime-1_worker-v2',
        eventId: 'event-runtime-1',
        sessionId: 'session-runtime-1',
        eventType: 'user_prompt',
        content: 'worker-content-under-test should be embedded but never stored in outbox rows',
        vector: [0.11, 0.22, 0.33],
        metadata: expect.objectContaining({
          itemKind: 'event',
          embeddingVersion: 'worker-v2',
          sourceEventCount: 2
        })
      })
    ]);
    expectPrivateSentinelsAbsent(readOutboxRows(db), [
      'worker-content-under-test',
      'session-runtime-1'
    ]);
  });
});

describe('DefaultContentProvider perspective observation support', () => {
  it('returns null for perspective observation content when legacy stores have no perspective table', async () => {
    const db = new Database(':memory:');
    dbs.push(db);
    const provider = new DefaultContentProvider(db);

    await expect(provider.getContent('perspective_observation', 'obs-missing')).resolves.toBeNull();
  });

  it('returns vectorizable perspective observation content with privacy-minimal metadata', async () => {
    const db = createDb();
    const provider = new DefaultContentProvider(db);
    const now = '2026-05-25T00:00:00.000Z';

    db.prepare(`INSERT INTO perspective_observations (
      observation_id, project_hash, observer_actor_id, observed_actor_id, session_id, level, content,
      confidence, source_event_ids_json, source_observation_ids_json, source_hash, created_by,
      metadata_json, created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'obs-1',
      'project-hash',
      'assistant:manager',
      'assistant:coder',
      'session-1',
      'explicit',
      'Coder is blocked on vector outbox recovery and needs a focused test.',
      0.92,
      JSON.stringify(['event-1', 'event-2']),
      JSON.stringify([]),
      'hash-1',
      'test',
      JSON.stringify({ privateNote: 'not-returned' }),
      now,
      now,
      null
    );
    db.prepare(`INSERT INTO perspective_observations (
      observation_id, project_hash, observer_actor_id, observed_actor_id, session_id, level, content,
      confidence, source_event_ids_json, source_observation_ids_json, source_hash, created_by,
      metadata_json, created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'obs-deleted',
      'project-hash',
      'assistant:manager',
      'assistant:coder',
      'session-1',
      'explicit',
      'Deleted observation should not be vectorized.',
      0.5,
      JSON.stringify(['event-3']),
      JSON.stringify([]),
      'hash-deleted',
      'test',
      JSON.stringify({}),
      now,
      now,
      now
    );

    await expect(provider.getContent('perspective_observation', 'obs-deleted')).resolves.toBeNull();
    await expect(provider.getContent('perspective_observation', 'obs-1')).resolves.toEqual({
      content: 'Coder is blocked on vector outbox recovery and needs a focused test.',
      metadata: {
        itemKind: 'perspective_observation',
        level: 'explicit',
        projectHash: 'project-hash',
        observerActorId: 'assistant:manager',
        observedActorId: 'assistant:coder',
        sessionId: 'session-1',
        sourceEventCount: 2,
        sourceObservationCount: 0
      }
    });
  });
});
