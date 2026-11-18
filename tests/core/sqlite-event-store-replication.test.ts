/**
 * Tests for SQLiteEventStore replication helpers used by Mongo sync.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { LessonRepository } from '../../src/core/operations/lesson-repository.js';

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

  it('deleteSessionEvents with importedFrom deletes only the rows a reimport from that source puts back', async () => {
    const source = '/home/user/.claude/projects/p/reimport-me.jsonl';
    const append = (eventType: 'user_prompt' | 'agent_response' | 'session_summary' | 'tool_observation', content: string, metadata?: Record<string, unknown>) =>
      storeA.append({ eventType, sessionId: 'reimport-me', timestamp: new Date(), content, ...(metadata ? { metadata } : {}) });

    const apricot = await append('user_prompt', 'imported apricot prompt', { importedFrom: source });
    const banana = await append('agent_response', 'imported banana response', { importedFrom: source });
    await append('session_summary', 'hook written fig summary');
    await append('user_prompt', 'hook written grape prompt', { turnId: 'hook-turn' });
    // Another source, a row pulled from another machine, a type no importer
    // writes, and a row a lesson cites are not put back by this reimport.
    await append('user_prompt', 'other source kiwi prompt', { importedFrom: '/home/user/.hermes/state.db' });
    await append('agent_response', 'pulled lemon response', { importedFrom: source, mongoSync: { remoteId: 'r1' } });
    await append('tool_observation', 'tool mango output', { importedFrom: source });
    const cited = await append('agent_response', 'cited nectarine response', { importedFrom: source });
    if (!cited.success) throw new Error('append failed');
    await new LessonRepository(storeA.getDatabase()).upsert({
      projectHash: 'project-1', name: 'Cited lesson', trigger: 'When releasing', steps: ['Check the tag'],
      confidence: 0.8, sourceSessionIds: ['reimport-me'], sourceEventIds: [cited.eventId], failureModes: [], skillCandidate: false, actor: 'tester'
    });
    await storeA.append({ eventType: 'user_prompt', sessionId: 'other-session', timestamp: new Date(), content: 'imported cherry prompt', metadata: { importedFrom: source } });

    // Exactly the deleted ids, for the caller to delete their vectors (#250).
    const { deleted, eventIds } = await storeA.deleteSessionEventsWithIds('reimport-me', { importedFrom: source });
    expect(deleted).toBe(2);
    expect([...eventIds].sort()).toEqual([apricot.eventId, banana.eventId].sort());

    expect((await storeA.getSessionEvents('reimport-me')).map((event) => event.content).sort()).toEqual([
      'cited nectarine response', 'hook written fig summary', 'hook written grape prompt',
      'other source kiwi prompt', 'pulled lemon response', 'tool mango output'
    ]);
    expect((await storeA.keywordSearch('fig', 5)).map((result) => result.event.content)).toEqual(['hook written fig summary']);
    await expect(storeA.keywordSearch('apricot', 5)).resolves.toEqual([]);
    expect((await storeA.keywordSearch('cherry', 5)).map((result) => result.event.content)).toEqual(['imported cherry prompt']);
  });

  it('deleteSessionEvents drops the vector outbox jobs of the rows it deletes, and the rows put back are queued again', async () => {
    const store = new SQLiteEventStore(path.join(tempDir, 'outbox.sqlite'), { vectorOutbox: {} });
    await store.initialize();
    const db = store.getDatabase();
    const jobs = (eventIds: string[]) => db.prepare(
      `SELECT item_id AS id, status FROM vector_outbox WHERE item_kind = 'event' AND item_id IN (${eventIds.map(() => '?').join(', ')})`
    ).all(...eventIds);
    const source = '/home/user/.claude/projects/p/outbox.jsonl';
    const append = (content: string, importedFrom?: string) => store.append({
      eventType: 'user_prompt', sessionId: 'outbox', timestamp: new Date(), content, ...(importedFrom ? { metadata: { importedFrom } } : {})
    });
    try {
      const imported = await append('imported plum prompt', source);
      const hook = await append('hook written pear prompt');
      db.prepare(`UPDATE vector_outbox SET status = 'done'`).run();

      await expect(store.deleteSessionEvents('outbox', { importedFrom: source })).resolves.toBe(1);
      expect(jobs([imported.eventId!])).toEqual([]);
      expect(jobs([hook.eventId!])).toEqual([{ id: hook.eventId, status: 'done' }]);

      const putBack = await append('imported plum prompt', source);
      expect(putBack).toMatchObject({ success: true, isDuplicate: false });
      expect(jobs([putBack.eventId!])).toEqual([{ id: putBack.eventId, status: 'pending' }]);
    } finally {
      store.close();
    }
  });

  it('deleteSessionEvents with importedFrom still deletes when a lesson lists a null source id', async () => {
    const source = '/home/user/.claude/projects/p/null-cite.jsonl';
    await storeA.append({ eventType: 'user_prompt', sessionId: 'null-cite', timestamp: new Date(), content: 'imported quince prompt', metadata: { importedFrom: source } });
    await new LessonRepository(storeA.getDatabase()).upsert({
      projectHash: 'project-1', name: 'Other lesson', trigger: 'When releasing', steps: ['Check the tag'],
      confidence: 0.8, sourceSessionIds: [], sourceEventIds: ['some-other-event'], failureModes: [], skillCandidate: false, actor: 'tester'
    });
    storeA.getDatabase().prepare(`UPDATE memory_lessons SET source_event_ids = '["some-other-event", null]'`).run();

    await expect(storeA.deleteSessionEvents('null-cite', { importedFrom: source })).resolves.toBe(1);
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


  it('aggregates retrieval trace stats by strategy including context-pack usage', async () => {
    await storeA.recordRetrievalTrace({
      sessionId: 'strategy-session',
      rawQueryText: '계속',
      queryText: 'Previous user: improve memory usage\nCurrent user: 계속',
      queryRewriteKind: 'follow-up-context',
      strategy: 'mcp-context-pack',
      candidateEventIds: ['candidate-1', 'candidate-2', 'candidate-3'],
      selectedEventIds: ['candidate-1']
    });
    await storeA.recordRetrievalTrace({
      sessionId: 'strategy-session',
      queryText: 'self contained search',
      queryRewriteKind: 'none',
      strategy: 'mcp-context-pack',
      candidateEventIds: ['candidate-4', 'candidate-5'],
      selectedEventIds: []
    });
    await storeA.recordRetrievalTrace({
      sessionId: 'strategy-session',
      queryText: 'session start project context',
      queryRewriteKind: 'intent-rewrite',
      strategy: 'session-start-hook',
      candidateEventIds: ['candidate-6'],
      selectedEventIds: ['candidate-6']
    });

    const stats = await storeA.getRetrievalTraceStats();

    expect(stats.strategyBreakdown).toEqual([
      {
        strategy: 'mcp-context-pack',
        totalQueries: 2,
        queriesWithSelection: 1,
        rewrittenQueries: 1,
        rewriteRate: 0.5,
        totalCandidateCount: 5,
        totalSelectedCount: 1,
        avgCandidateCount: 2.5,
        avgSelectedCount: 0.5,
        selectionRate: 0.2,
        queryYieldRate: 0.5
      },
      {
        strategy: 'session-start-hook',
        totalQueries: 1,
        queriesWithSelection: 1,
        rewrittenQueries: 1,
        rewriteRate: 1,
        totalCandidateCount: 1,
        totalSelectedCount: 1,
        avgCandidateCount: 1,
        avgSelectedCount: 1,
        selectionRate: 1,
        queryYieldRate: 1
      }
    ]);
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
