import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { DefaultContentProvider } from '../../src/core/vector-worker.js';
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
