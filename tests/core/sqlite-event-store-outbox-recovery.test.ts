import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cml-outbox-recovery-'));
  tempDirs.push(dir);
  return join(dir, 'events.sqlite');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('SQLiteEventStore outbox recovery', () => {
  it('recovers stale embedding_outbox and vector_outbox processing rows back to pending', async () => {
    const dbPath = tempDbPath();
    const store = new SQLiteEventStore(dbPath);
    await store.initialize();

    const embeddingId = await store.enqueueForEmbedding('event-1', 'stale embedding content');
    const claimed = await store.getPendingOutboxItems(10);
    expect(claimed.map((item) => item.id)).toEqual([embeddingId]);

    const db = new Database(dbPath);
    db.prepare(`UPDATE embedding_outbox SET processed_at = datetime('now', '-30 minutes') WHERE id = ?`).run(embeddingId);
    db.prepare(`INSERT INTO vector_outbox (
      job_id, item_kind, item_id, embedding_version, status, retry_count, error, created_at, updated_at
    ) VALUES (?, 'event', 'event-1', 'v1', 'processing', 0, NULL, datetime('now', '-30 minutes'), datetime('now', '-30 minutes'))`).run('vector-job-1');
    db.close();

    const recovered = await store.recoverStuckOutboxItems({ stuckThresholdMs: 5 * 60 * 1000 });

    expect(recovered).toMatchObject({
      embedding: { recoveredProcessing: 1, retriedFailed: 0 },
      vector: { recoveredProcessing: 1, retriedFailed: 0 }
    });

    const stats = await store.getOutboxStats();
    expect(stats.embedding).toMatchObject({ pending: 1, processing: 0, failed: 0, total: 1 });
    expect(stats.vector).toMatchObject({ pending: 1, processing: 0, failed: 0, total: 1 });

    const retryable = await store.getPendingOutboxItems(10);
    expect(retryable.map((item) => item.id)).toEqual([embeddingId]);

    await store.close();
  });

  it('does not recover fresh processing rows before the stale threshold', async () => {
    const dbPath = tempDbPath();
    const store = new SQLiteEventStore(dbPath);
    await store.initialize();

    await store.enqueueForEmbedding('event-2', 'fresh embedding content');
    await store.getPendingOutboxItems(10);

    const recovered = await store.recoverStuckOutboxItems({ stuckThresholdMs: 60 * 60 * 1000 });

    expect(recovered.embedding.recoveredProcessing).toBe(0);
    const stats = await store.getOutboxStats();
    expect(stats.embedding).toMatchObject({ pending: 0, processing: 1, failed: 0, total: 1 });

    await store.close();
  });
});
