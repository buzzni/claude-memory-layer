/**
 * Regression: tool_observation events are kept in SQLite (only their
 * embeddings are excluded), so on real projects they outnumber answer-type
 * events several-fold. An unfiltered FTS keyword lane therefore returned
 * mostly raw tool output — reproducing the exact "mem-search returns tool
 * noise" symptom the embedding exclusion was supposed to fix, through a
 * different lane.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

describe('keywordSearch tool_observation noise', () => {
  let tempDir: string;
  let store: SQLiteEventStore;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-memory-layer-test-'));
    store = new SQLiteEventStore(path.join(tempDir, 'events.sqlite'));
    await store.initialize();

    // Realistic ratio: many tool observations that all mention the topic,
    // one actual answer and one prompt about it.
    for (let i = 0; i < 8; i++) {
      await store.append({
        eventType: 'tool_observation',
        sessionId: 'session-1',
        timestamp: new Date(Date.now() - 1000 - i),
        content: JSON.stringify({ toolName: 'Bash', toolOutput: `grep browser cookie import scope run ${i}` })
      });
    }
    await store.append({
      eventType: 'user_prompt',
      sessionId: 'session-1',
      timestamp: new Date(),
      content: 'how is the browser cookie import scoped per host?'
    });
    await store.append({
      eventType: 'agent_response',
      sessionId: 'session-1',
      timestamp: new Date(),
      content: 'The browser cookie import is scoped per host via the partition audit.'
    });
  });

  afterEach(() => {
    try { store.close(); } catch { /* already closed */ }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('excludes tool_observation from FTS results by default so answers are not crowded out', async () => {
    const results = await store.keywordSearch('browser cookie import', 5);

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.event.eventType !== 'tool_observation')).toBe(true);
    expect(results.map((r) => r.event.eventType)).toEqual(
      expect.arrayContaining(['agent_response', 'user_prompt'])
    );
  });

  it('returns tool_observation matches when explicitly opted in', async () => {
    const results = await store.keywordSearch('browser cookie import', 20, { includeToolObservations: true });

    const types = new Set(results.map((r) => r.event.eventType));
    expect(types.has('tool_observation')).toBe(true);
    expect(types.has('agent_response')).toBe(true);
  });

  it('applies the same default exclusion on the LIKE fallback when FTS is unavailable', async () => {
    // Force the FTS path to fail so keywordSearch falls back to LIKE.
    const db = store.getDatabase();
    db.exec('DROP TRIGGER IF EXISTS events_fts_insert; DROP TRIGGER IF EXISTS events_fts_delete; DROP TRIGGER IF EXISTS events_fts_update; DROP TABLE IF EXISTS events_fts;');

    const results = await store.keywordSearch('browser cookie import', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.event.eventType !== 'tool_observation')).toBe(true);

    const optedIn = await store.keywordSearch('browser cookie import', 20, { includeToolObservations: true });
    expect(optedIn.some((r) => r.event.eventType === 'tool_observation')).toBe(true);
  });
});
