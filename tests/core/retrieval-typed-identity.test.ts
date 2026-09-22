import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteAll, sqliteGet, sqliteRun, sqliteExec } from '../../src/core/sqlite-wrapper.js';
import { CURRENT_USEFULNESS_EVALUATOR_VERSION } from '../../src/core/retrieval-telemetry.js';
import { resolveMemoryRefKinds } from '../../src/core/retrieval-trace-ledger.js';
import { memoryRefKey, parseMemoryRefKey } from '../../src/core/memory-ref.js';

/**
 * Regressions for the typed-identity review findings on
 * specs/recent-memory-patterns-2026-09-06 R1–R3: an event and a lesson that
 * share an id must stay two memories through every table, delivery evidence
 * must only move the refs it was recorded for, and a `core:` prefix is a claim
 * that has to be checked rather than trusted.
 */

const roots: string[] = [];

function databasePath(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cml-typed-identity-'));
  roots.push(root);
  return path.join(root, 'events.sqlite');
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seedLesson(store: SQLiteEventStore, lessonId: string): void {
  sqliteRun(
    store.getDatabase(),
    `INSERT INTO memory_lessons (
       lesson_id, project_hash, name, trigger, steps_json, failure_modes_json,
       confidence, source_session_ids, source_event_ids, created_at, updated_at
     ) VALUES (?, 'proj', 'lesson name', 'when x', '[]', '[]', 0.8, '[]', '[]', datetime('now'), datetime('now'))`,
    [lessonId]
  );
}

describe('typed memory identity across the retrieval ledger (specs R1–R3)', () => {
  it('can disable new ledger/evaluator writes while preserving legacy readers', async () => {
    const store = new SQLiteEventStore(databasePath());
    vi.stubEnv('CML_TYPED_TRACE_WRITE', 'off');
    vi.stubEnv('CML_USEFULNESS_V3_WRITE', '0');
    const traceId = await store.recordRetrievalTrace({
      requestId: 'rollout', queryText: 'q', candidateEventIds: ['x'], selectedEventIds: ['x']
    });
    await store.recordRetrieval('x', 'rollout-session', 0.8, 'q', { traceId });
    await store.evaluateSessionHelpfulness('rollout-session');
    expect(await store.getRetrievalTraceItems(traceId)).toEqual([]);
    expect(sqliteAll(store.getDatabase(), 'SELECT * FROM retrieval_traces')).toHaveLength(1);
    expect(sqliteAll(store.getDatabase(), 'SELECT * FROM memory_usefulness_observations_v2')).toHaveLength(0);
    vi.stubEnv('CML_TYPED_TRACE_WRITE', '1');
    vi.stubEnv('CML_USEFULNESS_V3_WRITE', '1');
    await store.recordRetrieval('x', 'rollout-session', 0.8, 'q', { traceId });
    await store.recordRetrievalTrace({
      requestId: 'rollout', queryText: 'q', candidateEventIds: ['x'], selectedEventIds: ['x']
    });
    await store.evaluateSessionHelpfulness('rollout-session');
    expect(await store.getRetrievalTraceItems(traceId)).toHaveLength(1);
    expect(sqliteAll(store.getDatabase(), 'SELECT * FROM memory_usefulness_observations_v2')).toHaveLength(1);
    await store.close();
  });
  it('rolls back both trace representations if writing the typed ledger fails', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    sqliteExec(store.getDatabase(), `CREATE TRIGGER reject_typed BEFORE INSERT ON retrieval_trace_items BEGIN SELECT RAISE(ABORT, 'ledger failure'); END`);
    await expect(store.recordRetrievalTrace({
      traceId: 'atomic', requestId: 'atomic-request', queryText: 'q',
      candidateEventIds: ['x'], selectedEventIds: ['x'], items: [{ kind: 'event', id: 'x', selected: true }]
    })).rejects.toThrow('ledger failure');
    expect(sqliteGet(store.getDatabase(), `SELECT * FROM retrieval_traces WHERE trace_id = 'atomic'`)).toBeUndefined();
    await store.close();
  });

  it('clears stale typed items when a repeated request becomes empty', async () => {
    const store = new SQLiteEventStore(databasePath());
    const first = await store.recordRetrievalTrace({
      requestId: 'empty-repeat', queryText: 'q', candidateEventIds: ['x'], selectedEventIds: ['x']
    });
    const second = await store.recordRetrievalTrace({
      requestId: 'empty-repeat', queryText: 'q', candidateEventIds: [], selectedEventIds: []
    });
    expect(second).toBe(first);
    expect(await store.getRetrievalTraceItems(first)).toEqual([]);
    await store.close();
  });

  it('replaces selected state on a repeated request instead of keeping it monotonic', async () => {
    const store = new SQLiteEventStore(databasePath());
    const traceId = await store.recordRetrievalTrace({
      requestId: 'selection-correction', queryText: 'q',
      candidateEventIds: ['x'], selectedEventIds: ['x']
    });
    await store.recordRetrievalTrace({
      requestId: 'selection-correction', queryText: 'q',
      candidateEventIds: ['x'], selectedEventIds: []
    });
    expect(await store.getRetrievalTraceItems(traceId)).toEqual([
      expect.objectContaining({ memoryId: 'x', selected: false })
    ]);
    await store.close();
  });
  it('does not confuse a literal dash scope with the global scope', () => {
    const ref = { projectId: '-', kind: 'event' as const, id: 'x' };
    expect(memoryRefKey(ref)).not.toBe(memoryRefKey({ ...ref, projectId: null }));
    expect(parseMemoryRefKey(memoryRefKey(ref))).toEqual(ref);
  });

  it('keeps same-kind observations in different projects and prefixed event ids distinct', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    for (const ref of [
      { kind: 'event' as const, id: 'x', projectId: 'a' },
      { kind: 'event' as const, id: 'x', projectId: 'b' },
      { kind: 'lesson' as const, id: 'x', projectId: null },
      { kind: 'event' as const, id: 'lesson:x', projectId: null }
    ]) {
      await store.recordRetrieval(ref.id, 'collision-session', 0.8, 'q', {
        traceId: 'collision-trace', memoryKind: ref.kind, memoryProjectId: ref.projectId,
        presentationMode: 'evidence', triggerType: 'user_prompt'
      });
    }
    await store.evaluateSessionHelpfulness('collision-session');
    const rows = sqliteAll(store.getDatabase(), "SELECT * FROM memory_usefulness_observations_v2 WHERE trace_id='collision-trace'");
    expect(rows).toHaveLength(4);
    await store.recordDeliveryOutcome({
      traceId: 'collision-trace', status: 'emitted', evidence: 'hook_stdout',
      refs: [{ kind: 'event', id: 'x', projectId: 'b' }]
    });
    expect(sqliteAll(store.getDatabase(), `SELECT memory_project_id FROM memory_helpfulness WHERE delivery_status='emitted'`))
      .toEqual([{ memory_project_id: 'b' }]);
    expect(sqliteAll(store.getDatabase(), `SELECT memory_project_id FROM memory_usefulness_observations_v2 WHERE delivered=1`))
      .toEqual([{ memory_project_id: 'b' }]);
    await store.close();
  });
  it('keeps an event and a lesson that share an id as two usefulness observations', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    const sharedId = 'shared-identity-id';
    seedLesson(store, sharedId);
    sqliteRun(
      store.getDatabase(),
      `INSERT INTO events (id, event_type, session_id, timestamp, content, canonical_key, dedupe_key)
       VALUES (?, 'agent_response', 'source', ?, 'deploy on port 37777', ?, ?)`,
      [sharedId, new Date('2026-01-01T00:00:00.000Z').toISOString(), sharedId, `dedupe-${sharedId}`]
    );

    const now = new Date(Date.now() - 60_000);
    for (const kind of ['event', 'lesson'] as const) {
      await store.recordRetrieval(sharedId, 'session-shared', 0.8, 'deploy?', {
        traceId: 'trace-shared',
        memoryKind: kind,
        injectedContent: 'deploy on port 37777',
        presentationMode: 'evidence',
        triggerType: 'user_prompt'
      });
    }
    await store.recordDeliveryOutcome({
      traceId: 'trace-shared',
      status: 'emitted',
      evidence: 'hook_stdout',
      deliveredAt: now
    });
    await store.evaluateSessionHelpfulness('session-shared');

    const rows = sqliteAll<{ event_id: string; memory_kind: string; memory_id: string }>(
      store.getDatabase(),
      `SELECT event_id, memory_kind, memory_id FROM memory_usefulness_observations_v2
       WHERE trace_id = 'trace-shared' AND evaluator_version = ?`,
      [CURRENT_USEFULNESS_EVALUATOR_VERSION]
    );
    // Two rows, not one overwritten row: the primary key includes event_id, so
    // the lesson is stored under a kind-qualified key (finding 2).
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.memory_kind))).toEqual(new Set(['event', 'lesson']));
    expect(rows.every((row) => row.memory_id === sharedId)).toBe(true);
    expect(rows.some((row) => row.event_id === memoryRefKey({ projectId: null, kind: 'lesson', id: sharedId }))).toBe(true);
    await store.close();
  });

  it('moves delivery evidence only for the ref kind it was recorded for', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    const sharedId = 'delivery-scoped-id';
    for (const kind of ['event', 'lesson'] as const) {
      await store.recordRetrieval(sharedId, 'session-scoped', 0.8, 'deploy?', {
        traceId: 'trace-scoped',
        memoryKind: kind,
        presentationMode: 'reference',
        triggerType: 'session_start'
      });
    }

    await store.recordDeliveryOutcome({
      traceId: 'trace-scoped',
      status: 'emitted',
      evidence: 'hook_stdout',
      refs: [{ kind: 'lesson', id: sharedId }]
    });

    const rows = sqliteAll<{ memory_kind: string; delivery_status: string }>(
      store.getDatabase(),
      `SELECT memory_kind, delivery_status FROM memory_helpfulness WHERE trace_id = 'trace-scoped'`
    );
    // The event ref shares the id but was not in `refs`; its delivery status
    // must not move (finding 3).
    expect(rows.find((row) => row.memory_kind === 'lesson')?.delivery_status).toBe('emitted');
    expect(rows.find((row) => row.memory_kind === 'event')?.delivery_status).toBe('formatted');
    await store.close();
  });

  it('does not treat a core: prefix as proof that the block exists', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    sqliteRun(
      store.getDatabase(),
      `INSERT INTO core_memory_blocks (project_hash, block_key, content, created_at, updated_at)
       VALUES ('proj', 'persona', 'resident context', datetime('now'), datetime('now'))`
    );

    const resolved = resolveMemoryRefKinds(store.getDatabase(), ['core:persona', 'core:vanished'], {
      projectId: 'proj'
    });
    expect(resolved.get('core:persona')).toMatchObject({ kind: 'core', resolution: 'resolved' });
    // The prefix alone is a claim about a block that is no longer there
    // (finding 6): the reference stays unresolved rather than counting as a
    // healthy core delivery.
    expect(resolved.get('core:vanished')).toMatchObject({ kind: 'unknown', resolution: 'unresolved' });
    await store.close();
  });

  it('collapses a repeated request onto one trace and leaves no stale typed item', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    const first = await store.recordRetrievalTrace({
      traceId: 'trace-request-a',
      queryText: 'first pass',
      candidateEventIds: ['mem-1', 'mem-2'],
      selectedEventIds: ['mem-1'],
      items: [
        { kind: 'event', id: 'mem-1', selected: true, rank: 0 },
        { kind: 'event', id: 'mem-2', selected: false, rank: 1 }
      ],
      requestId: 'claude-hook:session:turn-1',
      presentationMode: 'evidence',
      triggerType: 'user_prompt'
    });
    const second = await store.recordRetrievalTrace({
      traceId: 'trace-request-b',
      queryText: 'same request, traced again',
      candidateEventIds: ['mem-3'],
      selectedEventIds: ['mem-3'],
      items: [{ kind: 'event', id: 'mem-3', selected: true, rank: 0 }],
      requestId: 'claude-hook:session:turn-1',
      presentationMode: 'evidence',
      triggerType: 'user_prompt'
    });

    expect(second).toBe(first);
    expect(Number(sqliteGet<{ count: number }>(
      store.getDatabase(),
      `SELECT COUNT(*) AS count FROM retrieval_traces WHERE request_id = ?`,
      ['claude-hook:session:turn-1']
    )?.count)).toBe(1);

    // The legacy arrays were replaced wholesale; the typed rows must show the
    // same latest state rather than keeping mem-1/mem-2 alongside mem-3
    // (finding 9).
    const items = await store.getRetrievalTraceItems(String(first));
    expect(items.map((item) => item.memoryId)).toEqual(['mem-3']);
    await store.close();
  });

  it('reports grounding for prompt-triggered evidence apart from other triggers', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    const now = new Date(Date.now() - 60_000);
    const seed = async (traceId: string, sessionId: string, trigger: 'user_prompt' | 'explicit_search') => {
      const memory = await store.append({
        eventType: 'agent_response',
        sessionId: 'source',
        timestamp: new Date('2026-01-01T00:00:00.000Z'),
        content: 'Production deploys use port 37777 and scripts/release-npm.sh.'
      });
      if (!memory.success) throw new Error('fixture append failed');
      await store.recordRetrieval(memory.eventId, sessionId, 0.9, 'how do I deploy?', {
        traceId,
        memoryKind: 'event',
        injectedContent: 'Production deploys use port 37777 and scripts/release-npm.sh.',
        presentationMode: 'evidence',
        triggerType: trigger
      });
      await store.recordDeliveryOutcome({
        traceId,
        status: 'emitted',
        evidence: 'hook_stdout',
        deliveredAt: now
      });
      await store.append({
        eventType: 'agent_response',
        sessionId,
        timestamp: new Date(now.getTime() + 30_000),
        content: 'Use port 37777 and run scripts/release-npm.sh for production.'
      });
      await store.evaluateSessionHelpfulness(sessionId);
    };
    await seed('trace-prompt', 'session-prompt', 'user_prompt');
    await seed('trace-search', 'session-search', 'explicit_search');

    const aggregate = await store.getUsefulnessAggregateV2({ minimumSample: 1 });
    // The headline metric is evidence/user_prompt only; the explicit search row
    // is visible but never folded into it (specs §3.4).
    expect(aggregate.evidenceGroundingScope).toBe('evidence/user_prompt');
    expect(aggregate.evidenceEvaluated).toBe(1);
    expect(aggregate.evidenceGrounded).toBe(1);
    expect(aggregate.evidenceAllTriggers).toMatchObject({ evaluated: 2, grounded: 2 });
    await store.close();
  });
});
