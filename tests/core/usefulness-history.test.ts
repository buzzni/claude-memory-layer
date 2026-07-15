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
  const dir = mkdtempSync(join(tmpdir(), 'cml-usefulness-history-'));
  tempDirs.push(dir);
  return join(dir, 'events.sqlite');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function appendEvent(
  store: SQLiteEventStore,
  eventType: 'user_prompt' | 'agent_response' | 'tool_observation',
  sessionId: string,
  content: string,
  timestamp: Date
): Promise<string> {
  const result = await store.append({ eventType, sessionId, content, timestamp });
  if (!result.success) throw new Error(`append failed: ${result.error}`);
  return result.eventId;
}

describe('usefulness evidence history (store integration)', () => {
  it('links question -> injected memory -> grounded helpfulness with evidence', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();

    const past = new Date('2026-01-01T10:00:00.000Z');
    const memoryId = await appendEvent(
      store,
      'agent_response',
      'old-session',
      'The deploy port is 37777 and the release script is scripts/release-npm.sh.',
      past
    );

    await appendEvent(store, 'user_prompt', 's1', 'how do I deploy this project?', new Date('2026-01-02T10:00:00.000Z'));
    await store.recordRetrieval(memoryId, 's1', 0.9, 'how do I deploy this project?', {
      traceId: 'trace-1',
      source: 'user_prompt'
    });
    await store.recordRetrievalTrace({
      traceId: 'trace-1',
      sessionId: 's1',
      queryText: 'how do I deploy this project?',
      rawQueryText: 'how do I deploy this project?',
      strategy: 'hybrid',
      candidateEventIds: [memoryId],
      selectedEventIds: [memoryId],
      confidence: 'high'
    });

    // Assistant answer that clearly reuses the memory (a day later, so it is
    // unambiguously "after" the retrieval row's datetime('now') timestamp).
    await appendEvent(
      store,
      'agent_response',
      's1',
      'You deploy it like this: the deploy port is 37777 and the release script is scripts/release-npm.sh.',
      new Date('2100-01-01T10:00:00.000Z')
    );

    await store.evaluateSessionHelpfulness('s1');

    const stats = await store.getHelpfulnessStats();
    expect(stats.totalEvaluated).toBe(1);
    expect(stats.contentEvaluated).toBe(1);
    expect(stats.avgContentOverlap).toBeGreaterThan(0.5);
    expect(stats.groundedCount).toBe(1);

    const history = await store.getUsefulnessHistory();
    expect(history).toHaveLength(1);
    const entry = history[0];
    expect(entry.kind).toBe('query');
    expect(entry.traceId).toBe('trace-1');
    expect(entry.question).toBe('how do I deploy this project?');
    expect(entry.memories).toHaveLength(1);
    expect(entry.memories[0].eventId).toBe(memoryId);
    expect(entry.memories[0].helpfulnessScore).toBeGreaterThan(0.5);
    expect(entry.memories[0].contentOverlapScore).toBeGreaterThan(0.5);
    expect(entry.memories[0].evidence.length).toBeGreaterThan(0);
    expect(entry.memories[0].evidence[0].responseSnippet.length).toBeGreaterThan(0);

    await store.close();
  });

  it('grounds against the injected snapshot, not the full stored event', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();

    // A memory whose distinctive fact lives beyond the 300-char injection cut.
    const filler = 'This memory starts with generic filler text that pads the beginning of the event. '.repeat(4);
    const lateFact = 'The production database password rotation runs every fourteen days via cron.';
    const memoryId = await appendEvent(
      store,
      'agent_response',
      'old-session',
      `${filler}\n${lateFact}`,
      new Date('2026-01-01T10:00:00.000Z')
    );

    const injectedSnapshot = `${filler}\n${lateFact}`.substring(0, 300);
    await store.recordRetrieval(memoryId, 's-snap', 0.9, 'how does rotation work?', {
      traceId: 'trace-snap',
      injectedContent: injectedSnapshot
    });
    await store.recordRetrievalTrace({
      traceId: 'trace-snap',
      sessionId: 's-snap',
      queryText: 'how does rotation work?',
      rawQueryText: 'how does rotation work?',
      strategy: 'hybrid',
      candidateEventIds: [memoryId],
      selectedEventIds: [memoryId],
      confidence: 'high'
    });

    // The answer contains ONLY the late fact the model never saw.
    await appendEvent(
      store,
      'agent_response',
      's-snap',
      `Answering: ${lateFact}`,
      new Date('2100-01-01T10:00:00.000Z')
    );

    await store.evaluateSessionHelpfulness('s-snap');

    const history = await store.getUsefulnessHistory();
    const memory = history[0]?.memories?.[0];
    expect(memory).toBeDefined();
    // The un-injected fact must not count as grounding evidence.
    expect(memory!.evidence.every(e => !e.memorySnippet.includes('fourteen days'))).toBe(true);
    expect(memory!.contentOverlapScore ?? 0).toBeLessThan(0.3);

    await store.close();
  });

  it('does not count the triggering prompt as activity after the retrieval', async () => {
    const dbPath = tempDbPath();
    const store = new SQLiteEventStore(dbPath);
    await store.initialize();

    const memoryId = await appendEvent(
      store,
      'agent_response',
      'old-session',
      'Some earlier memory content about deployments.',
      new Date('2026-01-01T10:00:00.000Z')
    );

    // Same-second flow as the real hook: the prompt is stored (ms ISO
    // timestamp), then the retrieval is recorded moments later.
    await appendEvent(store, 'user_prompt', 's-now', 'current question about deploys', new Date());
    await store.recordRetrieval(memoryId, 's-now', 0.8, 'current question about deploys', { traceId: 'trace-now' });

    await store.evaluateSessionHelpfulness('s-now');

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare(`SELECT prompt_count_after, session_continued FROM memory_helpfulness WHERE session_id = 's-now'`).get() as any;
    db.close();

    expect(row.prompt_count_after).toBe(0);
    expect(row.session_continued).toBe(0);

    await store.close();
  });

  it('keeps the behavioral fallback when no responses follow the retrieval', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();

    const memoryId = await appendEvent(
      store,
      'agent_response',
      'old-session',
      'Remember to bump the version before publishing.',
      new Date('2026-01-01T10:00:00.000Z')
    );
    await store.recordRetrieval(memoryId, 's2', 0.8, 'publish flow?', { traceId: 'trace-2' });

    await store.evaluateSessionHelpfulness('s2');

    const stats = await store.getHelpfulnessStats();
    expect(stats.totalEvaluated).toBe(1);
    expect(stats.contentEvaluated).toBe(0);

    await store.close();
  });

  it('surfaces session-start injection batches as history entries', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();

    const memoryId = await appendEvent(
      store,
      'agent_response',
      'old-session',
      'Previous work: refactored the retrieval orchestrator for trace linking.',
      new Date('2026-01-01T10:00:00.000Z')
    );
    await store.recordRetrieval(memoryId, 's3', 0.5, '[session-start] recent project context', {
      traceId: 'batch-1',
      source: 'session_start'
    });

    const history = await store.getUsefulnessHistory();
    expect(history).toHaveLength(1);
    expect(history[0].kind).toBe('session_start');
    expect(history[0].strategy).toBe('session-start');
    expect(history[0].memories).toHaveLength(1);
    expect(history[0].memories[0].source).toBe('session_start');
    // Not yet evaluated -> no helpfulness score exposed.
    expect(history[0].memories[0].helpfulnessScore).toBeNull();

    await store.close();
  });

  it('degrades gracefully on a read-only legacy DB without the new columns', async () => {
    const dbPath = tempDbPath();
    // Build a pre-migration schema by hand: no trace_id/source/grounding columns.
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY, event_type TEXT NOT NULL, session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL, content TEXT NOT NULL, canonical_key TEXT NOT NULL,
        dedupe_key TEXT UNIQUE, metadata TEXT, access_count INTEGER DEFAULT 0, last_accessed_at TEXT
      );
      CREATE TABLE memory_helpfulness (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL, session_id TEXT NOT NULL,
        retrieval_score REAL DEFAULT 0, query_preview TEXT,
        session_continued INTEGER DEFAULT 0, prompt_count_after INTEGER DEFAULT 0,
        tool_success_count INTEGER DEFAULT 0, tool_total_count INTEGER DEFAULT 0,
        was_reasked INTEGER DEFAULT 0, helpfulness_score REAL DEFAULT 0.5,
        created_at TEXT DEFAULT (datetime('now')), measured_at TEXT
      );
      CREATE TABLE retrieval_traces (
        trace_id TEXT PRIMARY KEY, session_id TEXT, project_hash TEXT,
        query_text TEXT NOT NULL, raw_query_text TEXT, query_rewrite_kind TEXT, strategy TEXT,
        candidate_event_ids TEXT, selected_event_ids TEXT,
        candidate_details_json TEXT, selected_details_json TEXT,
        candidate_count INTEGER DEFAULT 0, selected_count INTEGER DEFAULT 0,
        confidence TEXT, fallback_trace TEXT, created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    db.prepare(`INSERT INTO events (id, event_type, session_id, timestamp, content, canonical_key)
                VALUES ('legacy-mem', 'agent_response', 'old', '2026-01-01T10:00:00.000Z', 'legacy memory content for read-only test', 'ck')`).run();
    db.prepare(`INSERT INTO memory_helpfulness (id, event_id, session_id, retrieval_score, query_preview, helpfulness_score, measured_at)
                VALUES ('h1', 'legacy-mem', 's-legacy', 0.7, 'legacy question', 0.75, datetime('now'))`).run();
    db.prepare(`INSERT INTO retrieval_traces (trace_id, session_id, query_text, raw_query_text, strategy, candidate_event_ids, selected_event_ids, candidate_count, selected_count)
                VALUES ('t-legacy', 's-legacy', 'legacy question', 'legacy question', 'keyword', '["legacy-mem"]', '["legacy-mem"]', 1, 1)`).run();
    db.close();

    const store = new SQLiteEventStore(dbPath, { readonly: true });
    await store.initialize();

    const stats = await store.getHelpfulnessStats();
    expect(stats.totalEvaluated).toBe(1);
    expect(stats.contentEvaluated).toBe(0);
    expect(stats.avgContentOverlap).toBe(0);

    const history = await store.getUsefulnessHistory();
    expect(history).toHaveLength(1);
    expect(history[0].question).toBe('legacy question');
    expect(history[0].memories).toHaveLength(1);
    expect(history[0].memories[0].eventId).toBe('legacy-mem');
    expect(history[0].memories[0].evidence).toEqual([]);

    await store.close();
  });

  it('falls back to session+event matching for legacy rows without trace_id', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();

    const memoryId = await appendEvent(
      store,
      'agent_response',
      'old-session',
      'Legacy memory content used before trace linking existed.',
      new Date('2026-01-01T10:00:00.000Z')
    );
    // Legacy row: no traceId option (trace_id NULL).
    await store.recordRetrieval(memoryId, 's4', 0.7, 'legacy question');
    await store.recordRetrievalTrace({
      sessionId: 's4',
      queryText: 'legacy question',
      rawQueryText: 'legacy question',
      strategy: 'keyword',
      candidateEventIds: [memoryId],
      selectedEventIds: [memoryId],
      confidence: 'suggested'
    });

    const history = await store.getUsefulnessHistory();
    expect(history).toHaveLength(1);
    expect(history[0].memories).toHaveLength(1);
    expect(history[0].memories[0].eventId).toBe(memoryId);

    await store.close();
  });
});
