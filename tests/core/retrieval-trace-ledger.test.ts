import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { createSQLiteDatabase, sqliteAll, sqliteClose, sqliteExec, sqliteGet, sqliteRun } from '../../src/core/sqlite-wrapper.js';
import {
  memoryRefKey,
  parseMemoryRefKey,
  normalizeMemoryKind
} from '../../src/core/memory-ref.js';
import { resolveMemoryRefKinds } from '../../src/core/retrieval-trace-ledger.js';

const roots: string[] = [];

function databasePath(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cml-trace-ledger-'));
  roots.push(root);
  return path.join(root, 'events.sqlite');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function seedLesson(store: SQLiteEventStore, lessonId: string, projectHash = 'project-a'): Promise<void> {
  sqliteRun(
    store.getDatabase(),
    `INSERT INTO memory_lessons (
       lesson_id, project_hash, name, trigger, steps_json, confidence,
       source_session_ids, source_event_ids, failure_modes_json, skill_candidate,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, '[]', 0.8, '[]', '[]', '[]', 0, ?, ?)`,
    [lessonId, projectHash, `lesson ${lessonId}`, 'when deploying', new Date().toISOString(), new Date().toISOString()]
  );
}

describe('typed retrieval trace ledger (specs R1)', () => {
  it('keeps event and lesson selections apart instead of collapsing them into event ids', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    const appended = await store.append({
      eventType: 'agent_response',
      sessionId: 'source',
      timestamp: new Date('2026-09-01T00:00:00.000Z'),
      content: 'Release runs through the tag push workflow.'
    });
    if (!appended.success) throw new Error('fixture append failed');
    await seedLesson(store, 'lesson-1');

    await store.recordRetrievalTrace({
      traceId: 'trace-mixed',
      sessionId: 'session-1',
      projectHash: 'project-a',
      queryText: 'how do I release?',
      candidateEventIds: [appended.eventId, 'lesson-1'],
      selectedEventIds: [appended.eventId, 'lesson-1'],
      items: [
        { kind: 'event', id: appended.eventId, rank: 0, selected: true },
        { kind: 'lesson', id: 'lesson-1', rank: 1, selected: true }
      ],
      presentationMode: 'evidence',
      triggerType: 'user_prompt'
    });

    const items = await store.getRetrievalTraceItems('trace-mixed');
    expect(items.map((item) => [item.memoryKind, item.memoryId])).toEqual([
      ['event', appended.eventId],
      ['lesson', 'lesson-1']
    ]);

    const summary = await store.getTypedSelectionSummary();
    expect(summary.byKind.event).toBe(1);
    expect(summary.byKind.lesson).toBe(1);
    expect(summary.typedTraces).toBe(1);
    expect(summary.unresolved).toBe(0);
    await store.close();
  });

  it('resolves an untyped caller by looking the id up rather than assuming event', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    await seedLesson(store, 'lesson-untyped');

    await store.recordRetrievalTrace({
      traceId: 'trace-untyped',
      queryText: 'lesson recall',
      candidateEventIds: ['lesson-untyped', 'missing-id'],
      selectedEventIds: ['lesson-untyped'],
      presentationMode: 'reference',
      triggerType: 'session_start'
    });

    const items = await store.getRetrievalTraceItems('trace-untyped');
    const lesson = items.find((item) => item.memoryId === 'lesson-untyped');
    const missing = items.find((item) => item.memoryId === 'missing-id');
    expect(lesson?.memoryKind).toBe('lesson');
    expect(lesson?.selected).toBe(true);
    // An id that resolves to nothing is recorded as unknown, never silently
    // typed as an event — and never asserted to be deleted: it may predate a
    // table or live in a store this reader cannot see (specs R1, finding 5).
    expect(missing?.memoryKind).toBe('unknown');
    expect(missing?.deleted).toBe(false);
    await store.close();
  });

  it('marks an id that exists as both event and lesson ambiguous instead of guessing', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    const appended = await store.append({
      eventType: 'agent_response',
      sessionId: 'source',
      timestamp: new Date('2026-09-01T00:00:00.000Z'),
      content: 'Shared identifier fixture.'
    });
    if (!appended.success) throw new Error('fixture append failed');
    await seedLesson(store, appended.eventId);

    const resolved = resolveMemoryRefKinds(store.getDatabase(), [appended.eventId]);
    expect(resolved.get(appended.eventId)?.resolution).toBe('ambiguous');
    expect(resolved.get(appended.eventId)?.kind).toBe('unknown');
    expect(resolved.get(appended.eventId)?.matchedKinds.sort()).toEqual(['event', 'lesson']);
    await store.close();
  });

  it('refuses to type a reference the caller may not read', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    await seedLesson(store, 'lesson-other-project', 'project-b');

    const resolved = resolveMemoryRefKinds(store.getDatabase(), ['lesson-other-project'], {
      allowedProjectIds: ['project-a']
    });
    expect(resolved.get('lesson-other-project')?.resolution).toBe('forbidden');
    expect(resolved.get('lesson-other-project')?.kind).toBe('unknown');
    await store.close();
  });

  it('reproduces the legacy event/lesson split read-only and never writes during a report', async () => {
    const dbPath = databasePath();
    const store = new SQLiteEventStore(dbPath);
    await store.initialize();
    const appended = await store.append({
      eventType: 'agent_response',
      sessionId: 'source',
      timestamp: new Date('2026-09-01T00:00:00.000Z'),
      content: 'Legacy trace fixture.'
    });
    if (!appended.success) throw new Error('fixture append failed');
    await seedLesson(store, 'lesson-legacy');
    // A trace written the way the pre-typed ledger wrote them: one flat array
    // holding both an event id and a lesson id, with no typed items.
    sqliteRun(
      store.getDatabase(),
      `INSERT INTO retrieval_traces (trace_id, session_id, project_hash, query_text,
         candidate_event_ids, selected_event_ids, candidate_count, selected_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 2, 2, ?)`,
      [
        'trace-legacy', 'session-legacy', 'project-a', 'legacy query',
        JSON.stringify([appended.eventId, 'lesson-legacy']),
        JSON.stringify([appended.eventId, 'lesson-legacy']),
        new Date('2026-09-02T00:00:00.000Z').toISOString()
      ]
    );

    const before = statSync(dbPath).mtimeMs;
    const itemsBefore = Number(sqliteGet<{ count: number }>(
      store.getDatabase(),
      'SELECT COUNT(*) AS count FROM retrieval_trace_items'
    )?.count);
    const summary = await store.getTypedSelectionSummary();
    const itemsAfter = Number(sqliteGet<{ count: number }>(
      store.getDatabase(),
      'SELECT COUNT(*) AS count FROM retrieval_trace_items'
    )?.count);

    expect(summary.byKind.event).toBe(1);
    expect(summary.byKind.lesson).toBe(1);
    expect(summary.legacyResolvedTraces).toBe(1);
    expect(itemsAfter).toBe(itemsBefore);
    expect(statSync(dbPath).mtimeMs).toBe(before);
    await store.close();
  });

  it('previews a backfill without writing and writes only when applied', async () => {
    const dbPath = databasePath();
    const store = new SQLiteEventStore(dbPath);
    await store.initialize();
    await seedLesson(store, 'lesson-backfill');
    sqliteRun(
      store.getDatabase(),
      `INSERT INTO retrieval_traces (trace_id, query_text, candidate_event_ids, selected_event_ids,
         candidate_count, selected_count, created_at)
       VALUES ('trace-backfill', 'q', ?, ?, 1, 1, ?)`,
      [JSON.stringify(['lesson-backfill']), JSON.stringify(['lesson-backfill']), new Date().toISOString()]
    );

    const dryRun = await store.backfillRetrievalTraceItems({ dryRun: true });
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.byKind.lesson).toBe(1);
    expect(sqliteAll(store.getDatabase(), 'SELECT * FROM retrieval_trace_items')).toHaveLength(0);

    const applied = await store.backfillRetrievalTraceItems({ dryRun: false });
    expect(applied.writtenItems).toBe(1);
    const rows = sqliteAll<{ memory_kind: string; memory_id: string }>(
      store.getDatabase(),
      'SELECT memory_kind, memory_id FROM retrieval_trace_items'
    );
    expect(rows).toEqual([{ memory_kind: 'lesson', memory_id: 'lesson-backfill' }]);
    await store.close();
  });

  it('never increments events.access_count for a lesson reference', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    const appended = await store.append({
      eventType: 'agent_response',
      sessionId: 'source',
      timestamp: new Date('2026-09-01T00:00:00.000Z'),
      content: 'Access count fixture.'
    });
    if (!appended.success) throw new Error('fixture append failed');
    // Same id in the lesson table: a kind-blind update would bump the event.
    await seedLesson(store, appended.eventId);

    await store.incrementAccessCount([{ kind: 'lesson', id: appended.eventId }]);
    expect(Number(sqliteGet<{ access_count: number }>(
      store.getDatabase(),
      'SELECT access_count FROM events WHERE id = ?',
      [appended.eventId]
    )?.access_count)).toBe(0);
    // The lesson access is recorded against the lesson, not dropped.
    expect(Number(sqliteGet<{ access_count: number }>(
      store.getDatabase(),
      'SELECT access_count FROM memory_lessons WHERE lesson_id = ?',
      [appended.eventId]
    )?.access_count)).toBe(1);

    await store.incrementAccessCount([{ kind: 'event', id: appended.eventId }]);
    expect(Number(sqliteGet<{ access_count: number }>(
      store.getDatabase(),
      'SELECT access_count FROM events WHERE id = ?',
      [appended.eventId]
    )?.access_count)).toBe(1);
    await store.close();
  });

  it('previews a legacy store that has no typed table at all', async () => {
    // A store that predates retrieval_trace_items must still get a meaningful
    // dry-run preview: returning 0 because the table is missing would make the
    // diagnostic useless, and creating the table just to count would be a write
    // (finding 5).
    const dbPath = databasePath();
    const legacy = createSQLiteDatabase(dbPath);
    sqliteExec(legacy, `
      CREATE TABLE events (
        id TEXT PRIMARY KEY, event_type TEXT NOT NULL, session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL, content TEXT NOT NULL, canonical_key TEXT NOT NULL,
        dedupe_key TEXT UNIQUE, metadata TEXT
      );
      CREATE TABLE retrieval_traces (
        trace_id TEXT PRIMARY KEY, query_text TEXT NOT NULL,
        candidate_event_ids TEXT, selected_event_ids TEXT,
        candidate_count INTEGER, selected_count INTEGER, project_hash TEXT,
        created_at TEXT
      );
    `);
    sqliteRun(
      legacy,
      `INSERT INTO events (id, event_type, session_id, timestamp, content, canonical_key, dedupe_key)
       VALUES ('legacy-event', 'agent_response', 's', ?, 'c', 'k', 'd')`,
      [new Date().toISOString()]
    );
    sqliteRun(
      legacy,
      `INSERT INTO retrieval_traces (trace_id, query_text, candidate_event_ids, selected_event_ids,
         candidate_count, selected_count, created_at)
       VALUES ('legacy-trace', 'q', ?, ?, 2, 1, ?)`,
      [JSON.stringify(['legacy-event', 'vanished-id']), JSON.stringify(['legacy-event']), new Date().toISOString()]
    );
    sqliteClose(legacy);

    const store = new SQLiteEventStore(dbPath, { readonly: true });
    const preview = await store.backfillRetrievalTraceItems({ dryRun: true });
    expect(preview.dryRun).toBe(true);
    expect(preview.scannedTraces).toBe(1);
    expect(preview.writtenItems).toBe(2);
    expect(preview.byKind.event).toBe(1);
    // The id that resolves to nothing is unresolved, not asserted deleted.
    expect(preview.byKind.unknown).toBe(1);
    expect(preview.unresolved).toBe(1);
    await store.close();

    // The read-only preview must not have created the typed table.
    const after = createSQLiteDatabase(dbPath, { readonly: true });
    const tables = sqliteAll<{ name: string }>(
      after,
      `SELECT name FROM sqlite_master WHERE type = 'table'`
    ).map((row) => row.name);
    sqliteClose(after);
    expect(tables).not.toContain('retrieval_trace_items');
  });

  it('keys references by project scope and kind so neither dimension collapses', () => {
    expect(memoryRefKey({ kind: 'lesson', id: 'abc' })).toBe('[null,"lesson","abc"]');
    expect(memoryRefKey({ kind: 'event', id: 'abc' })).not.toBe(memoryRefKey({ kind: 'lesson', id: 'abc' }));
    // The same kind/id in two projects is two memories under two permission
    // boundaries and must not share an identity (finding 1).
    expect(memoryRefKey({ projectId: 'proj-a', kind: 'event', id: 'abc' }))
      .not.toBe(memoryRefKey({ projectId: 'proj-b', kind: 'event', id: 'abc' }));
    expect(parseMemoryRefKey('-|lesson:abc')).toEqual({ projectId: null, kind: 'lesson', id: 'abc' });
    expect(parseMemoryRefKey(memoryRefKey({ projectId: 'proj-a', kind: 'event', id: 'abc' })))
      .toEqual({ projectId: 'proj-a', kind: 'event', id: 'abc' });
    // A project id containing the separator round-trips instead of forging a
    // boundary between the scope and the kind.
    const tricky = memoryRefKey({ projectId: 'weird|scope', kind: 'event', id: 'abc' });
    expect(parseMemoryRefKey(tricky)).toEqual({ projectId: 'weird|scope', kind: 'event', id: 'abc' });
    expect(parseMemoryRefKey('bogus:abc')).toBeNull();
    expect(normalizeMemoryKind('nope')).toBe('unknown');
  });

  it('keeps the same kind/id in two projects as two typed trace items', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    await store.recordRetrievalTrace({
      traceId: 'trace-scoped',
      queryText: 'cross-project recall',
      candidateEventIds: ['shared-id'],
      selectedEventIds: ['shared-id'],
      items: [
        { kind: 'event', id: 'shared-id', projectId: 'proj-a', selected: true, rank: 0 },
        { kind: 'event', id: 'shared-id', projectId: 'proj-b', selected: true, rank: 1 }
      ],
      presentationMode: 'evidence',
      triggerType: 'user_prompt'
    });
    const items = await store.getRetrievalTraceItems('trace-scoped');
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.projectId))).toEqual(new Set(['proj-a', 'proj-b']));
    await store.close();
  });
});
