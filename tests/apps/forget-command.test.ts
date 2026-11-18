import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  formatForgetBeforeReport,
  formatForgetTargetReport,
  listMirrorFilesBefore,
  removeMirrorEntries,
  resolveForgetBeforeOptions,
  resolveForgetSelection,
  runForgetBefore,
  runForgetTarget
} from '../../src/apps/cli/forget-command.js';
import { formatMirrorEntry, MarkdownMirror } from '../../src/core/markdown-mirror.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteAll, sqliteRun } from '../../src/core/sqlite-wrapper.js';
import type { MemoryEvent } from '../../src/core/types.js';
import { VectorStore } from '../../src/core/vector-store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempStoragePath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-forget-'));
  roots.push(dir);
  return dir;
}

async function seedStore(storagePath: string): Promise<{ oldTool: string; newTool: string; oldPrompt: string }> {
  const store = new SQLiteEventStore(path.join(storagePath, 'events.sqlite'));
  await store.initialize();
  const oldTool = await store.append({
    eventType: 'tool_observation', sessionId: 's1', timestamp: new Date('2026-01-01T00:00:00.000Z'), content: 'old tool output'
  });
  const newTool = await store.append({
    eventType: 'tool_observation', sessionId: 's1', timestamp: new Date('2026-03-01T00:00:00.000Z'), content: 'new tool output'
  });
  const oldPrompt = await store.append({
    eventType: 'user_prompt', sessionId: 's1', timestamp: new Date('2026-01-01T00:00:00.000Z'), content: 'old prompt'
  });
  await store.close();
  return { oldTool: oldTool.eventId!, newTool: newTool.eventId!, oldPrompt: oldPrompt.eventId! };
}

function seedMirror(storagePath: string): Record<string, string> {
  const files = {
    oldTool: path.join(storagePath, 'memory', 'default', 'tool_observation', '2026-01-01.md'),
    newTool: path.join(storagePath, 'memory', 'default', 'tool_observation', '2026-03-01.md'),
    oldPrompt: path.join(storagePath, 'memory', 'default', 'user_prompt', '2026-01-01.md'),
    notes: path.join(storagePath, 'memory', 'default', 'tool_observation', 'README.md')
  };
  for (const file of Object.values(files)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '- mirror entry\n');
  }
  return files;
}

async function readDeletionAuditRows(storagePath: string): Promise<Array<Record<string, string>>> {
  const store = new SQLiteEventStore(path.join(storagePath, 'events.sqlite'));
  await store.initialize();
  try {
    return sqliteAll<Record<string, string>>(
      store.getDatabase(),
      `SELECT * FROM memory_governance_audit WHERE operation = 'event_delete'`
    );
  } finally {
    await store.close();
  }
}

describe('forget --before options', () => {
  it('parses a YYYY-MM-DD cutoff as UTC midnight and keeps the optional type', () => {
    expect(resolveForgetBeforeOptions({ before: '2026-02-01', type: 'tool_observation', confirm: true })).toEqual({
      before: new Date('2026-02-01T00:00:00.000Z'),
      eventType: 'tool_observation',
      apply: true
    });
    expect(resolveForgetBeforeOptions({ before: '2026-02-01' }).apply).toBe(false);
    expect(resolveForgetBeforeOptions({ before: '2026-02-01' }).eventType).toBeUndefined();
  });

  it('rejects a malformed or impossible date', () => {
    expect(() => resolveForgetBeforeOptions({ before: '2026/02/01' })).toThrow('--before must be YYYY-MM-DD');
    expect(() => resolveForgetBeforeOptions({ before: '2026-13-40' })).toThrow('--before must be YYYY-MM-DD');
  });
});

describe('listMirrorFilesBefore', () => {
  it('selects only dated mirror files of the given type older than the cutoff', () => {
    const storagePath = tempStoragePath();
    const files = seedMirror(storagePath);

    expect(listMirrorFilesBefore(storagePath, new Date('2026-02-01T00:00:00.000Z'), 'tool_observation'))
      .toEqual([files.oldTool]);
    expect(listMirrorFilesBefore(storagePath, new Date('2026-02-01T00:00:00.000Z')).sort())
      .toEqual([files.oldTool, files.oldPrompt].sort());
  });

  it('returns nothing when the mirror directory is absent', () => {
    expect(listMirrorFilesBefore(tempStoragePath(), new Date('2026-02-01T00:00:00.000Z'))).toEqual([]);
  });
});

describe('runForgetBefore', () => {
  it('dry-run reports the plan without deleting rows, vectors or mirror files', async () => {
    const storagePath = tempStoragePath();
    const ids = await seedStore(storagePath);
    const files = seedMirror(storagePath);
    const vectorDeletes: Array<[Date, string | undefined]> = [];

    const report = await runForgetBefore(storagePath, {
      before: new Date('2026-02-01T00:00:00.000Z'), eventType: 'tool_observation', apply: false
    }, { vectorStore: { deleteEventsBefore: async (before, eventType) => { vectorDeletes.push([before, eventType]); } } });

    expect(report).toMatchObject({ apply: false, rows: 1, contentBytes: Buffer.byteLength('old tool output'), mirrorFiles: [files.oldTool], applied: null });
    expect(vectorDeletes).toEqual([]);
    expect(existsSync(files.oldTool)).toBe(true);
    const store = new SQLiteEventStore(path.join(storagePath, 'events.sqlite'));
    await store.initialize();
    expect(await store.getEvent(ids.oldTool)).not.toBeNull();
    await store.close();
  });

  it('apply deletes matching rows, their vectors and dated mirror files, and leaves the rest', async () => {
    const storagePath = tempStoragePath();
    const ids = await seedStore(storagePath);
    const files = seedMirror(storagePath);
    const vectorDeletes: Array<[Date, string | undefined]> = [];

    const report = await runForgetBefore(storagePath, {
      before: new Date('2026-02-01T00:00:00.000Z'), eventType: 'tool_observation', apply: true
    }, { vectorStore: { deleteEventsBefore: async (before, eventType) => { vectorDeletes.push([before, eventType]); } } });

    expect(report.applied).toMatchObject({ deleted: 1, vectorsPurged: true, mirrorFilesRemoved: 1 });
    expect(vectorDeletes).toEqual([[new Date('2026-02-01T00:00:00.000Z'), 'tool_observation']]);
    expect(existsSync(files.oldTool)).toBe(false);
    expect(existsSync(files.newTool)).toBe(true);
    expect(existsSync(files.oldPrompt)).toBe(true);
    expect(existsSync(files.notes)).toBe(true);
    const store = new SQLiteEventStore(path.join(storagePath, 'events.sqlite'));
    await store.initialize();
    expect(await store.getEvent(ids.oldTool)).toBeNull();
    expect(await store.getEvent(ids.newTool)).not.toBeNull();
    expect(await store.getEvent(ids.oldPrompt)).not.toBeNull();
    await store.close();
  });

  it('apply records one governance audit row for the purge, with scope and counts but no content or event ids', async () => {
    const storagePath = tempStoragePath();
    const ids = await seedStore(storagePath);
    seedMirror(storagePath);

    await runForgetBefore(storagePath, {
      before: new Date('2026-02-01T00:00:00.000Z'), eventType: 'tool_observation', apply: true
    }, { vectorStore: { deleteEventsBefore: async () => {} } });

    const rows = await readDeletionAuditRows(storagePath);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operation: 'event_delete', actor: 'cli', target_type: 'events_before', target_id: '2026-02-01:tool_observation' });
    expect(JSON.parse(rows[0].before_json)).toEqual({
      command: 'forget --before',
      before: '2026-02-01',
      eventType: 'tool_observation',
      matchingRows: 1,
      contentBytes: Buffer.byteLength('old tool output'),
      mirrorFiles: 1
    });
    expect(JSON.parse(rows[0].after_json)).toEqual({ deletedEvents: 1 });
    expect(JSON.parse(rows[0].source_event_ids)).toEqual([]);
    expect(JSON.stringify(rows[0])).not.toContain('old tool output');
    expect(JSON.stringify(rows[0])).not.toContain(ids.oldTool);
  });

  it('records a purge of every type with a null type and the date alone as its target', async () => {
    const storagePath = tempStoragePath();
    await seedStore(storagePath);

    await runForgetBefore(storagePath, {
      before: new Date('2026-02-01T00:00:00.000Z'), apply: true
    }, { vectorStore: { deleteEventsBefore: async () => {} } });

    const rows = await readDeletionAuditRows(storagePath);
    expect(rows).toHaveLength(1);
    expect(rows[0].target_id).toBe('2026-02-01');
    expect(JSON.parse(rows[0].before_json)).toMatchObject({ eventType: null, matchingRows: 2, mirrorFiles: 0 });
    expect(JSON.parse(rows[0].after_json)).toEqual({ deletedEvents: 2 });
  });

  it('dry-run, and an apply that matches nothing, write no audit row', async () => {
    const storagePath = tempStoragePath();
    await seedStore(storagePath);

    await runForgetBefore(storagePath, { before: new Date('2026-02-01T00:00:00.000Z'), apply: false });
    await runForgetBefore(storagePath, {
      before: new Date('2025-01-01T00:00:00.000Z'), apply: true
    }, { vectorStore: { deleteEventsBefore: async () => {} } });

    expect(await readDeletionAuditRows(storagePath)).toEqual([]);
  });

  it('reports an empty plan when there is no store', async () => {
    const report = await runForgetBefore(tempStoragePath(), {
      before: new Date('2026-02-01T00:00:00.000Z'), apply: true
    });
    expect(report).toMatchObject({ rows: 0, contentBytes: 0, mirrorFiles: [], applied: null });
  });
});

describe('formatForgetBeforeReport', () => {
  it('distinguishes a dry-run plan from an applied purge', () => {
    const base = { before: new Date('2026-02-01T00:00:00.000Z'), eventType: 'tool_observation', rows: 3, contentBytes: 2048, mirrorFiles: ['/x/2026-01-01.md'] };
    const dry = formatForgetBeforeReport({ ...base, apply: false, applied: null });
    expect(dry).toContain('dry-run');
    expect(dry).toContain('tool_observation');
    expect(dry).toContain('3');
    expect(dry).toContain('--confirm');
    const applied = formatForgetBeforeReport({ ...base, apply: true, applied: { deleted: 3, vectorsPurged: true, mirrorFilesRemoved: 1, vacuumed: true } });
    expect(applied).toContain('deleted 3');
    expect(applied).not.toContain('--confirm');
  });
});

describe('resolveForgetSelection', () => {
  it('picks the single selector given and keeps --confirm as apply', () => {
    expect(resolveForgetSelection('evt-1', { confirm: true })).toEqual({
      kind: 'target', options: { target: { kind: 'event', eventId: 'evt-1' }, apply: true }
    });
    expect(resolveForgetSelection(undefined, { session: 's1' })).toEqual({
      kind: 'target', options: { target: { kind: 'session', sessionId: 's1' }, apply: false }
    });
    expect(resolveForgetSelection(undefined, { before: '2026-02-01', type: 'tool_observation' })).toMatchObject({
      kind: 'before', options: { eventType: 'tool_observation', apply: false }
    });
  });

  it('refuses no selector, several selectors, or --type without --before', () => {
    expect(() => resolveForgetSelection(undefined, {})).toThrow('Please specify');
    expect(() => resolveForgetSelection('  ', { session: '' })).toThrow('Please specify');
    expect(() => resolveForgetSelection('evt-1', { session: 's1' })).toThrow('only one');
    expect(() => resolveForgetSelection(undefined, { session: 's1', before: '2026-02-01' })).toThrow('only one');
    expect(() => resolveForgetSelection('evt-1', { type: 'tool_observation' })).toThrow('--type');
  });
});

function mirrorEntry(id: string, sessionId: string, content: string, eventType = 'user_prompt'): string {
  return formatMirrorEntry({
    id, sessionId, eventType: eventType as MemoryEvent['eventType'], timestamp: new Date('2026-01-01T00:00:00.000Z'),
    content, canonicalKey: id, dedupeKey: id
  } satisfies MemoryEvent);
}

describe('removeMirrorEntries', () => {
  it('cuts only the matching entries out of shared day files and removes files left empty', () => {
    const storagePath = tempStoragePath();
    const shared = path.join(storagePath, 'memory', 'default', 'user_prompt', '2026-01-01.md');
    const onlyA = path.join(storagePath, 'memory', 'default', 'agent_response', '2026-01-01.md');
    mkdirSync(path.dirname(shared), { recursive: true });
    mkdirSync(path.dirname(onlyA), { recursive: true });
    // The b entry quotes an a header line in its content; content is indented, so it must survive.
    const keep = mirrorEntry('b1', 's-b', 'mentions\n  session: s-a\n- ts: fake');
    writeFileSync(shared, mirrorEntry('a1', 's-a', 'first\nline') + keep + mirrorEntry('a2', 's-a', 'second'));
    writeFileSync(onlyA, mirrorEntry('a3', 's-a', 'third'));

    const preview = removeMirrorEntries(storagePath, { kind: 'session', sessionId: 's-a' }, false);
    expect(preview).toMatchObject({ entries: 3, removed: 0, files: [onlyA, shared].sort() });
    expect(existsSync(onlyA)).toBe(true);

    const applied = removeMirrorEntries(storagePath, { kind: 'session', sessionId: 's-a' }, true);
    expect(applied).toMatchObject({ entries: 3, removed: 3, warnings: [] });
    expect(readFileSync(shared, 'utf8')).toBe(keep);
    expect(existsSync(onlyA)).toBe(false);
  });

  it('matches an event id exactly, not as a prefix', () => {
    const storagePath = tempStoragePath();
    const file = path.join(storagePath, 'memory', 'default', 'user_prompt', '2026-01-01.md');
    mkdirSync(path.dirname(file), { recursive: true });
    const longer = mirrorEntry('evt-10', 's1', 'keep');
    writeFileSync(file, mirrorEntry('evt-1', 's1', 'drop') + longer);

    expect(removeMirrorEntries(storagePath, { kind: 'event', eventId: 'evt-1' }, true).removed).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(longer);
  });

  // formatMirrorEntry writes metadata.category unescaped, so a category can hold lines that look
  // like another entry's header fields or an entry boundary. Only the real fields count. The
  // category is also the mirror directory, so these entries land in different files.
  const mirrorFile = (storagePath: string) => path.join(storagePath, 'memory', 'default', 'notes', '2026-01-01.md');

  async function writeMirror(storagePath: string, events: Array<{ id: string; sessionId: string; category: string; content: string }>): Promise<Map<string, string>> {
    const mirror = new MarkdownMirror(storagePath);
    const files = new Set<string>();
    for (const event of events) {
      files.add(await mirror.append({
        id: event.id, sessionId: event.sessionId, eventType: 'user_prompt', timestamp: new Date('2026-01-01T12:00:00.000Z'),
        content: event.content, canonicalKey: event.id, dedupeKey: event.id, metadata: { category: event.category }
      }));
    }
    return new Map([...files].map((file) => [file, readFileSync(file, 'utf8')]));
  }

  const forged = (id: string, sessionId: string) =>
    `notes\n---\n- ts: 2026-01-01T00:00:00.000Z\n  id: ${id}\n  type: user_prompt\n  session: ${sessionId}\n  category: notes`;

  /** Every file as written, minus the real a1 entry (its file, `notes`, holds only that one). */
  function expectOnlyRealEntryRemoved(storagePath: string, before: Map<string, string>): void {
    expect(before.size).toBe(3);
    for (const [file, text] of before) {
      if (file === mirrorFile(storagePath)) {
        expect(text).toContain('alpha one');
        expect(existsSync(file)).toBe(false);
      } else {
        expect(readFileSync(file, 'utf8')).toBe(text);
      }
    }
  }

  it('--session matches only the real session field, not session or boundary lines inside a category', async () => {
    const storagePath = tempStoragePath();
    const before = await writeMirror(storagePath, [
      { id: 'b1', sessionId: 's-b', category: 'notes\n  session: s-a', content: 'bravo one' },
      { id: 'a1', sessionId: 's-a', category: 'notes', content: 'alpha one' },
      { id: 'b2', sessionId: 's-b', category: forged('a9', 's-a'), content: 'bravo two' }
    ]);

    const report = removeMirrorEntries(storagePath, { kind: 'session', sessionId: 's-a' }, true);

    expect(report).toMatchObject({ files: [mirrorFile(storagePath)], entries: 1, removed: 1, warnings: [] });
    expectOnlyRealEntryRemoved(storagePath, before);
  });

  it('<eventId> matches only the real id field, not id or boundary lines inside a category', async () => {
    const storagePath = tempStoragePath();
    const before = await writeMirror(storagePath, [
      { id: 'b1', sessionId: 's-b', category: 'notes\n  id: a1', content: 'bravo one' },
      { id: 'b2', sessionId: 's-b', category: forged('a1', 's-b'), content: 'bravo two' },
      { id: 'a1', sessionId: 's-a', category: 'notes', content: 'alpha one' }
    ]);

    const report = removeMirrorEntries(storagePath, { kind: 'event', eventId: 'a1' }, true);

    expect(report).toMatchObject({ files: [mirrorFile(storagePath)], entries: 1, removed: 1, warnings: [] });
    expectOnlyRealEntryRemoved(storagePath, before);
  });

  it('keeps the other entries of a shared file byte for byte when a category forges a boundary', () => {
    const storagePath = tempStoragePath();
    const file = mirrorFile(storagePath);
    mkdirSync(path.dirname(file), { recursive: true });
    const entry = (id: string, sessionId: string, category: string, content: string) => formatMirrorEntry({
      id, sessionId, eventType: 'user_prompt', timestamp: new Date('2026-01-01T12:00:00.000Z'),
      content, canonicalKey: id, dedupeKey: id, metadata: { category }
    });
    const keep = entry('b1', 's-b', forged('a1', 's-a'), 'bravo one');
    writeFileSync(file, entry('a1', 's-a', 'notes', 'alpha one') + keep);

    expect(removeMirrorEntries(storagePath, { kind: 'session', sessionId: 's-a' }, true)).toMatchObject({ entries: 1, removed: 1 });
    expect(readFileSync(file, 'utf8')).toBe(keep);
    expect(removeMirrorEntries(storagePath, { kind: 'event', eventId: 'a1' }, true)).toMatchObject({ entries: 0, removed: 0 });
    expect(readFileSync(file, 'utf8')).toBe(keep);
  });

  it('leaves a file it cannot read as mirror entries unchanged and warns when it names the target', () => {
    const storagePath = tempStoragePath();
    const file = mirrorFile(storagePath);
    mkdirSync(path.dirname(file), { recursive: true });
    // A torn last entry (no content section) makes the file ambiguous.
    const torn = mirrorEntry('a1', 's-a', 'alpha one') + '\n- ts: 2026-01-01T00:00:00.000Z\n  id: a2\n  type: user_prompt\n  session: s-a\n';
    writeFileSync(file, torn);

    const report = removeMirrorEntries(storagePath, { kind: 'session', sessionId: 's-a' }, true);

    expect(report).toMatchObject({ entries: 0, removed: 0 });
    expect(report.warnings).toEqual([expect.stringContaining('left unchanged')]);
    expect(readFileSync(file, 'utf8')).toBe(torn);
    expect(removeMirrorEntries(storagePath, { kind: 'session', sessionId: 's-other' }, true).warnings).toEqual([]);
  });
});

/**
 * #211: `forget <eventId>` and `forget --session` used to print "requires additional
 * implementation" and delete nothing. These run against a real SQLite store (with the vector
 * outbox on) and a real LanceDB directory holding both the legacy and a versioned event table.
 */
describe('runForgetTarget', () => {
  interface Seeded {
    a: { prompt: string; response: string; imported: string; synced: string; summary: string; tool: string };
    b: { prompt: string };
    all: string[];
    mirrorFile: string;
    keptMirror: string;
  }

  async function seedTarget(storagePath: string): Promise<Seeded> {
    const store = new SQLiteEventStore(path.join(storagePath, 'events.sqlite'), { vectorOutbox: {} });
    await store.initialize();
    const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 9, minute));
    const append = async (sessionId: string, eventType: MemoryEvent['eventType'], content: string, minute: number, metadata?: Record<string, unknown>) =>
      (await store.append({ eventType, sessionId, timestamp: at(minute), content, ...(metadata ? { metadata } : {}) })).eventId!;
    const a = {
      prompt: await append('s-a', 'user_prompt', 'alpha prompt', 0),
      response: await append('s-a', 'agent_response', 'alpha response', 1),
      // Rows the force-reimport scope (`importedFrom`) would keep or pick: forget takes all of them.
      imported: await append('s-a', 'user_prompt', 'alpha imported', 2, { importedFrom: '/sessions/s-a.jsonl' }),
      synced: await append('s-a', 'agent_response', 'alpha synced', 3, { mongoSync: { origin: 'other-machine' } }),
      summary: await append('s-a', 'session_summary', 'alpha summary', 4),
      tool: await append('s-a', 'tool_observation', 'alpha tool output', 5)
    };
    const b = { prompt: await append('s-b', 'user_prompt', 'bravo prompt', 6) };
    const all = [...Object.values(a), ...Object.values(b)];
    for (const id of all) await store.enqueueForEmbedding(id, 'embed me');
    await store.close();

    const vectors = new VectorStore(path.join(storagePath, 'vectors'));
    const records = (embeddingVersion?: string) => all.map((eventId, index) => ({
      id: embeddingVersion ? `event:${eventId}` : `legacy-${eventId}`,
      eventId,
      sessionId: Object.values(b).includes(eventId) ? 's-b' : 's-a',
      eventType: 'user_prompt',
      content: 'vector text',
      vector: Array.from({ length: 4 }, (_, i) => (i === index % 4 ? 1 : 0.1)),
      timestamp: at(index).toISOString(),
      ...(embeddingVersion ? { metadata: { itemKind: 'event', embeddingVersion } } : {})
    }));
    await vectors.upsertBatch(records());
    await vectors.upsertBatch(records('v1'));

    const mirrorFile = path.join(storagePath, 'memory', 'default', 'user_prompt', '2026-01-01.md');
    mkdirSync(path.dirname(mirrorFile), { recursive: true });
    const keptMirror = mirrorEntry(b.prompt, 's-b', 'bravo prompt');
    writeFileSync(mirrorFile, mirrorEntry(a.prompt, 's-a', 'alpha prompt') + keptMirror + mirrorEntry(a.imported, 's-a', 'alpha imported'));
    return { a, b, all, mirrorFile, keptMirror };
  }

  async function readState(storagePath: string) {
    const store = new SQLiteEventStore(path.join(storagePath, 'events.sqlite'));
    await store.initialize();
    const db = store.getDatabase();
    const ids = (sql: string) => sqliteAll<{ id: string }>(db, sql).map((row) => row.id).sort();
    try {
      return {
        events: ids(`SELECT id FROM events`),
        fts: ids(`SELECT event_id AS id FROM events_fts`),
        dedup: ids(`SELECT event_id AS id FROM event_dedup`),
        levels: ids(`SELECT event_id AS id FROM memory_levels`),
        embeddingOutbox: ids(`SELECT event_id AS id FROM embedding_outbox`),
        vectorOutbox: ids(`SELECT item_id AS id FROM vector_outbox WHERE item_kind = 'event'`),
        audit: sqliteAll<Record<string, string>>(db, `SELECT * FROM memory_governance_audit WHERE operation = 'event_delete'`)
      };
    } finally {
      await store.close();
    }
  }

  it('dry-run reports a session (quarantined rows included) and changes nothing', async () => {
    const storagePath = tempStoragePath();
    const seeded = await seedTarget(storagePath);
    const store = new SQLiteEventStore(path.join(storagePath, 'events.sqlite'));
    await store.initialize();
    sqliteRun(store.getDatabase(), `UPDATE events SET metadata = json_set(COALESCE(metadata, '{}'), '$.quarantine.status', 'active') WHERE id = ?`, [seeded.a.response]);
    await store.close();
    const before = await readState(storagePath);

    const session = await runForgetTarget(storagePath, { target: { kind: 'session', sessionId: 's-a' }, apply: false });
    const event = await runForgetTarget(storagePath, { target: { kind: 'event', eventId: seeded.a.response }, apply: false });

    expect(session).toMatchObject({ rows: 6, mirrorEntries: 2, applied: null });
    expect(event).toMatchObject({ rows: 1, contentBytes: Buffer.byteLength('alpha response'), mirrorEntries: 0, applied: null });
    expect(await readState(storagePath)).toEqual(before);
    expect(readFileSync(seeded.mirrorFile, 'utf8')).toContain(seeded.a.prompt);
    expect((await new VectorStore(path.join(storagePath, 'vectors')).listEventIds()).sort()).toEqual([...seeded.all].sort());
  });

  it('--session deletes every row of the session whatever wrote it, with its dependents, vectors, outbox jobs and mirror entries', async () => {
    const storagePath = tempStoragePath();
    const seeded = await seedTarget(storagePath);
    const sessionA = Object.values(seeded.a);
    expect((await readState(storagePath)).vectorOutbox).toEqual(expect.arrayContaining([seeded.a.prompt, seeded.b.prompt]));

    const report = await runForgetTarget(storagePath, { target: { kind: 'session', sessionId: 's-a' }, apply: true });

    expect(report.applied).toEqual({ deleted: 6, vectorsPurged: true, mirrorEntriesRemoved: 2 });
    expect(report.warnings).toBeUndefined();
    const state = await readState(storagePath);
    expect(state.events).toEqual([seeded.b.prompt]);
    expect(state.fts).toEqual([seeded.b.prompt]);
    expect(state.dedup).toEqual([seeded.b.prompt]);
    expect(state.levels).toEqual([seeded.b.prompt]);
    expect(state.embeddingOutbox).toEqual([seeded.b.prompt]);
    expect(state.vectorOutbox).toEqual([seeded.b.prompt]);
    const vectors = new VectorStore(path.join(storagePath, 'vectors'));
    expect(await vectors.listEventIds()).toEqual([seeded.b.prompt]);
    expect((await vectors.readRowsByEventIds('event_vectors_v1', seeded.all)).map((row) => row.eventId)).toEqual([seeded.b.prompt]);
    expect(readFileSync(seeded.mirrorFile, 'utf8')).toBe(seeded.keptMirror);

    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]).toMatchObject({ operation: 'event_delete', actor: 'cli', target_type: 'session', target_id: 's-a' });
    expect(JSON.parse(state.audit[0].before_json)).toEqual({
      command: 'forget --session',
      sessionId: 's-a',
      matchingRows: 6,
      contentBytes: report.contentBytes,
      mirrorEntries: 2
    });
    expect(JSON.parse(state.audit[0].after_json)).toEqual({ deletedEvents: 6 });
    for (const id of sessionA) expect(JSON.stringify(state.audit[0])).not.toContain(id);
    expect(JSON.stringify(state.audit[0])).not.toContain('alpha');
  });

  it('<eventId> deletes only that event, its dependents, vectors, outbox jobs and mirror entry', async () => {
    const storagePath = tempStoragePath();
    const seeded = await seedTarget(storagePath);
    const rest = seeded.all.filter((id) => id !== seeded.a.prompt).sort();

    const report = await runForgetTarget(storagePath, { target: { kind: 'event', eventId: seeded.a.prompt }, apply: true });

    expect(report).toMatchObject({ rows: 1, contentBytes: Buffer.byteLength('alpha prompt'), mirrorEntries: 1 });
    expect(report.applied).toEqual({ deleted: 1, vectorsPurged: true, mirrorEntriesRemoved: 1 });
    const state = await readState(storagePath);
    expect(state.events).toEqual(rest);
    expect(state.fts).toEqual(rest);
    expect(state.dedup).toEqual(rest);
    expect(state.embeddingOutbox).toEqual(rest);
    expect(state.vectorOutbox).not.toContain(seeded.a.prompt);
    expect(state.vectorOutbox).toContain(seeded.a.response);
    const vectors = new VectorStore(path.join(storagePath, 'vectors'));
    expect((await vectors.listEventIds()).sort()).toEqual(rest);
    expect((await vectors.readRowsByEventIds('event_vectors_v1', seeded.all)).map((row) => row.eventId).sort()).toEqual(rest);
    expect(readFileSync(seeded.mirrorFile, 'utf8')).toBe(seeded.keptMirror + mirrorEntry(seeded.a.imported, 's-a', 'alpha imported'));

    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]).toMatchObject({ actor: 'cli', target_type: 'event', target_id: seeded.a.prompt });
    expect(JSON.parse(state.audit[0].before_json)).toEqual({
      command: 'forget <eventId>',
      eventId: seeded.a.prompt,
      sessionId: 's-a',
      eventType: 'user_prompt',
      matchingRows: 1,
      contentBytes: Buffer.byteLength('alpha prompt'),
      mirrorEntries: 1
    });
    expect(JSON.parse(state.audit[0].after_json)).toEqual({ deletedEvents: 1 });
    expect(JSON.stringify(state.audit[0])).not.toContain('alpha');
  });

  it('rolls the delete back, and leaves vectors and mirror alone, when the audit cannot be written', async () => {
    const storagePath = tempStoragePath();
    const seeded = await seedTarget(storagePath);
    const store = new SQLiteEventStore(path.join(storagePath, 'events.sqlite'));
    await store.initialize();
    sqliteRun(store.getDatabase(), `CREATE TRIGGER fail_audit BEFORE INSERT ON memory_governance_audit BEGIN SELECT RAISE(ABORT, 'audit down'); END`);
    await store.close();
    const mirrorBefore = readFileSync(seeded.mirrorFile, 'utf8');
    const vectorDeletes: string[][] = [];
    const vectorStore = { deleteEvents: async (ids: readonly string[]) => { vectorDeletes.push([...ids]); } };

    for (const target of [{ kind: 'session' as const, sessionId: 's-a' }, { kind: 'event' as const, eventId: seeded.a.prompt }]) {
      await expect(runForgetTarget(storagePath, { target, apply: true }, { vectorStore })).rejects.toThrow('audit down');
    }

    const raw = new SQLiteEventStore(path.join(storagePath, 'events.sqlite'), { readonly: true });
    await raw.initialize();
    expect(sqliteAll<{ id: string }>(raw.getDatabase(), `SELECT id FROM events`)).toHaveLength(seeded.all.length);
    await raw.close();
    expect(vectorDeletes).toEqual([]);
    expect(readFileSync(seeded.mirrorFile, 'utf8')).toBe(mirrorBefore);
  });

  it('warns when vectors cannot be deleted, and a re-run for the event finishes the job', async () => {
    const storagePath = tempStoragePath();
    const seeded = await seedTarget(storagePath);
    const failing = { deleteEvents: async () => { throw new Error('lance down'); } };

    const first = await runForgetTarget(storagePath, { target: { kind: 'event', eventId: seeded.a.prompt }, apply: true }, { vectorStore: failing });
    expect(first.applied).toMatchObject({ deleted: 1, vectorsPurged: false });
    expect(first.warnings?.[0]).toContain('lance down');
    expect(formatForgetTargetReport(first)).toContain('Warning: vector deletion failed');
    expect(first.warnings?.[0]).toContain('re-run to retry');

    const rerun = await runForgetTarget(storagePath, { target: { kind: 'event', eventId: seeded.a.prompt }, apply: true });
    expect(rerun.applied).toMatchObject({ deleted: 0, vectorsPurged: true });
    expect(await new VectorStore(path.join(storagePath, 'vectors')).listEventIds()).not.toContain(seeded.a.prompt);
    expect((await readState(storagePath)).audit).toHaveLength(1);
  });

  it('says a session re-run cannot retry a failed vector delete', async () => {
    const storagePath = tempStoragePath();
    await seedTarget(storagePath);
    const failing = { deleteEvents: async () => { throw new Error('lance down'); } };

    const report = await runForgetTarget(storagePath, { target: { kind: 'session', sessionId: 's-a' }, apply: true }, { vectorStore: failing });

    expect(report.applied).toMatchObject({ deleted: 6, vectorsPurged: false, mirrorEntriesRemoved: 2 });
    expect(report.warnings).toEqual([expect.stringContaining('orphaned vectors of 6 event(s) remain (a re-run of --session cannot find them again): lance down')]);
  });

  it.skipIf(process.getuid?.() === 0)('warns when a mirror file cannot be rewritten', async () => {
    const storagePath = tempStoragePath();
    const seeded = await seedTarget(storagePath);
    chmodSync(seeded.mirrorFile, 0o444);

    const report = await runForgetTarget(storagePath, { target: { kind: 'event', eventId: seeded.a.prompt }, apply: true });

    expect(report.applied).toMatchObject({ deleted: 1, mirrorEntriesRemoved: 0 });
    expect(report.warnings?.[0]).toContain('could not rewrite');
  });

  it('creates nothing when the project has no store, and deletes nothing for an unknown id', async () => {
    const missing = path.join(tempStoragePath(), 'missing');
    const report = await runForgetTarget(missing, { target: { kind: 'session', sessionId: 's-a' }, apply: true });
    expect(report).toMatchObject({ rows: 0, applied: { deleted: 0, vectorsPurged: true, mirrorEntriesRemoved: 0 } });
    expect(existsSync(missing)).toBe(false);

    const storagePath = tempStoragePath();
    const seeded = await seedTarget(storagePath);
    const unknown = await runForgetTarget(storagePath, { target: { kind: 'event', eventId: 'no-such-event' }, apply: true });
    expect(unknown).toMatchObject({ rows: 0, applied: { deleted: 0 } });
    const state = await readState(storagePath);
    expect(state.events).toHaveLength(seeded.all.length);
    expect(state.audit).toEqual([]);
  });
});

describe('formatForgetTargetReport', () => {
  it('distinguishes a dry-run plan from an applied delete', () => {
    const base = { target: { kind: 'session' as const, sessionId: 's1' }, rows: 2, contentBytes: 2048, mirrorEntries: 2, mirrorFiles: ['/x/2026-01-01.md'] };
    const dry = formatForgetTargetReport({ ...base, apply: false, applied: null });
    expect(dry).toContain('session s1 (dry-run)');
    expect(dry).toContain('Matching rows: 2');
    expect(dry).toContain('--confirm');
    const applied = formatForgetTargetReport({ ...base, apply: true, applied: { deleted: 2, vectorsPurged: true, mirrorEntriesRemoved: 2 } });
    expect(applied).toContain('Events deleted 2');
    expect(applied).not.toContain('--confirm');
  });
});
