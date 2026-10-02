import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { createSQLiteDatabase, sqliteClose, sqliteExec, sqliteRun, type SQLiteDatabase } from '../../src/core/sqlite-wrapper.js';
import { buildMemoryAuditReport, formatMemoryAuditMarkdown } from '../../src/apps/cli/memory-audit-report.js';
import { classifyLessonGetOutput } from '../../src/core/lesson-usage-audit.js';

/**
 * specs/memory-usage-followup-2026-10-03 R2-R4: per-provenance lesson usage,
 * lesson quality, and prompt quality in the read-only audit.
 */

const STORE = 'aaaaaaaa';
const SINCE = new Date('2026-10-01T00:00:00.000Z');
const UNTIL = new Date('2026-10-02T00:00:00.000Z');
const IN = '2026-10-01T12:00:00.000Z';
const BEFORE = '2026-09-30T12:00:00.000Z';
const TOKEN = 'stg_auditsecret0123456789abcdefghij';
const WRAPPER = `If this turn corrects an earlier mistake or verifies recovery from a failure, you may propose one reusable project lesson before finishing. Use mcp__happy__propose_lesson with token="${TOKEN}". Do not perform extra work just to generate a lesson.`;
const NOTIFICATION = '<task-notification>\n<task-id>t</task-id>\n<status>completed</status>\n</task-notification>';
const SECRET_REQUEST = 'private request text about the payroll migration';
const LESSON_NAME = 'Private lesson name about payroll';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHome(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cml-audit-lessons-'));
  roots.push(root);
  return root;
}

function dbPathFor(homeDir: string, store = STORE): string {
  const dir = path.join(homeDir, '.claude-code', 'memory', 'projects', store);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, 'events.sqlite');
}

let eventSeq = 0;
function insertEvent(db: SQLiteDatabase, eventType: string, timestamp: string, content: string, metadata: unknown, id = `event-${++eventSeq}`): string {
  sqliteRun(db, `INSERT INTO events (id, event_type, session_id, timestamp, content, canonical_key, dedupe_key, metadata)
    VALUES (?, ?, 'session-private-id', ?, ?, ?, ?, ?)`, [id, eventType, timestamp, content, `k-${id}`, `d-${id}`, JSON.stringify(metadata)]);
  return id;
}

function lookupOutput(body: Record<string, unknown>): string {
  return JSON.stringify([{ type: 'text', text: JSON.stringify(body, null, 2) }]);
}

function toolObservation(db: SQLiteDatabase, toolName: string, toolOutput: string, timestamp = IN, metadata: Record<string, unknown> = {}): void {
  insertEvent(db, 'tool_observation', timestamp, JSON.stringify({ toolName, toolInput: { name: LESSON_NAME }, toolOutput, success: true }), { toolName, success: true, ...metadata });
}

interface HostRow { traceId: string; phase: string; requestId: string; turnId?: string; generation?: number; session?: string; lessons?: string[]; revisions?: Array<{ lessonId: string; revision: number }>; createdAt?: string; project?: string }
function hostTrace(db: SQLiteDatabase, row: HostRow): void {
  const lessons = row.lessons ?? ['lesson-good'];
  sqliteRun(db, `INSERT INTO lesson_host_traces (trace_id, project_hash, session_id, actor_id, machine_id, generation, turn_id, request_id, phase, outcome, lesson_ids_json, lesson_revisions_json, query_text, created_at)
    VALUES (?, ?, ?, 'actor-private', 'machine-private', ?, ?, ?, ?, ?, ?, ?, NULL, ?)`, [
    row.traceId, row.project ?? STORE, row.session ?? 'host-session', row.generation ?? 3, row.turnId ?? 'turn-1', row.requestId, row.phase, row.phase,
    JSON.stringify(lessons), JSON.stringify(row.revisions ?? lessons.map((lessonId) => ({ lessonId, revision: 1 }))), row.createdAt ?? IN
  ]);
}
function ackRecord(db: SQLiteDatabase, requestId: string, selectedTraceId: string): void {
  sqliteRun(db, `INSERT INTO lesson_host_idempotency (project_hash, actor_id, request_id, operation, fingerprint, result_json, created_at)
    VALUES (?, 'actor-private', ?, 'delivered', 'fp', ?, ?)`, [STORE, requestId, JSON.stringify({ outcome: 'delivered', traceId: selectedTraceId }), IN]);
}

function lesson(db: SQLiteDatabase, lessonId: string, input: { project?: string; refs?: string[]; sessions?: string[]; enabled?: boolean; validation?: string[]; reconsider?: string | null } = {}): void {
  sqliteRun(db, `INSERT INTO memory_lessons (lesson_id, project_hash, name, trigger, steps_json, confidence, source_session_ids, source_event_ids, failure_modes_json, skill_candidate, recall_enabled, validation_json, reconsider_when, created_at, updated_at)
    VALUES (?, ?, ?, 'trigger', '["step"]', 0.9, ?, ?, '[]', 0, ?, ?, ?, ?, ?)`, [
    lessonId, input.project ?? STORE, `${LESSON_NAME} ${lessonId}`, JSON.stringify(input.sessions ?? []), JSON.stringify(input.refs ?? []),
    input.enabled === false ? 0 : 1, JSON.stringify(input.validation ?? []), input.reconsider ?? null, BEFORE, BEFORE
  ]);
}

function selectionTrace(db: SQLiteDatabase, traceId: string, presentation: string, trigger: string, items: Array<{ kind: string; id: string; selected: boolean }>, createdAt = IN, runtimeVersion = '2.4.8'): void {
  sqliteRun(db, `INSERT INTO retrieval_traces (trace_id, session_id, project_hash, query_text, selected_count, presentation_mode, trigger_type, runtime_version, created_at)
    VALUES (?, 'session-private-id', ?, 'private query', ?, ?, ?, ?, ?)`, [traceId, STORE, items.filter((item) => item.selected).length, presentation, trigger, runtimeVersion, createdAt]);
  items.forEach((item, index) => sqliteRun(db, `INSERT INTO retrieval_trace_items (trace_id, item_key, memory_kind, memory_id, project_id, rank, selected)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, [traceId, `${item.kind}:${item.id}`, item.kind, item.id, STORE, index, item.selected ? 1 : 0]));
}

async function seedStore(homeDir: string): Promise<string> {
  const dbPath = dbPathFor(homeDir);
  const store = new SQLiteEventStore(dbPath);
  await store.initialize();
  await store.close();
  const db = createSQLiteDatabase(dbPath);

  // Prompts: plain, wrapped, notification-only, scaffold-only, new-writer metadata, and two outside the window.
  insertEvent(db, 'user_prompt', IN, SECRET_REQUEST, {});
  insertEvent(db, 'user_prompt', IN, `${WRAPPER}\n\n${SECRET_REQUEST}`, {});
  insertEvent(db, 'user_prompt', IN, NOTIFICATION, {});
  insertEvent(db, 'user_prompt', IN, WRAPPER, {});
  insertEvent(db, 'user_prompt', IN, SECRET_REQUEST + ' again', { promptClassifier: { version: 1, kind: 'user', removed: [] } });
  insertEvent(db, 'user_prompt', BEFORE, SECRET_REQUEST, {});
  insertEvent(db, 'user_prompt', UNTIL.toISOString(), SECRET_REQUEST, {});

  // Lookups: found (double-encoded), not found, error, truncated, malformed, other project, out-of-window,
  // and two non-lookups (list tool; a Bash command that only mentions the tool name).
  toolObservation(db, 'mcp__claude-memory-layer__mem-lesson-get', lookupOutput({ operation: 'mem-lesson-get', projectHash: STORE, found: true, lesson: { name: LESSON_NAME } }));
  toolObservation(db, 'mcp__claude-memory-layer__mem-lesson-get', lookupOutput({ operation: 'mem-lesson-get', projectHash: STORE, found: false }));
  toolObservation(db, 'mcp__claude-memory-layer__mem-lesson-get', JSON.stringify([{ type: 'text', text: 'Error [readonly_runtime]: Memory store is unreadable' }]));
  toolObservation(db, 'mcp__claude-memory-layer__mem-lesson-get', lookupOutput({ operation: 'mem-lesson-get', found: true }).slice(0, 40) + '\n... [900 characters truncated] ...\n');
  toolObservation(db, 'mcp__claude-memory-layer__mem-lesson-get', '{not json');
  toolObservation(db, 'mcp__claude-memory-layer__mem-lesson-get', lookupOutput({ operation: 'mem-lesson-get', projectHash: 'bbbbbbbb', found: true }));
  toolObservation(db, 'mcp__claude-memory-layer__mem-lesson-get', lookupOutput({ operation: 'mem-lesson-get', projectHash: STORE, found: true }), BEFORE);
  toolObservation(db, 'mcp__claude-memory-layer__mem-lesson-list', lookupOutput({ operation: 'mem-lesson-list', count: 1 }));
  toolObservation(db, 'Bash', 'ran mem-lesson-get', IN, { command: 'claude-memory-layer mem-lesson-get' });

  // Lessons: local ref, unresolved ref, no refs (disabled), other-scope row, and a lesson whose id equals an event id.
  const sourceEvent = insertEvent(db, 'agent_response', BEFORE, 'verified result', {}, 'shared-id');
  lesson(db, 'lesson-good', { refs: [sourceEvent], sessions: ['s'], validation: ['tests pass'], reconsider: 'when CI changes' });
  lesson(db, 'lesson-unresolved', { refs: ['missing-event'] });
  lesson(db, 'lesson-no-refs', { enabled: false });
  lesson(db, 'lesson-foreign', { project: 'bbbbbbbb', refs: [sourceEvent] });
  lesson(db, 'shared-id', { refs: [sourceEvent] });

  // Typed selections: SessionStart reference listing, prompt evidence, an event item sharing an id with a lesson.
  selectionTrace(db, 'trace-start', 'reference', 'session_start', [{ kind: 'lesson', id: 'lesson-good', selected: true }, { kind: 'lesson', id: 'lesson-unresolved', selected: true }]);
  selectionTrace(db, 'trace-prompt', 'evidence', 'user_prompt', [{ kind: 'lesson', id: 'lesson-good', selected: true }, { kind: 'event', id: 'shared-id', selected: true }, { kind: 'lesson', id: 'lesson-no-refs', selected: false }], IN, '2.4.7');
  selectionTrace(db, 'trace-old', 'reference', 'session_start', [{ kind: 'lesson', id: 'lesson-no-refs', selected: true }], BEFORE);

  // Host lineage: exact (+ a repeated ack of the same selection), legacy unique, ambiguous, unlinked, inconsistent.
  hostTrace(db, { traceId: 'sel-exact', phase: 'selected', requestId: 'r-sel-exact', turnId: 'turn-exact', createdAt: BEFORE });
  hostTrace(db, { traceId: 'del-exact', phase: 'delivered', requestId: 'r-del-exact', turnId: 'turn-exact' });
  ackRecord(db, 'r-del-exact', 'sel-exact');
  hostTrace(db, { traceId: 'del-exact-retry', phase: 'delivered', requestId: 'r-del-exact-2', turnId: 'turn-exact' });
  ackRecord(db, 'r-del-exact-2', 'sel-exact');
  hostTrace(db, { traceId: 'sel-legacy', phase: 'selected', requestId: 'r-sel-legacy', turnId: 'turn-legacy' });
  hostTrace(db, { traceId: 'del-legacy', phase: 'delivered', requestId: 'r-del-legacy', turnId: 'turn-legacy' });
  hostTrace(db, { traceId: 'sel-amb-1', phase: 'selected', requestId: 'r-sel-amb-1', turnId: 'turn-amb' });
  hostTrace(db, { traceId: 'sel-amb-2', phase: 'selected', requestId: 'r-sel-amb-2', turnId: 'turn-amb' });
  hostTrace(db, { traceId: 'del-amb', phase: 'delivered', requestId: 'r-del-amb', turnId: 'turn-amb' });
  hostTrace(db, { traceId: 'del-orphan', phase: 'delivered', requestId: 'r-del-orphan', turnId: 'turn-orphan' });
  hostTrace(db, { traceId: 'sel-other-gen', phase: 'selected', requestId: 'r-sel-gen', turnId: 'turn-gen', generation: 2 });
  hostTrace(db, { traceId: 'del-wrong-link', phase: 'delivered', requestId: 'r-del-gen', turnId: 'turn-gen', generation: 3 });
  ackRecord(db, 'r-del-gen', 'sel-other-gen');
  hostTrace(db, { traceId: 'read-1', phase: 'read', requestId: 'r-read' });
  hostTrace(db, { traceId: 'foreign-sel', phase: 'selected', requestId: 'r-foreign', project: 'bbbbbbbb' });
  sqliteClose(db);
  return dbPath;
}

function snapshotTree(dir: string): Array<{ file: string; size: number; mtimeMs: number }> {
  const out: Array<{ file: string; size: number; mtimeMs: number }> = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push({ file: path.relative(dir, full), size: statSync(full).size, mtimeMs: statSync(full).mtimeMs });
    }
  };
  walk(dir);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

describe('memory audit lesson usage', () => {
  it('separates selection, host acknowledgement, and MCP lookup provenance', async () => {
    const homeDir = makeHome();
    await seedStore(homeDir);
    const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
    const before = snapshotTree(memoryRoot);

    const report = buildMemoryAuditReport({ homeDir, allProjects: true, since: SINCE, until: UNTIL });
    const store = report.stores[0];

    expect(store.promptQuality).toMatchObject({
      support: 'supported', timeBasis: 'events.timestamp', classifierVersion: 1,
      userPrompts: 5, automatedEnvelopes: 1, scaffoldOnly: 1, withRecognizedScaffold: 3,
      requestAfterNormalization: 3, withProposalWrapper: 2, storedWithClassifierMetadata: 1,
      scaffoldKinds: { lesson_proposal_wrapper: 2, task_notification: 1, title_directive: 0, injected_lesson_list: 0 }
    });

    expect(store.lessonUsage?.selection).toMatchObject({
      support: 'supported', traces: 2, items: 3, uniqueLessons: 2,
      byPresentation: { reference: 2, evidence: 1, other: 0 },
      byTrigger: { session_start: 2, user_prompt: 1, other: 0 },
      itemInjectionMode: 'unknown'
    });
    expect(store.lessonUsage?.mcpBodyLookups).toMatchObject({
      support: 'supported', calls: 6, found: 1, notFound: 1, errored: 1, unknown: 2, otherProject: 1,
      unobservedClients: ['codex', 'hermes']
    });
    expect(store.lessonUsage?.host).toMatchObject({
      support: 'supported',
      selected: { traces: 4, items: 4 },
      delivered: { traces: 6, items: 6 },
      read: { traces: 1, items: 1 },
      deliveryLineage: { exact: 2, exactDistinctSelections: 1, inconsistent: 1, legacyUnique: 1, ambiguous: 1, unlinked: 1 }
    });
    expect(store.lessonUsage).toMatchObject({ applied: 'unknown', taskSuccess: 'unknown', mcpNavigation: 'unsupported' });
    expect(store.lessonAuditError).toBeNull();
    expect(store.lessonUsage?.runtimeVersions).toEqual([{ version: '2.4.7', traces: 1 }, { version: '2.4.8', traces: 1 }]);

    expect(store.lessonQuality).toMatchObject({
      support: 'supported', total: 4, activeBasis: 'recall_enabled', active: 3, disabled: 1, otherScopeRows: 1,
      evidence: { noRefs: 1, localRefsFound: 2, refsUnresolvedHere: 1 },
      withSessionRefs: 1, withValidation: 1, withReconsiderWhen: 1,
      // lesson-good and lesson-unresolved from traces; the event item 'shared-id' is not a lesson selection.
      recentlySelectedUnique: 2
    });

    expect(snapshotTree(memoryRoot)).toEqual(before);

    const serialized = JSON.stringify(report) + formatMemoryAuditMarkdown(report);
    for (const secret of [TOKEN, SECRET_REQUEST, LESSON_NAME, 'session-private-id', 'actor-private', 'machine-private', 'private query', homeDir]) {
      expect(serialized).not.toContain(secret);
    }
    expect(formatMemoryAuditMarkdown(report)).toContain('Lesson usage by provenance');
  });

  it('reports unsupported sections for a legacy store instead of failing or migrating it', () => {
    const homeDir = makeHome();
    const db = createSQLiteDatabase(dbPathFor(homeDir));
    sqliteExec(db, `CREATE TABLE events (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, session_id TEXT NOT NULL,
      timestamp TEXT NOT NULL, content TEXT NOT NULL, canonical_key TEXT NOT NULL)`);
    sqliteRun(db, `INSERT INTO events VALUES ('p', 'user_prompt', 's', ?, ?, 'k')`, [IN, `${WRAPPER}\n\nlegacy request text`]);
    sqliteClose(db);
    const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
    const before = snapshotTree(memoryRoot);

    const store = buildMemoryAuditReport({ homeDir, allProjects: true }).stores[0];
    expect(store.state).toBe('read');
    expect(store.promptQuality).toMatchObject({ support: 'supported', userPrompts: 1, withProposalWrapper: 1 });
    expect(store.lessonUsage?.mcpBodyLookups.support).toBe('unsupported');
    expect(store.lessonUsage?.selection.support).toBe('unsupported');
    expect(store.lessonUsage?.host).toMatchObject({ support: 'unsupported', deliveryLineage: 'unsupported' });
    expect(store.lessonUsage?.runtimeVersions).toBe('unsupported');
    expect(store.lessonQuality?.support).toBe('unsupported');
    expect(store.lessonAuditError).toBeNull();
    expect(snapshotTree(memoryRoot)).toEqual(before);
  });

  it('pages through events without changing the aggregates', async () => {
    const homeDir = makeHome();
    const dbPath = await seedStore(homeDir);
    const db = createSQLiteDatabase(dbPath, { readonly: true });
    try {
      const { auditLessonUsage } = await import('../../src/core/lesson-usage-audit.js');
      const small = auditLessonUsage(db, { projectHash: STORE, since: SINCE, until: UNTIL, pageSize: 1 });
      const large = auditLessonUsage(db, { projectHash: STORE, since: SINCE, until: UNTIL, pageSize: 1000 });
      expect(small).toEqual(large);
    } finally {
      sqliteClose(db);
    }
  });
});

describe('memory audit lesson usage edge cases', () => {
  async function currentStore(homeDir: string): Promise<SQLiteDatabase> {
    const dbPath = dbPathFor(homeDir);
    const store = new SQLiteEventStore(dbPath);
    await store.initialize();
    await store.close();
    return createSQLiteDatabase(dbPath);
  }

  it('counts only exact lookup aliases, including underscore and plugin spellings', async () => {
    const homeDir = makeHome();
    const db = await currentStore(homeDir);
    const found = lookupOutput({ operation: 'mem-lesson-get', projectHash: STORE, found: true });
    for (const toolName of [
      'mem-lesson-get',
      'mcp__claude-memory-layer__mem-lesson-get',
      'mcp__claude_memory_layer__mem_lesson_get',
      'mcp__plugin_claude-memory-layer_claude-memory-layer__mem-lesson-get',
      'mcp__plugin_claude_memory_layer_claude_memory_layer__mem_lesson_get'
    ]) toolObservation(db, toolName, found);
    for (const nearMiss of ['mcp__claude-memory-layer__mem-lesson-get-v2', 'mem-lesson-getter', 'mcp__other__mem_lesson_get', 'mem_lesson_get_all']) {
      toolObservation(db, nearMiss, found);
    }
    toolObservation(db, 'Bash', found, IN, { command: 'echo mcp__claude_memory_layer__mem_lesson_get' });
    sqliteClose(db);

    const lookups = buildMemoryAuditReport({ homeDir, allProjects: true }).stores[0].lessonUsage?.mcpBodyLookups;
    expect(lookups).toMatchObject({ calls: 5, found: 5 });
  });

  it('never falls back to legacy matching when an ack record exists but is malformed', async () => {
    const homeDir = makeHome();
    const db = await currentStore(homeDir);
    hostTrace(db, { traceId: 'sel', phase: 'selected', requestId: 'r-sel', turnId: 'turn-x' });
    hostTrace(db, { traceId: 'del-malformed', phase: 'delivered', requestId: 'r-malformed', turnId: 'turn-x' });
    sqliteRun(db, `INSERT INTO lesson_host_idempotency (project_hash, actor_id, request_id, operation, fingerprint, result_json, created_at)
      VALUES (?, 'actor-private', 'r-malformed', 'delivered', 'fp', '{not json', ?)`, [STORE, IN]);
    hostTrace(db, { traceId: 'del-invalid', phase: 'delivered', requestId: 'r-invalid', turnId: 'turn-x' });
    sqliteRun(db, `INSERT INTO lesson_host_idempotency (project_hash, actor_id, request_id, operation, fingerprint, result_json, created_at)
      VALUES (?, 'actor-private', 'r-invalid', 'delivered', 'fp', ?, ?)`, [STORE, JSON.stringify({ outcome: 'invalid_ack' }), IN]);
    hostTrace(db, { traceId: 'del-legacy', phase: 'delivered', requestId: 'r-legacy', turnId: 'turn-x' });
    sqliteClose(db);

    const lineage = buildMemoryAuditReport({ homeDir, allProjects: true }).stores[0].lessonUsage?.host.deliveryLineage;
    expect(lineage).toMatchObject({ exact: 0, inconsistent: 2, legacyUnique: 1, ambiguous: 0, unlinked: 0 });
  });

  it('never certifies exact or legacy links from corrupt lesson id or revision payloads', async () => {
    const homeDir = makeHome();
    const db = await currentStore(homeDir);
    const corrupt = (traceId: string, phase: string, requestId: string, turnId: string, ids: string, revisions: string) =>
      sqliteRun(db, `INSERT INTO lesson_host_traces (trace_id, project_hash, session_id, actor_id, machine_id, generation, turn_id, request_id, phase, outcome, lesson_ids_json, lesson_revisions_json, query_text, created_at)
        VALUES (?, ?, 'host-session', 'actor-private', 'machine-private', 3, ?, ?, ?, ?, ?, ?, NULL, ?)`, [traceId, STORE, turnId, requestId, phase, phase, ids, revisions, IN]);
    // Exact path: identical corrupt revisions on both sides.
    corrupt('sel-a', 'selected', 'r-sel-a', 'turn-a', '["l"]', '{not json');
    corrupt('del-a', 'delivered', 'r-del-a', 'turn-a', '["l"]', '{not json');
    ackRecord(db, 'r-del-a', 'sel-a');
    // Exact path: invalid revision entries.
    corrupt('sel-b', 'selected', 'r-sel-b', 'turn-b', '["l"]', '[{"lessonId":"l","revision":"1"}]');
    corrupt('del-b', 'delivered', 'r-del-b', 'turn-b', '["l"]', '[{"lessonId":"l","revision":"1"}]');
    ackRecord(db, 'r-del-b', 'sel-b');
    // Legacy path: non-string lesson ids on both sides.
    corrupt('sel-c', 'selected', 'r-sel-c', 'turn-c', '[1]', '[]');
    corrupt('del-c', 'delivered', 'r-del-c', 'turn-c', '[1]', '[]');
    sqliteClose(db);

    const lineage = buildMemoryAuditReport({ homeDir, allProjects: true }).stores[0].lessonUsage?.host.deliveryLineage;
    expect(lineage).toMatchObject({ exact: 0, inconsistent: 2, legacyUnique: 0, unlinked: 1 });
  });

  it('prints only semver runtime versions and collapses other labels', async () => {
    const homeDir = makeHome();
    const db = await currentStore(homeDir);
    const versions = ['2.4.7', '2.5.0-beta.1+build.7', 'v3.0.0', 'secret-host-label', '2.4', '/private/path', null];
    versions.forEach((version, index) => sqliteRun(db, `INSERT INTO retrieval_traces (trace_id, query_text, runtime_version, created_at) VALUES (?, 'q', ?, ?)`, [`t-${index}`, version, IN]));
    sqliteClose(db);

    const runtime = buildMemoryAuditReport({ homeDir, allProjects: true }).stores[0].lessonUsage?.runtimeVersions;
    expect(runtime).toEqual(expect.arrayContaining([
      { version: '2.4.7', traces: 1 },
      { version: '2.5.0-beta.1+build.7', traces: 1 },
      { version: 'v3.0.0', traces: 1 },
      { version: 'other', traces: 3 },
      { version: 'unknown', traces: 1 }
    ]));
    expect(JSON.stringify(runtime)).not.toContain('secret-host-label');
  });

  it('checks every evidence ref, not only the first hundred', async () => {
    const homeDir = makeHome();
    const db = await currentStore(homeDir);
    const present = insertEvent(db, 'agent_response', BEFORE, 'verified result', {}, 'ref-101');
    lesson(db, 'lesson-many-refs', { refs: [...Array.from({ length: 100 }, (_, index) => `missing-${index}`), present] });
    sqliteClose(db);

    const quality = buildMemoryAuditReport({ homeDir, allProjects: true }).stores[0].lessonQuality;
    expect(quality?.evidence).toEqual({ noRefs: 0, localRefsFound: 1, refsUnresolvedHere: 0 });
  });

  it('reports lineage unsupported when selected revisions were never recorded', () => {
    const homeDir = makeHome();
    const db = createSQLiteDatabase(dbPathFor(homeDir));
    sqliteExec(db, `
      CREATE TABLE events (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL, content TEXT NOT NULL, canonical_key TEXT NOT NULL, metadata TEXT);
      CREATE TABLE lesson_host_traces (trace_id TEXT PRIMARY KEY, project_hash TEXT NOT NULL, session_id TEXT NOT NULL,
        actor_id TEXT NOT NULL, machine_id TEXT NOT NULL, generation INTEGER NOT NULL, turn_id TEXT, request_id TEXT NOT NULL,
        phase TEXT NOT NULL, outcome TEXT NOT NULL, lesson_ids_json TEXT NOT NULL, query_text TEXT, created_at TEXT NOT NULL);
      CREATE TABLE lesson_host_idempotency (project_hash TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
        operation TEXT NOT NULL, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
    for (const [traceId, phase] of [['sel', 'selected'], ['del', 'delivered']]) {
      sqliteRun(db, `INSERT INTO lesson_host_traces VALUES (?, ?, 's', 'a', 'm', 3, 't', ?, ?, ?, '["l"]', NULL, ?)`, [traceId, STORE, `r-${traceId}`, phase, phase, IN]);
    }
    sqliteClose(db);

    const host = buildMemoryAuditReport({ homeDir, allProjects: true }).stores[0].lessonUsage?.host;
    expect(host).toMatchObject({ support: 'supported', selected: { traces: 1 }, delivered: { traces: 1 }, deliveryLineage: 'unsupported' });
  });
});

describe('classifyLessonGetOutput', () => {
  it('accepts only complete mem-lesson-get JSON, including double-encoded strings', () => {
    const body = { operation: 'mem-lesson-get', projectHash: STORE, found: true };
    expect(classifyLessonGetOutput(lookupOutput(body), STORE)).toBe('found');
    expect(classifyLessonGetOutput(JSON.stringify(JSON.stringify(body)), STORE)).toBe('found');
    expect(classifyLessonGetOutput(JSON.stringify(body), STORE)).toBe('found');
    expect(classifyLessonGetOutput(lookupOutput({ ...body, found: false }), STORE)).toBe('not_found');
    expect(classifyLessonGetOutput(lookupOutput({ operation: 'mem-lesson-list', found: true }), STORE)).toBe('unknown');
    expect(classifyLessonGetOutput(lookupOutput({ operation: 'mem-lesson-get', success: true }), STORE)).toBe('unknown');
    expect(classifyLessonGetOutput('x'.repeat(300_000), STORE)).toBe('unknown');
    expect(classifyLessonGetOutput(undefined, STORE)).toBe('unknown');
    expect(classifyLessonGetOutput(lookupOutput(body) + '...[truncated]', STORE)).toBe('unknown');
  });
});
