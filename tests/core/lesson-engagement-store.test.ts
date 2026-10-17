import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteGet, sqliteRun } from '../../src/core/sqlite-wrapper.js';
import { CURRENT_USEFULNESS_EVALUATOR_VERSION } from '../../src/core/retrieval-telemetry.js';
import { readSessionStartLessonUsage } from '../../src/core/lesson-follow-through.js';

/**
 * Every session-start lesson listing used to evaluate as `not_observed`: a
 * mem-lesson-get body read is not a navigation event, so nothing a session did
 * with a listed lesson was ever visible. These pin the observations that feed
 * both the audit and the session-start index order.
 */

const roots: string[] = [];
const LESSON_ID = '22222222-2222-4222-8222-222222222222';
const LESSON_NAME = 'sqlite-backup-before-probe';

function databasePath(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cml-lesson-engagement-'));
  roots.push(root);
  return path.join(root, 'events.sqlite');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seedLesson(store: SQLiteEventStore): void {
  sqliteRun(
    store.getDatabase(),
    `INSERT INTO memory_lessons (
       lesson_id, project_hash, name, trigger, steps_json, failure_modes_json, validation_json,
       confidence, source_session_ids, source_event_ids, created_at, updated_at
     ) VALUES (?, 'proj', ?, 'before probing a live store', ?, '[]', '[]', 0.5, '[]', '[]', datetime('now'), datetime('now'))`,
    [LESSON_ID, LESSON_NAME, JSON.stringify(['Copy with `sqlite3 events.sqlite ".backup \'<target>\'"` first.'])]
  );
}

async function listAtSessionStart(store: SQLiteEventStore, sessionId: string, deliveredAt: Date): Promise<void> {
  const traceId = `trace-${sessionId}`;
  await store.recordRetrieval(LESSON_ID, sessionId, 0.5, '[session-start] lesson index', {
    traceId,
    source: 'session_start',
    memoryKind: 'lesson',
    deliveryStatus: 'formatted',
    deliveryEvidence: 'context_formatted',
    presentationMode: 'reference',
    triggerType: 'session_start',
    injectedContent: `${LESSON_NAME} — before probing a live store`
  });
  await store.recordDeliveryOutcome({ traceId, status: 'emitted', evidence: 'hook_stdout', deliveredAt });
}

async function tool(store: SQLiteEventStore, sessionId: string, at: Date, content: Record<string, unknown>): Promise<void> {
  const result = await store.append({ eventType: 'tool_observation', sessionId, timestamp: at, content: JSON.stringify(content) });
  if (!result.success) throw new Error('fixture append failed');
}

function lessonGetObservation(found: boolean): Record<string, unknown> {
  return {
    toolName: 'mcp__claude-memory-layer__mem-lesson-get',
    toolInput: { name: LESSON_NAME },
    toolOutput: JSON.stringify([{ type: 'text', text: JSON.stringify({ operation: 'mem-lesson-get', found }) }])
  };
}

function observation(store: SQLiteEventStore, sessionId: string) {
  const db = store.getDatabase();
  const v2 = sqliteGet<{ adoption: string }>(
    db,
    `SELECT adoption FROM memory_usefulness_observations_v2 WHERE trace_id = ? AND evaluator_version = ?`,
    [`trace-${sessionId}`, CURRENT_USEFULNESS_EVALUATOR_VERSION]
  );
  const legacy = sqliteGet<{ evidence_json: string | null }>(
    db,
    `SELECT evidence_json FROM memory_helpfulness WHERE trace_id = ?`,
    [`trace-${sessionId}`]
  );
  return { adoption: v2?.adoption, evidence: legacy?.evidence_json ? JSON.parse(legacy.evidence_json) : null };
}

describe('lesson engagement after a session-start listing', () => {
  it('records a later body read as navigation and a lesson command as follow-through', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    seedLesson(store);
    const deliveredAt = new Date(Date.now() - 10 * 60_000);
    await listAtSessionStart(store, 'session-read', deliveredAt);
    await tool(store, 'session-read', new Date(deliveredAt.getTime() + 60_000), lessonGetObservation(true));
    await tool(store, 'session-read', new Date(deliveredAt.getTime() + 120_000), {
      toolName: 'Bash', toolInput: { command: 'sqlite3 events.sqlite ".backup \'/tmp/copy.sqlite\'"' }, toolOutput: ''
    });

    await store.evaluateSessionHelpfulness('session-read');

    expect(observation(store, 'session-read')).toEqual({
      adoption: 'navigated',
      evidence: { lessonFollowThrough: { bodyRead: true, opened: true, commandAnchors: 1, matchedAnchors: 1 } }
    });
    await store.close();
  });

  it('stays not_observed when the session never read or ran the lesson', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    seedLesson(store);
    const deliveredAt = new Date(Date.now() - 10 * 60_000);
    await listAtSessionStart(store, 'session-idle', deliveredAt);
    await tool(store, 'session-idle', new Date(deliveredAt.getTime() + 60_000), lessonGetObservation(false));

    await store.evaluateSessionHelpfulness('session-idle');

    expect(observation(store, 'session-idle')).toEqual({
      adoption: 'not_observed',
      evidence: { lessonFollowThrough: { bodyRead: false, opened: false, commandAnchors: 1, matchedAnchors: 0 } }
    });
    await store.close();
  });

  // Measured on the Desktop store: every body read of a listed lesson came
  // 98–267 minutes after session start, so a 30-minute window saw none.
  it('credits a body read hours later, because the index stays in context all session', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    seedLesson(store);
    const deliveredAt = new Date(Date.now() - 5 * 60 * 60_000);
    await listAtSessionStart(store, 'session-late', deliveredAt);
    await tool(store, 'session-late', new Date(deliveredAt.getTime() + 4 * 60 * 60_000), lessonGetObservation(true));

    await store.evaluateSessionHelpfulness('session-late');

    expect(observation(store, 'session-late').adoption).toBe('navigated');
    await store.close();
  });

  it('does not credit a read that happened before the listing was delivered', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    seedLesson(store);
    const deliveredAt = new Date(Date.now() - 10 * 60_000);
    await tool(store, 'session-early', new Date(deliveredAt.getTime() - 60_000), lessonGetObservation(true));
    await listAtSessionStart(store, 'session-early', deliveredAt);

    await store.evaluateSessionHelpfulness('session-early');

    expect(observation(store, 'session-early').adoption).toBe('not_observed');
    await store.close();
  });

  it('does not count a command match alone as engagement for the index order', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    seedLesson(store);
    const deliveredAt = new Date(Date.now() - 10 * 60_000);
    await listAtSessionStart(store, 'session-cmd', deliveredAt);
    await tool(store, 'session-cmd', new Date(deliveredAt.getTime() + 60_000), {
      toolName: 'Bash', toolInput: { command: 'sqlite3 events.sqlite ".backup \'/tmp/copy.sqlite\'"' }, toolOutput: ''
    });
    await store.evaluateSessionHelpfulness('session-cmd');

    expect(observation(store, 'session-cmd').evidence.lessonFollowThrough.matchedAnchors).toBe(1);
    const usage = readSessionStartLessonUsage(store.getDatabase(), new Date(Date.now() - 24 * 60 * 60_000));
    expect(usage.get(LESSON_ID)).toEqual({ exposures: 1, engaged: 0 });
    await store.close();
  });

  it('summarizes emitted listings and engaged ones per lesson for the index order', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    seedLesson(store);
    const deliveredAt = new Date(Date.now() - 10 * 60_000);
    await listAtSessionStart(store, 'session-a', deliveredAt);
    await tool(store, 'session-a', new Date(deliveredAt.getTime() + 60_000), lessonGetObservation(true));
    await listAtSessionStart(store, 'session-b', deliveredAt);
    // Formatted but never emitted: the model never saw it, so it is no exposure.
    await store.recordRetrieval(LESSON_ID, 'session-c', 0.5, '[session-start] lesson index', {
      traceId: 'trace-session-c', source: 'session_start', memoryKind: 'lesson', deliveryStatus: 'formatted',
      deliveryEvidence: 'context_formatted', presentationMode: 'reference', triggerType: 'session_start'
    });
    // A legacy row with malformed evidence must not break the summary.
    sqliteRun(store.getDatabase(), `UPDATE memory_helpfulness SET evidence_json = '{broken' WHERE session_id = 'session-c'`);
    await store.evaluateSessionHelpfulness('session-a');
    await store.evaluateSessionHelpfulness('session-b');

    const usage = readSessionStartLessonUsage(store.getDatabase(), new Date(Date.now() - 24 * 60 * 60_000));
    expect(usage.get(LESSON_ID)).toEqual({ exposures: 2, engaged: 1 });
    expect(readSessionStartLessonUsage(store.getDatabase(), new Date(Date.now() + 60_000)).size).toBe(0);
    await store.close();
  });
});
