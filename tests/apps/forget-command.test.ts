import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  formatForgetBeforeReport,
  listMirrorFilesBefore,
  resolveForgetBeforeOptions,
  runForgetBefore
} from '../../src/apps/cli/forget-command.js';
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
