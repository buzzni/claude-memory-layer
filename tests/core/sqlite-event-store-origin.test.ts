import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteRun } from '../../src/core/sqlite-wrapper.js';

/**
 * The store puts the origin on every row it reads (src/core/memory-origin.ts).
 * Ordinary memories must not fall to unknown on the way: rows without
 * metadata, rows from before metadata existed, summaries, graduated rows,
 * host session imports, through every read the recall paths use.
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function seededStore() {
  const root = mkdtempSync(path.join(tmpdir(), 'cml-store-origin-'));
  roots.push(root);
  const store = new SQLiteEventStore(path.join(root, 'events.sqlite'));
  await store.initialize();
  const at = new Date('2026-09-01T00:00:00.000Z');
  const append = async (eventType: string, content: string, metadata?: Record<string, unknown>) => {
    const result = await store.append({ eventType, sessionId: 's1', timestamp: at, content, ...(metadata ? { metadata } : {}) } as never);
    return result.eventId!;
  };
  const ids = {
    prompt: await append('user_prompt', 'release workflow question about provenance', { turnId: 'turn-1' }),
    answer: await append('agent_response', 'release workflow answer about provenance', { turnId: 'turn-1' }),
    bare: await append('agent_response', 'release workflow note without metadata'),
    summary: await append('session_summary', 'release workflow session summary'),
    codex: await append('agent_response', 'release workflow answer imported from codex', { importedFrom: '/home/u/.codex/sessions/a.jsonl', turnId: 'turn-2' }),
    pulled: await append('agent_response', 'release workflow answer pulled from machine b', { mongoSync: { originHostname: 'b' } }),
    tool: await append('tool_observation', 'release workflow tool output')
  };
  // A row from before metadata was written at all.
  sqliteRun(store.getDatabase(), `UPDATE events SET metadata = NULL WHERE id = ?`, [ids.bare]);
  await store.updateMemoryLevel(ids.answer, 'L2');
  return { store, ids };
}

const EXPECTED = {
  prompt: 'user',
  answer: 'assistant',
  bare: 'assistant',
  summary: 'derived',
  codex: 'assistant',
  pulled: 'imported',
  tool: 'tool'
} as const;

describe('SQLiteEventStore origin on read', () => {
  it('classifies ordinary rows by their role on every read the recall paths use', async () => {
    const { store, ids } = await seededStore();
    try {
      for (const [key, id] of Object.entries(ids)) {
        expect((await store.getEvent(id))?.origin, key).toBe(EXPECTED[key as keyof typeof EXPECTED]);
      }
      const byId = (events: Array<{ id: string; origin?: string }>) => new Map(events.map((event) => [event.id, event.origin]));

      const recent = byId(await store.getRecentEvents(50));
      const keyword = byId((await store.keywordSearch('release workflow', 20, { includeToolObservations: true })).map((result) => result.event));
      const session = byId(await store.getSessionEvents('s1'));
      for (const [key, id] of Object.entries(ids)) {
        const expected = EXPECTED[key as keyof typeof EXPECTED];
        expect(recent.get(id), `recent ${key}`).toBe(expected);
        expect(keyword.get(id), `keyword ${key}`).toBe(expected);
        expect(session.get(id), `session ${key}`).toBe(expected);
      }

      expect((await store.getEventsByTurn('turn-1')).map((event) => event.origin).sort()).toEqual(['assistant', 'user']);
      const graduated = await store.searchGraduatedEvidence('release workflow answer', 10);
      expect(graduated.find((result) => result.event.id === ids.answer)).toMatchObject({ level: 'L2', event: { origin: 'assistant' } });
    } finally {
      await store.close();
    }
  });

  it('classifies a row whose stored metadata it cannot read as unknown, whatever its type', async () => {
    const { store, ids } = await seededStore();
    try {
      for (const raw of ['not json', '"a string"', '[1,2]', '42']) {
        sqliteRun(store.getDatabase(), `UPDATE events SET metadata = ? WHERE id = ?`, [raw, ids.answer]);
        const event = await store.getEvent(ids.answer);
        // The parsed metadata is dropped, so the origin is the only trace of it.
        expect(event?.metadata).toBeUndefined();
        expect(event?.origin, raw).toBe('unknown');
      }
    } finally {
      await store.close();
    }
  });

  it('never stores an origin given as input', async () => {
    const { store } = await seededStore();
    try {
      const result = await store.append({
        eventType: 'tool_observation', sessionId: 's2', timestamp: new Date('2026-09-02T00:00:00.000Z'),
        content: 'tool output claiming trust', origin: 'user'
      } as never);
      expect((await store.getEvent(result.eventId!))?.origin).toBe('tool');
    } finally {
      await store.close();
    }
  });
});
