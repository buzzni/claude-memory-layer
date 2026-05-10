import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

async function withLegacyRetrievalTraceDb<T>(fn: (dbPath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cml-legacy-traces-'));
  const dbPath = path.join(root, 'events.sqlite');
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE retrieval_traces (
        trace_id TEXT PRIMARY KEY,
        session_id TEXT,
        project_hash TEXT,
        query_text TEXT NOT NULL,
        strategy TEXT,
        candidate_event_ids TEXT,
        selected_event_ids TEXT,
        candidate_details_json TEXT,
        selected_details_json TEXT,
        candidate_count INTEGER DEFAULT 0,
        selected_count INTEGER DEFAULT 0,
        confidence TEXT,
        fallback_trace TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    db.prepare(`
      INSERT INTO retrieval_traces (
        trace_id, session_id, query_text, strategy,
        candidate_event_ids, selected_event_ids,
        candidate_count, selected_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'trace-old-1',
      'session-old',
      'old dashboard query',
      'hybrid',
      JSON.stringify(['e1', 'e2', 'e3', 'e4']),
      JSON.stringify(['e1']),
      4,
      1,
      '2026-05-10 00:00:00'
    );
  } finally {
    db.close();
  }

  try {
    return await fn(dbPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('SQLiteEventStore legacy retrieval trace schema', () => {
  it('keeps dashboard retrieval stats read-only compatible when query_rewrite_kind is missing', async () => {
    await withLegacyRetrievalTraceDb(async (dbPath) => {
      const store = new SQLiteEventStore(dbPath, { readonly: true });
      try {
        await expect(store.getRetrievalTraceStats()).resolves.toMatchObject({
          totalQueries: 1,
          avgCandidateCount: 4,
          avgSelectedCount: 1,
          selectionRate: 0.25,
          rewrittenQueries: 0,
          rewriteRate: 0,
          rawQueriesWithSelection: 1,
          rewrittenQueriesWithSelection: 0,
          rewrittenSelectionRate: 0,
          rawSelectionRate: 1,
          avgSelectedCountForRewrittenQueries: 0,
          avgSelectedCountForRawQueries: 1,
        });
      } finally {
        await store.close();
      }
    });
  });
});
