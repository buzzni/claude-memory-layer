// @load-sensitive: the worker-thread case redacts thousands of long rows while a hook writes.
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyCredentialRedaction, REDACTION_BATCH_SIZE } from '../../src/core/operations/credential-redaction.js';
import { sqliteAll } from '../../src/core/sqlite-wrapper.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

/**
 * #228: `repair redact-credentials --apply` scans every stored text with the privacy filter.
 * Hooks keep writing meanwhile and give up after their busy timeout, so neither the scan nor
 * the apply may hold the write lock for long: the scan holds none, and the apply holds it for
 * one batch of updates at a time. A row that changes after the scan read it must not be
 * overwritten with the redacted form of its old value.
 */

// Runs inside the privacy filter, i.e. in the middle of the scan, when a test sets it.
let duringScan: ((content: string) => void) | undefined;

vi.mock('../../src/core/privacy/filter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/privacy/filter.js')>();
  return {
    ...actual,
    applyPrivacyFilter: (...args: Parameters<typeof actual.applyPrivacyFilter>) => {
      duringScan?.(args[0]);
      return actual.applyPrivacyFilter(...args);
    }
  };
});

const roots: string[] = [];
const stores: SQLiteEventStore[] = [];
const connections: Database.Database[] = [];

afterEach(async () => {
  duringScan = undefined;
  for (const db of connections.splice(0)) db.close();
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SECRET = 'api_key=sk-live-1234567890abcdef';
const SCAN_POINT = 'scan-hook-point: refactor the parser';

async function openStore(): Promise<{ store: SQLiteEventStore; dbPath: string; storagePath: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-redact-concurrency-'));
  roots.push(dir);
  const dbPath = path.join(dir, 'events.sqlite');
  const store = new SQLiteEventStore(dbPath);
  await store.initialize();
  stores.push(store);
  return { store, dbPath, storagePath: dir };
}

let tick = Date.parse('2026-01-01T00:00:00.000Z');
async function appendEvent(store: SQLiteEventStore, content: string): Promise<string> {
  const { eventId } = await store.append({
    eventType: 'user_prompt', sessionId: 's1', timestamp: new Date(tick++), content: `placeholder ${tick}`
  });
  // Rows written before the ingest-side filter existed still hold the raw secret.
  store.getDatabase().prepare('UPDATE events SET content = ? WHERE id = ?').run(content, eventId);
  return eventId!;
}

/** A second connection, as a hook process has, with a short busy timeout. */
function hookConnection(dbPath: string, busyTimeoutMs: number): Database.Database {
  const db = new Database(dbPath);
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  connections.push(db);
  return db;
}

function insertHookEvent(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO events (id, event_type, session_id, timestamp, content, canonical_key)
     VALUES (?, 'user_prompt', 'hook', ?, ?, ?)`
  ).run(id, new Date().toISOString(), `hook write ${id}`, `hook-${id}`);
}

function contentOf(store: SQLiteEventStore, eventId: string): string {
  return (store.getDatabase().prepare('SELECT content FROM events WHERE id = ?').get(eventId) as { content: string }).content;
}

const noVectors = async (): Promise<void> => undefined;

function redact(store: SQLiteEventStore, storagePath: string, options: {
  batchSize?: number;
  deleteEventVectors?: (eventIds: string[]) => Promise<void>;
} = {}) {
  return applyCredentialRedaction(store.getDatabase(), storagePath, {
    actor: 'cli', deleteEventVectors: noVectors, ...options
  });
}

describe('repair redact-credentials alongside hook writes', () => {
  it.each([1, 100])('lets a hook write while the scan runs, after a leaked row was found (batch size %i)', async (batchSize) => {
    const { store, dbPath, storagePath } = await openStore();
    const first = await appendEvent(store, `first call with ${SECRET}`);
    await appendEvent(store, SCAN_POINT);
    const last = await appendEvent(store, `second call with ${SECRET}`);
    const hook = hookConnection(dbPath, 100);
    const hookErrors: string[] = [];
    duringScan = (content) => {
      if (content !== SCAN_POINT) return;
      try {
        insertHookEvent(hook, 'hook-during-scan');
      } catch (error) {
        hookErrors.push((error as { code?: string }).code ?? String(error));
      }
    };

    await redact(store, storagePath, { batchSize });

    expect(hookErrors).toEqual([]);
    expect(contentOf(store, 'hook-during-scan')).toBe('hook write hook-during-scan');
    expect(contentOf(store, first)).not.toContain('sk-live');
    expect(contentOf(store, last)).not.toContain('sk-live');
  });

  it('leaves a row that changed after the scan read it, and redacts it on the next run', async () => {
    const { store, dbPath, storagePath } = await openStore();
    await appendEvent(store, SCAN_POINT);
    const edited = await appendEvent(store, `old text with ${SECRET}`);
    const hook = hookConnection(dbPath, 1000);
    const hookValue = 'new text written by a hook, api_key=sk-live-written-later';
    duringScan = (content) => {
      if (content !== SCAN_POINT) return;
      hook.prepare('UPDATE events SET content = ? WHERE id = ?').run(hookValue, edited);
    };

    const first = await redact(store, storagePath);

    // Not overwritten with the redacted form of the old text the scan read.
    expect(contentOf(store, edited)).toBe(hookValue);
    expect(first).toMatchObject({ rowChanges: [], affectedEventIds: [], rowsSkipped: 1 });

    duringScan = undefined;
    const second = await redact(store, storagePath);
    expect(second).toMatchObject({ affectedEventIds: [edited], rowsSkipped: 0 });
    expect(contentOf(store, edited)).toContain('new text written by a hook');
    expect(contentOf(store, edited)).not.toContain('sk-live');
  });

  it('holds the write lock for one batch at a time while a hook on another thread keeps writing', async () => {
    const { store, dbPath, storagePath } = await openStore();
    // Thousands of long leaked rows: every one changes, so the transactions, not the scan, carry the work.
    const leakedCount = 2500;
    const body = 'ordinary prompt text about refactoring the module and running the tests. '.repeat(50);
    const seed = store.getDatabase().prepare(
      `INSERT INTO events (id, event_type, session_id, timestamp, content, canonical_key)
       VALUES (?, 'user_prompt', 'bulk', ?, ?, ?)`
    );
    // Each leaked event also waits in the embedding queue twice, with its own copy of the text, so every
    // batch drops queued jobs too.
    const queue = store.getDatabase().prepare(
      `INSERT INTO embedding_outbox (id, event_id, content, status, retry_count) VALUES (?, ?, ?, 'pending', 0)`
    );
    store.getDatabase().transaction(() => {
      for (let i = 0; i < leakedCount; i++) {
        const text = `${body} call ${i} with ${SECRET}`;
        seed.run(`leaked-${i}`, new Date(tick++).toISOString(), text, `leaked-${i}`);
        for (const job of [1, 2]) queue.run(`job-${i}-${job}`, `leaked-${i}`, text);
      }
    })();

    const hookBusyTimeoutMs = 5000; // what the hooks run with (sqlite-wrapper)
    const flags = new Int32Array(new SharedArrayBuffer(12)); // [0] worker ready, [1] stop, [2] writes
    const worker = new Worker(HOOK_WORKER, {
      eval: true,
      workerData: {
        betterSqlite3Path: createRequire(import.meta.url).resolve('better-sqlite3'),
        dbPath,
        busyTimeoutMs: hookBusyTimeoutMs,
        flags: flags.buffer
      }
    });
    const result = new Promise<{ writes: number; maxWriteMs: number; errors: string[] }>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    try {
      expect(Atomics.wait(flags, 0, 0, 10_000)).not.toBe('timed-out');

      const plan = await redact(store, storagePath, {
        // Between batches, wait for the hook to get a write in, so the two really interleave.
        deleteEventVectors: async () => {
          const seen = Atomics.load(flags, 2);
          const deadline = Date.now() + 10_000;
          while (Atomics.load(flags, 2) === seen) {
            if (Date.now() > deadline) throw new Error('the hook made no write between two batches');
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        }
      });
      Atomics.store(flags, 1, 1);
      const hook = await result;

      expect(hook.errors).toEqual([]);
      expect(plan.vectorDeleteFailures).toEqual([]);
      const batches = sqliteAll<{ after_json: string; source_event_ids: string }>(
        store.getDatabase(),
        `SELECT after_json, source_event_ids FROM memory_governance_audit
         WHERE operation = 'credential_redact' AND json_extract(after_json, '$.summary') IS NULL`
      );
      expect(batches).toHaveLength(Math.ceil(leakedCount / REDACTION_BATCH_SIZE));
      for (const row of batches) {
        expect(JSON.parse(row.after_json).rowsRedacted).toBeLessThanOrEqual(REDACTION_BATCH_SIZE);
        expect(JSON.parse(row.source_event_ids).length).toBeLessThanOrEqual(REDACTION_BATCH_SIZE);
      }
      // One batch, audit row included, holds the lock for a small part of what a hook will wait.
      expect(plan.longestBatchLockMs).toBeLessThan(hookBusyTimeoutMs / 5);
      expect(sqliteAll(store.getDatabase(), `SELECT 1 FROM events WHERE content LIKE '%sk-live%'`)).toEqual([]);
      expect(sqliteAll(store.getDatabase(), `SELECT 1 FROM embedding_outbox WHERE content LIKE '%sk-live%'`)).toEqual([]);
    } finally {
      Atomics.store(flags, 1, 1);
      await worker.terminate();
    }
  }, 120_000);
});

const HOOK_WORKER = `
const { workerData, parentPort } = require('node:worker_threads');
const Database = require(workerData.betterSqlite3Path);
const flags = new Int32Array(workerData.flags);
const db = new Database(workerData.dbPath);
db.pragma('busy_timeout = ' + workerData.busyTimeoutMs);
const insert = db.prepare(
  "INSERT INTO events (id, event_type, session_id, timestamp, content, canonical_key) VALUES (?, 'user_prompt', 'hook', ?, ?, ?)"
);
const result = { writes: 0, maxWriteMs: 0, errors: [] };
Atomics.store(flags, 0, 1);
Atomics.notify(flags, 0);
for (let i = 0; Atomics.load(flags, 1) === 0; i++) {
  const started = performance.now();
  try {
    insert.run('worker-' + i, new Date().toISOString(), 'hook write ' + i, 'worker-' + i);
    result.writes += 1;
    Atomics.add(flags, 2, 1);
  } catch (error) {
    result.errors.push(String(error.code || error.message));
  }
  result.maxWriteMs = Math.max(result.maxWriteMs, performance.now() - started);
  Atomics.wait(flags, 1, 0, 1);
}
db.close();
parentPort.postMessage(result);
`;
