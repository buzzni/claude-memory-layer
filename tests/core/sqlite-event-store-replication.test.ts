/**
 * Tests for SQLiteEventStore replication helpers used by Mongo sync.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

describe('SQLiteEventStore replication helpers', () => {
  let tempDir: string;
  let storeA: SQLiteEventStore;
  let storeB: SQLiteEventStore;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-memory-layer-test-'));
    storeA = new SQLiteEventStore(path.join(tempDir, 'a.sqlite'));
    storeB = new SQLiteEventStore(path.join(tempDir, 'b.sqlite'));
    await storeA.initialize();
    await storeB.initialize();
  });

  afterEach(() => {
    try { storeA.close(); } catch {}
    try { storeB.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('getEventsSinceRowid returns incremental batches in insertion order', async () => {
    const sessionId = 'session-1';

    await storeA.append({ eventType: 'user_prompt', sessionId, timestamp: new Date(), content: 'a' });
    await storeA.append({ eventType: 'user_prompt', sessionId, timestamp: new Date(), content: 'b' });
    await storeA.append({ eventType: 'user_prompt', sessionId, timestamp: new Date(), content: 'c' });

    const batch1 = await storeA.getEventsSinceRowid(0, 10);
    expect(batch1).toHaveLength(3);
    expect(batch1.map(x => x.event.content)).toEqual(['a', 'b', 'c']);

    // rowid should be strictly increasing
    expect(batch1[0].rowid).toBeLessThan(batch1[1].rowid);
    expect(batch1[1].rowid).toBeLessThan(batch1[2].rowid);

    const lastRowid = batch1[2].rowid;

    await storeA.append({ eventType: 'user_prompt', sessionId, timestamp: new Date(), content: 'd' });

    const batch2 = await storeA.getEventsSinceRowid(lastRowid, 10);
    expect(batch2).toHaveLength(1);
    expect(batch2[0].event.content).toBe('d');
  });

  it('importEvents preserves stable IDs and is idempotent via dedupeKey', async () => {
    const sessionId = 'session-2';
    const appendRes = await storeA.append({
      eventType: 'user_prompt',
      sessionId,
      timestamp: new Date(),
      content: 'hello world'
    });

    expect(appendRes.success).toBe(true);
    const sourceEvent = await storeA.getEvent(appendRes.eventId!);
    expect(sourceEvent).not.toBeNull();

    const imported1 = await storeB.importEvents([sourceEvent!]);
    expect(imported1.inserted).toBe(1);
    expect(imported1.skipped).toBe(0);

    const importedEvent = await storeB.getEvent(sourceEvent!.id);
    expect(importedEvent?.content).toBe('hello world');

    // Importing again should be a no-op
    const imported2 = await storeB.importEvents([sourceEvent!]);
    expect(imported2.inserted).toBe(0);
    expect(imported2.skipped).toBe(1);

    // append() should treat it as duplicate due to event_dedup entry
    const dup = await storeB.append({
      eventType: 'user_prompt',
      sessionId,
      timestamp: new Date(),
      content: 'hello world'
    });
    expect(dup.success).toBe(true);
    expect(dup.isDuplicate).toBe(true);
    expect(dup.eventId).toBe(sourceEvent!.id);
  });

  it('keeps FTS event_id populated after deleteSessionEvents recreates triggers', async () => {
    await storeA.append({ eventType: 'user_prompt', sessionId: 'delete-me', timestamp: new Date(), content: 'temporary kiwi memory' });
    await storeA.append({ eventType: 'user_prompt', sessionId: 'keep-me', timestamp: new Date(), content: 'persistent pineapple memory' });

    await expect(storeA.deleteSessionEvents('delete-me')).resolves.toBe(1);

    const appendAfterTriggerRecreation = await storeA.append({
      eventType: 'user_prompt',
      sessionId: 'keep-me',
      timestamp: new Date(),
      content: 'fresh dragonfruit memory'
    });
    expect(appendAfterTriggerRecreation.success).toBe(true);

    await expect(storeA.rebuildFtsIndex()).resolves.toBe(2);
    const results = await storeA.keywordSearch('dragonfruit', 5);

    expect(results.map((result) => result.event.content)).toEqual(['fresh dragonfruit memory']);
  });

  it('supports event updates and deletes on a fresh FTS table before manual rebuild', async () => {
    const appendResult = await storeA.append({
      eventType: 'user_prompt',
      sessionId: 'mutable-session',
      timestamp: new Date(),
      content: 'mutable mango memory'
    });
    expect(appendResult.success).toBe(true);
    if (!appendResult.success) return;

    await expect(storeA.incrementAccessCount([appendResult.eventId])).resolves.toBeUndefined();
    await expect(storeA.deleteSessionEvents('mutable-session')).resolves.toBe(1);
    await expect(storeA.keywordSearch('mango', 5)).resolves.toEqual([]);
  });

  it('parses SQLite UTC datetime strings without local timezone shifts for retrieval traces', async () => {
    await storeA.recordRetrievalTrace({
      sessionId: 'trace-session',
      projectHash: 'trace-project',
      queryText: 'timezone boundary query',
      candidateEventIds: ['candidate-1'],
      selectedEventIds: ['candidate-1']
    });

    const db = (storeA as unknown as {
      db: { prepare: (sql: string) => { run: (...params: unknown[]) => unknown } };
    }).db;
    db.prepare(`UPDATE retrieval_traces SET created_at = ? WHERE query_text = ?`)
      .run('2026-05-07 16:00:00', 'timezone boundary query');

    const [trace] = await storeA.getRecentRetrievalTraces(1);
    expect(trace.createdAt.toISOString()).toBe('2026-05-07T16:00:00.000Z');
  });

  it('persists retrieval lane debug metadata in trace details', async () => {
    await storeA.recordRetrievalTrace({
      sessionId: 'lane-session',
      projectHash: 'lane-project',
      queryText: 'lane debug query',
      candidateEventIds: ['candidate-1'],
      selectedEventIds: ['candidate-1'],
      candidateDetails: [{
        eventId: 'candidate-1',
        score: 0.93,
        lanes: [
          { lane: 'raw_event', reason: 'vector_search', score: 0.93 },
          { lane: 'facet_match', reason: 'workflow=debugging' }
        ]
      }],
      selectedDetails: [{
        eventId: 'candidate-1',
        score: 0.93,
        lanes: [{ lane: 'raw_event', reason: 'vector_search', score: 0.93 }]
      }]
    });

    const [trace] = await storeA.getRecentRetrievalTraces(1);
    expect(trace.candidateDetails[0].lanes).toEqual([
      { lane: 'raw_event', reason: 'vector_search', score: 0.93 },
      { lane: 'facet_match', reason: 'workflow=debugging' }
    ]);
    expect(trace.selectedDetails[0].lanes).toEqual([
      { lane: 'raw_event', reason: 'vector_search', score: 0.93 }
    ]);
  });

  it('sanitizes retrieval lane metadata at the SQLite persistence boundary', async () => {
    const fixturePath = path.join('/Users', 'fixture-user', 'project', 'trace.txt');
    const fixtureToken = ['ghp', 'fixtureCredentialShape'].join('_');
    const fixtureSecret = ['sk', 'fixtureCredentialShape'].join('-');
    const secretKey = ['client', 'secret'].join('_');

    await storeA.recordRetrievalTrace({
      sessionId: 'unsafe-lane-session',
      projectHash: 'lane-project',
      queryText: 'unsafe lane debug query',
      candidateEventIds: ['candidate-1'],
      selectedEventIds: ['candidate-1'],
      candidateDetails: [{
        eventId: 'candidate-1',
        score: 0.5,
        lanes: [
          { lane: 'raw_event', reason: `source=${fixturePath} token: ${fixtureToken}`, score: 2 },
          { lane: 'unsafe_lane', reason: `${secretKey}=${fixtureSecret}` },
          { lane: 'facet_match', reason: `${secretKey}=${fixtureSecret}` }
        ] as any
      }],
      selectedDetails: [{
        eventId: 'candidate-1',
        score: 0.5,
        lanes: [
          { lane: 'raw_event', reason: `standalone ${fixtureToken}`, score: Number.NaN },
          { lane: 'graph_path', reason: `authorization Bearer ${fixtureToken}`, score: -2 }
        ] as any
      }]
    });

    const [trace] = await storeA.getRecentRetrievalTraces(1);
    expect(trace.candidateDetails[0].lanes).toEqual([
      { lane: 'raw_event', reason: 'source=[path] token: [REDACTED]', score: 1 },
      { lane: 'facet_match', reason: 'client_secret=[REDACTED]' }
    ]);
    expect(trace.selectedDetails[0].lanes).toEqual([
      { lane: 'raw_event', reason: 'standalone [REDACTED]' },
      { lane: 'graph_path', reason: 'authorization Bearer [REDACTED]', score: 0 }
    ]);
  });

  it('stores query rewrite telemetry and aggregates rewritten query yield', async () => {
    await storeA.recordRetrievalTrace({
      sessionId: 'rewrite-session',
      projectHash: 'rewrite-project',
      rawQueryText: '계속',
      queryText: 'Previous user: implement retrieval\nCurrent user: 계속',
      queryRewriteKind: 'follow-up-context',
      candidateEventIds: ['candidate-1', 'candidate-2'],
      selectedEventIds: ['candidate-1']
    });
    await storeA.recordRetrievalTrace({
      sessionId: 'rewrite-session',
      projectHash: 'rewrite-project',
      rawQueryText: 'self contained query',
      queryText: 'self contained query',
      queryRewriteKind: 'none',
      candidateEventIds: ['candidate-3'],
      selectedEventIds: []
    });

    const traces = await storeA.getRecentRetrievalTraces(2);
    const rewrittenTrace = traces.find((trace) => trace.queryRewriteKind === 'follow-up-context');
    expect(rewrittenTrace).toMatchObject({
      rawQueryText: '계속',
      queryText: 'Previous user: implement retrieval\nCurrent user: 계속',
      queryRewriteKind: 'follow-up-context',
      selectedCount: 1,
      candidateCount: 2
    });

    await expect(storeA.getRetrievalTraceStats()).resolves.toMatchObject({
      totalQueries: 2,
      rewrittenQueries: 1,
      rewriteRate: 0.5,
      rewrittenQueriesWithSelection: 1,
      rawQueriesWithSelection: 0,
      rewrittenSelectionRate: 1,
      rawSelectionRate: 0,
      avgSelectedCountForRewrittenQueries: 1,
      avgSelectedCountForRawQueries: 0
    });
  });

  it('normalizes malformed query rewrite kinds before returning trace stats', async () => {
    await storeA.recordRetrievalTrace({
      sessionId: 'normalize-session',
      queryText: 'trimmed none query',
      queryRewriteKind: ' none ',
      candidateEventIds: ['candidate-1'],
      selectedEventIds: ['candidate-1']
    });
    await storeA.recordRetrievalTrace({
      sessionId: 'normalize-session',
      queryText: 'unknown rewrite query',
      queryRewriteKind: 'surprise-kind',
      candidateEventIds: ['candidate-2'],
      selectedEventIds: ['candidate-2']
    });
    await storeA.recordRetrievalTrace({
      sessionId: 'normalize-session',
      rawQueryText: '계속',
      queryText: 'expanded follow up query',
      queryRewriteKind: ' INTENT-REWRITE ',
      candidateEventIds: ['candidate-3'],
      selectedEventIds: ['candidate-3']
    });

    const traces = await storeA.getRecentRetrievalTraces(3);
    expect(traces.map((trace) => trace.queryRewriteKind).sort()).toEqual([
      'intent-rewrite',
      'none',
      'none'
    ]);
    await expect(storeA.getRetrievalTraceStats()).resolves.toMatchObject({
      totalQueries: 3,
      rewrittenQueries: 1,
      rewriteRate: 1 / 3,
      rewrittenQueriesWithSelection: 1,
      rawQueriesWithSelection: 2,
      rewrittenSelectionRate: 1,
      rawSelectionRate: 1,
    });
  });

  it('filters helpfulness statistics by the requested time window', async () => {
    await storeA.recordRetrieval('old-event', 'old-session', 0.2, 'old retrieval query');
    await storeA.recordRetrieval('new-event', 'new-session', 0.8, 'new retrieval query');

    const db = (storeA as unknown as {
      db: { prepare: (sql: string) => { run: (...params: unknown[]) => unknown } };
    }).db;
    db.prepare(`
      UPDATE memory_helpfulness
      SET helpfulness_score = ?, created_at = ?, measured_at = ?
      WHERE event_id = ?
    `).run(0.2, '2026-04-01T00:00:00.000Z', '2026-05-08T00:00:00.000Z', 'old-event');
    db.prepare(`
      UPDATE memory_helpfulness
      SET helpfulness_score = ?, created_at = ?, measured_at = ?
      WHERE event_id = ?
    `).run(0.8, '2026-05-08T00:00:00.000Z', '2026-05-08T00:00:00.000Z', 'new-event');

    await expect(storeA.getHelpfulnessStats()).resolves.toMatchObject({
      avgScore: 0.5,
      totalEvaluated: 2,
      totalRetrievals: 2,
      helpful: 1,
      neutral: 0,
      unhelpful: 1
    });
    await expect(storeA.getHelpfulnessStats(new Date('2026-05-01T00:00:00.000Z'))).resolves.toMatchObject({
      avgScore: 0.8,
      totalEvaluated: 1,
      totalRetrievals: 1,
      helpful: 1,
      neutral: 0,
      unhelpful: 0
    });
  });
});

