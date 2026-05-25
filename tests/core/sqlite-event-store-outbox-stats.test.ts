import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteRun } from '../../src/core/sqlite-wrapper.js';

const tempDirs: string[] = [];
const stores: SQLiteEventStore[] = [];

async function createStore(): Promise<SQLiteEventStore> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-outbox-stats-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  stores.push(store);
  await store.initialize();
  return store;
}

afterEach(async () => {
  while (stores.length > 0) {
    const store = stores.pop();
    await store?.close().catch(() => undefined);
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('SQLiteEventStore outbox health stats', () => {
  it('reports stuck processing counts and oldest processing age without exposing item payloads', async () => {
    const store = await createStore();
    const db = store.getDatabase();
    const now = new Date('2026-05-25T01:00:00.000Z');

    sqliteRun(
      db,
      `INSERT INTO embedding_outbox (id, event_id, content, status, retry_count, created_at, processed_at, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['emb-old-processing', 'event-private-1', 'PRIVATE_CONTENT_SENTINEL', 'processing', 0, '2026-05-25T00:48:00.000Z', '2026-05-25T00:50:00.000Z', null]
    );
    sqliteRun(
      db,
      `INSERT INTO embedding_outbox (id, event_id, content, status, retry_count, created_at, processed_at, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['emb-fresh-processing', 'event-private-2', 'PRIVATE_CONTENT_SENTINEL', 'processing', 0, '2026-05-25T00:59:00.000Z', null, null]
    );
    sqliteRun(
      db,
      `INSERT INTO embedding_outbox (id, event_id, content, status, retry_count, created_at, processed_at, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['emb-pending', 'event-private-3', 'PRIVATE_CONTENT_SENTINEL', 'pending', 0, '2026-05-25T00:57:00.000Z', null, null]
    );
    sqliteRun(
      db,
      `INSERT INTO embedding_outbox (id, event_id, content, status, retry_count, created_at, processed_at, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['emb-failed', 'event-private-4', 'PRIVATE_CONTENT_SENTINEL', 'failed', 3, '2026-05-25T00:56:00.000Z', null, 'PRIVATE_ERROR_SENTINEL']
    );
    sqliteRun(
      db,
      `INSERT INTO embedding_outbox (id, event_id, content, status, retry_count, created_at, processed_at, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['emb-done', 'event-private-5', 'PRIVATE_CONTENT_SENTINEL', 'done', 0, '2026-05-25T00:40:00.000Z', '2026-05-25T00:41:00.000Z', null]
    );

    sqliteRun(
      db,
      `INSERT INTO vector_outbox (job_id, item_kind, item_id, embedding_version, status, retry_count, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['vec-old-processing', 'perspective_observation', 'obs-private-1', 'v1', 'processing', 0, null, '2026-05-25T00:30:00.000Z', '2026-05-25T00:40:00.000Z']
    );
    sqliteRun(
      db,
      `INSERT INTO vector_outbox (job_id, item_kind, item_id, embedding_version, status, retry_count, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['vec-fresh-processing', 'event', 'event-private-6', 'v1', 'processing', 0, null, '2026-05-25T00:58:00.000Z', '2026-05-25T00:59:00.000Z']
    );
    sqliteRun(
      db,
      `INSERT INTO vector_outbox (job_id, item_kind, item_id, embedding_version, status, retry_count, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['vec-pending', 'entry', 'entry-private-1', 'v1', 'pending', 0, null, '2026-05-25T00:57:00.000Z', '2026-05-25T00:57:00.000Z']
    );
    sqliteRun(
      db,
      `INSERT INTO vector_outbox (job_id, item_kind, item_id, embedding_version, status, retry_count, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['vec-failed', 'task_title', 'task-private-1', 'v1', 'failed', 4, 'PRIVATE_VECTOR_ERROR_SENTINEL', '2026-05-25T00:56:00.000Z', '2026-05-25T00:56:00.000Z']
    );
    sqliteRun(
      db,
      `INSERT INTO vector_outbox (job_id, item_kind, item_id, embedding_version, status, retry_count, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['vec-done', 'entry', 'entry-private-2', 'v1', 'done', 0, null, '2026-05-25T00:55:00.000Z', '2026-05-25T00:55:00.000Z']
    );

    const stats = await store.getOutboxStats({ now, stuckThresholdMs: 5 * 60 * 1000 });

    expect(stats.embedding).toEqual({
      pending: 1,
      processing: 2,
      failed: 1,
      total: 5,
      stuckProcessing: 1,
      oldestProcessingAgeMs: 10 * 60 * 1000
    });
    expect(stats.vector).toEqual({
      pending: 1,
      processing: 2,
      failed: 1,
      total: 5,
      stuckProcessing: 1,
      oldestProcessingAgeMs: 20 * 60 * 1000
    });
    expect(JSON.stringify(stats)).not.toContain('PRIVATE_');
  });

  it('returns null oldest processing age when no work is processing', async () => {
    const store = await createStore();

    const stats = await store.getOutboxStats({ now: new Date('2026-05-25T01:00:00.000Z') });

    expect(stats.embedding.oldestProcessingAgeMs).toBeNull();
    expect(stats.vector.oldestProcessingAgeMs).toBeNull();
    expect(stats.embedding.stuckProcessing).toBe(0);
    expect(stats.vector.stuckProcessing).toBe(0);
  });
});
