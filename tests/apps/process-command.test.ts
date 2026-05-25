import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  formatProcessLockBusy,
  formatProcessRecoveryPreview,
  resolveProcessCommandOptions
} from '../../src/apps/cli/process-command.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteGet, sqliteRun } from '../../src/core/sqlite-wrapper.js';

const tempDirs: string[] = [];
const stores: SQLiteEventStore[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function closeStores() {
  while (stores.length > 0) {
    const store = stores.pop();
    await store?.close().catch(() => undefined);
  }
}

afterEach(async () => {
  await closeStores();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('process command recovery preview', () => {
  it('resolves dry-run recovery options without disabling normal recovery defaults', () => {
    expect(resolveProcessCommandOptions({ project: '/repo/app', dryRunRecovery: true })).toMatchObject({
      projectPath: '/repo/app',
      recoverStuck: true,
      dryRunRecovery: true
    });

    expect(resolveProcessCommandOptions({ project: '/repo/app', recoverStuck: false })).toMatchObject({
      projectPath: '/repo/app',
      recoverStuck: false,
      dryRunRecovery: false
    });
  });

  it('derives a project-scoped worker lock path and allows explicit test override', () => {
    const resolved = resolveProcessCommandOptions(
      { project: '/repo/private app' },
      '/cwd',
      { getProjectStoragePath: () => '/tmp/cml-private-store' }
    );
    expect(resolved).toEqual({
      projectPath: '/repo/private app',
      recoverStuck: true,
      dryRunRecovery: false,
      lockPath: '/tmp/cml-private-store/vector-worker.lock'
    });

    expect(resolveProcessCommandOptions(
      { project: '/repo/private app', lockPath: '/tmp/custom.lock' },
      '/cwd',
      { getProjectStoragePath: () => '/tmp/cml-private-store' }
    ).lockPath).toBe('/tmp/custom.lock');

    expect(() => resolveProcessCommandOptions(
      { project: '/repo/private app', lockPath: '   ' },
      '/cwd',
      { getProjectStoragePath: () => '/tmp/cml-private-store' }
    )).toThrow('--lock-path must not be empty');
  });

  it('formats aggregate-only lock contention output without outbox row details', () => {
    const output = formatProcessLockBusy({
      projectPath: '/repo/private-app',
      lockPath: '/tmp/cml-private-store/vector-worker.lock',
      holderPid: 1234
    });

    expect(output).toContain('Another vector worker is already running');
    expect(output).toContain('holderPid=1234');
    expect(output).toContain('lockPath=/tmp/cml-private-store/vector-worker.lock');
    expect(output).toContain('Project: /repo/private-app');
    expect(output).not.toContain('PRIVATE_CONTENT_SENTINEL');
    expect(output).not.toContain('event-private');
  });

  it('formats aggregate-only dry-run recovery output with the next command', () => {
    const output = formatProcessRecoveryPreview({
      projectPath: '/repo/private-app',
      stats: {
        embedding: { pending: 0, processing: 34, failed: 0, total: 34, stuckProcessing: 34, oldestProcessingAgeMs: 20 * 60 * 1000 },
        vector: { pending: 1, processing: 2, failed: 1, total: 4, stuckProcessing: 2, oldestProcessingAgeMs: 8 * 60 * 1000 }
      },
      recovery: {
        embedding: { recoveredProcessing: 34, retriedFailed: 0 },
        vector: { recoveredProcessing: 2, retriedFailed: 1 }
      }
    });

    expect(output).toContain('Mode: dry-run');
    expect(output).toContain('Would recover stuck processing: embedding=34, vector=2, total=36');
    expect(output).toContain('Would retry failed: embedding=0, vector=1, total=1');
    expect(output).toContain('Oldest processing age: 20m');
    expect(output).toContain('Next command: claude-memory-layer process --project /repo/private-app');
    expect(output).not.toContain('PRIVATE_CONTENT_SENTINEL');
    expect(output).not.toContain('event-private');
  });

  it('dry-runs the 34 stuck-processing dogfood case without mutating rows or processing embeddings', async () => {
    const dir = makeTempDir('cml-process-dogfood-');
    const dbPath = path.join(dir, 'events.sqlite');
    const store = new SQLiteEventStore(dbPath);
    stores.push(store);
    await store.initialize();
    const db = store.getDatabase();

    for (let i = 0; i < 34; i += 1) {
      sqliteRun(
        db,
        `INSERT INTO embedding_outbox (id, event_id, content, status, retry_count, created_at, processed_at, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `emb-stuck-${i}`,
          `event-private-${i}`,
          'PRIVATE_CONTENT_SENTINEL',
          'processing',
          0,
          '2026-05-25T00:00:00.000Z',
          '2026-05-25T00:00:00.000Z',
          null
        ]
      );
    }
    sqliteRun(
      db,
      `INSERT INTO embedding_outbox (id, event_id, content, status, retry_count, created_at, processed_at, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['emb-failed', 'event-private-failed', 'PRIVATE_CONTENT_SENTINEL', 'failed', 0, '2026-05-25T00:00:00.000Z', null, 'PRIVATE_ERROR_SENTINEL']
    );

    const now = new Date('2026-05-25T00:30:00.000Z');
    const stats = await store.getOutboxStats({ now, stuckThresholdMs: 5 * 60 * 1000 });
    const recovery = await store.recoverStuckOutboxItems({ dryRun: true, now, stuckThresholdMs: 5 * 60 * 1000 });
    const output = formatProcessRecoveryPreview({
      projectPath: '/repo/private-dogfood',
      stats,
      recovery
    });

    expect(output).toContain('Mode: dry-run');
    expect(output).toContain('Would recover stuck processing: embedding=34');
    expect(output).toContain('Would retry failed: embedding=1');
    expect(output).toContain('Next command: claude-memory-layer process --project /repo/private-dogfood');
    expect(output).not.toContain('Processed 0 embeddings');
    expect(output).not.toContain('PRIVATE_CONTENT_SENTINEL');
    expect(output).not.toContain('event-private-0');

    const remainingProcessing = sqliteGet<{ count: number }>(
      db,
      `SELECT COUNT(*) AS count FROM embedding_outbox WHERE status = 'processing'`
    );
    const remainingFailed = sqliteGet<{ count: number }>(
      db,
      `SELECT COUNT(*) AS count FROM embedding_outbox WHERE status = 'failed'`
    );
    expect(Number(remainingProcessing?.count ?? 0)).toBe(34);
    expect(Number(remainingFailed?.count ?? 0)).toBe(1);
  });
});
