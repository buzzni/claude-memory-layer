import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { createSQLiteDatabase, sqliteClose, sqliteExec, sqliteRun } from '../../src/core/sqlite-wrapper.js';
import {
  buildMemoryAuditReport,
  formatMemoryAuditMarkdown,
  resolveMemoryAuditOptions
} from '../../src/apps/cli/memory-audit-report.js';

/**
 * R5: the audit must produce correct per-store denominators on empty, legacy,
 * WAL-mode, test-named, alias and unreadable stores — and it must not write to,
 * migrate or initialize any of them.
 */

const roots: string[] = [];

function makeHome(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cml-audit-home-'));
  roots.push(root);
  mkdirSync(path.join(root, '.claude-code', 'memory', 'projects'), { recursive: true });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A test deliberately makes one directory unreadable; force-remove best effort.
    }
  }
});

function storeDir(homeDir: string, storeHash: string): string {
  const dir = path.join(homeDir, '.claude-code', 'memory', 'projects', storeHash);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A full, current-schema store with one prompt-triggered evidence delivery. */
async function seedCurrentStore(homeDir: string, storeHash: string): Promise<void> {
  const dbPath = path.join(storeDir(homeDir, storeHash), 'events.sqlite');
  const store = new SQLiteEventStore(dbPath);
  await store.initialize();
  const storedAt = new Date();
  const memory = await store.append({
    eventType: 'agent_response',
    sessionId: 'source',
    timestamp: storedAt,
    content: 'Production deploys use port 37777 and scripts/release-npm.sh.',
    metadata: { source: 'codex', originalTimestamp: new Date(storedAt.getTime() - 60_000).toISOString() }
  });
  if (!memory.success) throw new Error('fixture append failed');
  const now = new Date(Date.now() - 60_000);
  await store.recordRetrievalTrace({
    traceId: 'trace-audit',
    sessionId: 'session-audit',
    projectHash: storeHash,
    queryText: 'how do I deploy?',
    candidateEventIds: [memory.eventId],
    selectedEventIds: [memory.eventId],
    items: [{ kind: 'event', id: memory.eventId, projectId: storeHash, selected: true }],
    presentationMode: 'evidence',
    triggerType: 'user_prompt',
    deliveryClient: 'claude-hook',
    requestId: `claude-hook:session-audit:turn-1`
  });
  await store.recordRetrieval(memory.eventId, 'session-audit', 0.9, 'how do I deploy?', {
    traceId: 'trace-audit',
    memoryKind: 'event',
    injectedContent: 'Production deploys use port 37777 and scripts/release-npm.sh.',
    presentationMode: 'evidence',
    triggerType: 'user_prompt',
    deliveryClient: 'claude-hook'
  });
  await store.recordDeliveryOutcome({
    traceId: 'trace-audit',
    status: 'emitted',
    evidence: 'hook_stdout',
    deliveredAt: now
  });
  await store.append({
    eventType: 'agent_response',
    sessionId: 'session-audit',
    timestamp: new Date(now.getTime() + 30_000),
    content: 'Use port 37777 and run scripts/release-npm.sh for production.'
  });
  await store.evaluateSessionHelpfulness('session-audit');
  await store.close();
}

/** A store that predates typed items and honest outcome reasons. */
function seedLegacyStore(homeDir: string, storeHash: string, options: { wal?: boolean } = {}): void {
  const dbPath = path.join(storeDir(homeDir, storeHash), 'events.sqlite');
  const db = createSQLiteDatabase(dbPath, { walMode: options.wal === true });
  sqliteExec(db, `
    CREATE TABLE events (
      id TEXT PRIMARY KEY, event_type TEXT NOT NULL, session_id TEXT NOT NULL,
      timestamp TEXT NOT NULL, content TEXT NOT NULL, canonical_key TEXT NOT NULL,
      dedupe_key TEXT UNIQUE, metadata TEXT
    );
    CREATE TABLE retrieval_traces (
      trace_id TEXT PRIMARY KEY, session_id TEXT, project_hash TEXT, query_text TEXT NOT NULL,
      candidate_event_ids TEXT, selected_event_ids TEXT, candidate_count INTEGER DEFAULT 0,
      selected_count INTEGER DEFAULT 0, presentation_mode TEXT, trigger_type TEXT,
      delivery_client TEXT, outcome_reason TEXT NOT NULL DEFAULT 'runtime_error',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  sqliteRun(
    db,
    `INSERT INTO events (id, event_type, session_id, timestamp, content, canonical_key, dedupe_key)
     VALUES ('legacy-1', 'user_prompt', 's', ?, 'legacy prompt', 'k', 'd')`,
    [new Date().toISOString()]
  );
  sqliteRun(
    db,
    `INSERT INTO retrieval_traces (
       trace_id, session_id, query_text, candidate_event_ids, selected_event_ids,
       candidate_count, selected_count, presentation_mode, trigger_type, delivery_client,
       outcome_reason, created_at
     ) VALUES ('legacy-trace', 's', 'q', '["legacy-1"]', '["legacy-1"]', 1, 1,
       'evidence', 'user_prompt', 'claude-hook', 'runtime_error', ?)`,
    [new Date().toISOString()]
  );
  sqliteClose(db);
}

function seedMetadataFreeStore(homeDir: string, storeHash: string): void {
  const db = createSQLiteDatabase(path.join(storeDir(homeDir, storeHash), 'events.sqlite'));
  sqliteExec(db, `CREATE TABLE events (
    id TEXT PRIMARY KEY, event_type TEXT NOT NULL, session_id TEXT NOT NULL,
    timestamp TEXT NOT NULL, content TEXT NOT NULL, canonical_key TEXT NOT NULL
  )`);
  sqliteRun(db, `INSERT INTO events VALUES ('old', 'user_prompt', 's', ?, 'old', 'k')`, [new Date().toISOString()]);
  sqliteClose(db);
}

function writeRegistry(homeDir: string, sessions: Record<string, { projectPath: string; projectHash: string }>): void {
  writeFileSync(
    path.join(homeDir, '.claude-code', 'memory', 'session-registry.json'),
    JSON.stringify({
      version: 1,
      sessions: Object.fromEntries(Object.entries(sessions).map(([id, entry]) => [id, {
        ...entry,
        registeredAt: new Date().toISOString()
      }]))
    })
  );
}

function snapshotTree(dir: string): Array<{ file: string; size: number; mtimeMs: number }> {
  const out: Array<{ file: string; size: number; mtimeMs: number }> = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const stat = statSync(full);
      out.push({ file: path.relative(dir, full), size: stat.size, mtimeMs: stat.mtimeMs });
    }
  };
  walk(dir);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

describe('read-only memory audit (specs R5)', () => {
  it('keeps per-store denominators across empty, legacy, WAL and unreadable stores', async () => {
    const homeDir = makeHome();
    await seedCurrentStore(homeDir, 'aaaaaaaa');
    seedLegacyStore(homeDir, 'bbbbbbbb');
    seedLegacyStore(homeDir, 'cccccccc', { wal: true });
    // Empty store: a file with no tables at all.
    const emptyDb = createSQLiteDatabase(path.join(storeDir(homeDir, 'dddddddd'), 'events.sqlite'));
    sqliteClose(emptyDb);
    // Unreadable store: not a SQLite database.
    writeFileSync(path.join(storeDir(homeDir, 'eeeeeeee'), 'events.sqlite'), 'not a database at all');

    const report = buildMemoryAuditReport({ homeDir, allProjects: true });

    expect(report.mode).toBe('read-only');
    expect(report.coverage.storesDiscovered).toBe(5);
    // A store that cannot be read is reported, never dropped from the count.
    expect(report.coverage.storesUnreadable + report.coverage.storesUnsupportedSchema).toBe(2);
    expect(report.coverage.storesRead).toBe(3);

    const current = report.stores.find((store) => store.storeHash === 'aaaaaaaa');
    expect(current?.schemaCapability).toMatchObject({ typedTraceItems: true, usefulnessV2: true });
    expect(current?.typedSelections.byKind.event).toBe(1);
    expect(current?.evaluation.evidencePromptEvaluated).toBe(1);
    expect(current?.evaluation.evidencePromptGrounded).toBe(1);
    expect(current?.sources.some((source) => source.source === 'codex')).toBe(true);
    expect(current?.sources.find((source) => source.source === 'codex')).toMatchObject({
      withSourceClock: 1, unknownSourceClock: 0, medianLagMs: 60_000
    });
    expect(current?.clients.some((client) => client.client === 'claude-hook')).toBe(true);

    const legacy = report.stores.find((store) => store.storeHash === 'bbbbbbbb');
    expect(legacy?.schemaCapability.typedTraceItems).toBe(false);
    // A legacy trace resolves read-only; its selection is still counted.
    expect(legacy?.typedSelections.total).toBe(1);
    // A stored runtime_error from before the honest default is presented as
    // legacy_unclassified rather than re-classified (specs R2).
    expect(legacy?.outcomeReasons).toEqual([{ reason: 'legacy_unclassified', traces: 1 }]);

    const wal = report.stores.find((store) => store.storeHash === 'cccccccc');
    expect(wal?.state).toBe('read');
    expect(wal?.events.total).toBe(1);

    const unreadable = report.stores.filter((store) => store.state === 'unreadable' || store.state === 'unsupported_schema');
    expect(unreadable).toHaveLength(2);
    for (const store of unreadable) {
      // Errors must not leak the user's absolute paths.
      expect(store.error ?? '').not.toMatch(/\/(?:Users|home|private)\//);
    }

    // The machine total and the per-class totals are both kept.
    expect(report.totals.events).toBe(
      report.stores.reduce((sum, store) => sum + store.events.window, 0)
    );
    expect(Object.values(report.byProjectClass).reduce((sum, bucket) => sum + bucket.stores, 0))
      .toBe(report.coverage.storesDiscovered);
  });

  it('keeps basename guesses separate from explicit project classification', async () => {
    const homeDir = makeHome();
    await seedCurrentStore(homeDir, 'aaaaaaaa');
    seedLegacyStore(homeDir, 'bbbbbbbb');
    writeRegistry(homeDir, {
      's1': { projectPath: path.join(homeDir, 'work', 'real-project'), projectHash: 'aaaaaaaa' },
      's2': { projectPath: path.join(homeDir, 'work', 'happy-testing-ground-42'), projectHash: 'bbbbbbbb' }
    });

    const report = buildMemoryAuditReport({ homeDir, allProjects: true });
    const production = report.stores.find((store) => store.storeHash === 'aaaaaaaa');
    const test = report.stores.find((store) => store.storeHash === 'bbbbbbbb');
    expect(production?.projectClass).toBe('unknown');
    expect(test?.projectClass).toBe('unknown');
    // The basename is a hint; the report always says so.
    expect(test?.classificationBasis).toBe('unclassified');
    expect(report.byProjectClass.test.stores).toBe(0);
    expect(test?.classificationHint).toBe('test');
    const classified = buildMemoryAuditReport({
      homeDir, allProjects: true, projectClasses: { aaaaaaaa: 'production', bbbbbbbb: 'test' }
    });
    expect(classified.byProjectClass.production.stores).toBe(1);
    expect(classified.byProjectClass.test.stores).toBe(1);
    expect(classified.stores.every((store) => store.classificationBasis === 'explicit')).toBe(true);
    expect(report.notes.some((note) => /heuristic/.test(note))).toBe(true);

    // The registered store hash is not the canonical hash of its path, which is
    // exactly the worktree-alias shape: a suggestion, never a move.
    expect(production?.mergeSuggestion).toMatch(/verify|Inspect/i);
    expect(report.notes.some((note) => /nothing is moved or merged/i.test(note))).toBe(true);
  });

  it('changes nothing on disk and never initializes a store it reads', async () => {
    const homeDir = makeHome();
    await seedCurrentStore(homeDir, 'aaaaaaaa');
    seedLegacyStore(homeDir, 'bbbbbbbb');
    const memoryRoot = path.join(homeDir, '.claude-code', 'memory');

    const before = snapshotTree(memoryRoot);
    const beforeLegacyTables = readTableNames(path.join(memoryRoot, 'projects', 'bbbbbbbb', 'events.sqlite'));

    const report = buildMemoryAuditReport({ homeDir, allProjects: true });
    expect(report.coverage.storesRead).toBe(2);

    expect(snapshotTree(memoryRoot)).toEqual(before);
    // The legacy store must not have gained the current schema's tables.
    expect(readTableNames(path.join(memoryRoot, 'projects', 'bbbbbbbb', 'events.sqlite')))
      .toEqual(beforeLegacyTables);
    expect(beforeLegacyTables).not.toContain('retrieval_trace_items');
  });

  it('distinguishes an empty current schema from a readable metadata-free legacy schema', async () => {
    const homeDir = makeHome();
    const empty = new SQLiteEventStore(path.join(storeDir(homeDir, 'aaaaaaaa'), 'events.sqlite'));
    await empty.initialize();
    await empty.close();
    seedMetadataFreeStore(homeDir, 'bbbbbbbb');

    const report = buildMemoryAuditReport({ homeDir, allProjects: true });
    expect(report.stores.find((store) => store.storeHash === 'aaaaaaaa')?.state).toBe('empty');
    const legacy = report.stores.find((store) => store.storeHash === 'bbbbbbbb');
    expect(legacy?.state).toBe('read');
    expect(legacy?.sources).toEqual([
      expect.objectContaining({ source: 'native', events: 1, unknownSourceClock: 1 })
    ]);
  });

  it('renders markdown and json without leaking absolute paths', async () => {
    const homeDir = makeHome();
    await seedCurrentStore(homeDir, 'aaaaaaaa');
    writeRegistry(homeDir, {
      's1': { projectPath: path.join(homeDir, 'work', 'real-project'), projectHash: 'aaaaaaaa' }
    });
    const report = buildMemoryAuditReport({ homeDir, allProjects: true });
    const markdown = formatMemoryAuditMarkdown(report);
    expect(markdown).toContain('# Memory audit (read-only)');
    expect(markdown).toContain('evidence/user_prompt');
    expect(markdown).not.toContain(homeDir);
    expect(JSON.stringify(report)).not.toContain(homeDir);
  });

  it('validates the CLI contract', () => {
    expect(resolveMemoryAuditOptions({ classify: ['aaaaaaaa=test'] }).projectClasses).toEqual({ aaaaaaaa: 'test' });
    expect(() => resolveMemoryAuditOptions({ classify: ['aaaaaaaa=guessed'] })).toThrow(/classify/);
    expect(resolveMemoryAuditOptions({ format: 'json', allProjects: true })).toMatchObject({
      format: 'json',
      allProjects: true
    });
    expect(() => resolveMemoryAuditOptions({ format: 'csv' })).toThrow(/json or markdown/);
    expect(() => resolveMemoryAuditOptions({ since: 'not-a-date' })).toThrow(/ISO timestamp/);
    expect(() => resolveMemoryAuditOptions({
      since: '2026-09-06T00:00:00Z',
      until: '2026-09-01T00:00:00Z'
    })).toThrow(/must not be after/);
    // There is no writing mode to turn off.
    expect(() => resolveMemoryAuditOptions({ readOnly: false })).toThrow(/read-only/);
  });
});

it('bounds rolling windows at until and never exposes arbitrary source/client metadata', () => {
  const homeDir = makeHome();
  seedLegacyStore(homeDir, 'aaaaaaaa');
  const db = createSQLiteDatabase(path.join(storeDir(homeDir, 'aaaaaaaa'), 'events.sqlite'));
  sqliteRun(db, `UPDATE events SET timestamp = '2026-09-05 00:00:00', metadata = ?`, [
    JSON.stringify({ source: '/private/secret-source', originalTimestamp: '2026-09-05T00:00:00Z' })
  ]);
  sqliteRun(db, `UPDATE retrieval_traces SET delivery_client = ?`, ['/private/secret-client']);
  sqliteClose(db);
  const report = buildMemoryAuditReport({
    homeDir, allProjects: true, until: new Date('2026-09-05T00:00:00Z'), now: new Date('2030-01-01T00:00:00Z')
  });
  expect(report.stores[0].events).toMatchObject({ last24h: 0, last48h: 0, window: 0 });
  const inclusive = buildMemoryAuditReport({ homeDir, allProjects: true, until: new Date('2026-09-05T00:00:01Z') });
  expect(inclusive.stores[0].events).toMatchObject({ last24h: 1, last48h: 1 });
  expect(inclusive.stores[0].sources[0]).toMatchObject({ source: 'other', medianLagMs: 0 });
  expect(JSON.stringify(buildMemoryAuditReport({ homeDir, allProjects: true }))).not.toContain('/private/secret-');
});

function readTableNames(dbPath: string): string[] {
  const db = createSQLiteDatabase(dbPath, { readonly: true });
  try {
    const rows = (db as unknown as { prepare(sql: string): { all(): Array<{ name: string }> } })
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all();
    return rows.map((row) => row.name);
  } finally {
    sqliteClose(db);
  }
}
