import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { formatMirrorEntry } from '../../src/core/markdown-mirror.js';
import type { MemoryEvent } from '../../src/core/types.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

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

function mirrorEntry(id: string, sessionId: string, content: string): string {
  return formatMirrorEntry({
    id, sessionId, eventType: 'user_prompt', timestamp: new Date('2026-01-01T00:00:00.000Z'),
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
});

describe('runForgetTarget', () => {
  const vectorCalls = () => {
    const calls: string[] = [];
    return {
      calls,
      vectorStore: {
        deleteEventEverywhere: async (id: string) => { calls.push(`event:${id}`); },
        deleteSessionEverywhere: async (id: string) => { calls.push(`session:${id}`); }
      }
    };
  };

  it('dry-run reports one session without deleting rows, vectors or mirror entries', async () => {
    const storagePath = tempStoragePath();
    const ids = await seedStore(storagePath);
    const vectors = vectorCalls();

    const report = await runForgetTarget(storagePath, { target: { kind: 'session', sessionId: 's1' }, apply: false }, vectors);

    expect(report).toMatchObject({ rows: 3, applied: null });
    expect(vectors.calls).toEqual([]);
    const store = new SQLiteEventStore(path.join(storagePath, 'events.sqlite'));
    await store.initialize();
    expect(await store.getEvent(ids.oldTool)).not.toBeNull();
    await store.close();
  });

  it('apply deletes one event, its vectors and its mirror entry, and leaves the rest', async () => {
    const storagePath = tempStoragePath();
    const ids = await seedStore(storagePath);
    const file = path.join(storagePath, 'memory', 'default', 'tool_observation', '2026-01-01.md');
    mkdirSync(path.dirname(file), { recursive: true });
    const other = mirrorEntry(ids.newTool, 's1', 'new tool output');
    writeFileSync(file, mirrorEntry(ids.oldTool, 's1', 'old tool output') + other);
    const vectors = vectorCalls();

    const report = await runForgetTarget(storagePath, { target: { kind: 'event', eventId: ids.oldTool }, apply: true }, vectors);

    expect(report).toMatchObject({ rows: 1, contentBytes: Buffer.byteLength('old tool output'), mirrorEntries: 1 });
    expect(report.applied).toEqual({ deleted: 1, vectorsPurged: true, mirrorEntriesRemoved: 1 });
    expect(vectors.calls).toEqual([`event:${ids.oldTool}`]);
    expect(readFileSync(file, 'utf8')).toBe(other);
    const store = new SQLiteEventStore(path.join(storagePath, 'events.sqlite'));
    await store.initialize();
    expect(await store.getEvent(ids.oldTool)).toBeNull();
    expect(await store.getEvent(ids.newTool)).not.toBeNull();
    await store.close();
  });

  it('still purges vectors on a re-run after the rows are gone, and warns when that fails', async () => {
    const storagePath = tempStoragePath();
    await seedStore(storagePath);
    const failing = {
      deleteEventEverywhere: async () => undefined,
      deleteSessionEverywhere: async () => { throw new Error('lance down'); }
    };

    const first = await runForgetTarget(storagePath, { target: { kind: 'session', sessionId: 's1' }, apply: true }, { vectorStore: failing });
    expect(first.applied).toMatchObject({ deleted: 3, vectorsPurged: false });
    expect(first.warnings?.[0]).toContain('lance down');
    expect(formatForgetTargetReport(first)).toContain('Warning: vector deletion failed');

    const vectors = vectorCalls();
    const rerun = await runForgetTarget(storagePath, { target: { kind: 'session', sessionId: 's1' }, apply: true }, vectors);
    expect(rerun.applied).toMatchObject({ deleted: 0, vectorsPurged: true });
    expect(vectors.calls).toEqual(['session:s1']);
  });

  it('creates nothing when the project has no store', async () => {
    const storagePath = path.join(tempStoragePath(), 'missing');
    const report = await runForgetTarget(storagePath, { target: { kind: 'event', eventId: 'x' }, apply: true });
    expect(report).toMatchObject({ rows: 0, applied: { deleted: 0, mirrorEntriesRemoved: 0 } });
    expect(existsSync(storagePath)).toBe(false);
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
