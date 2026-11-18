import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventStore } from '../../src/core/event-store.js';
import { createWorkingSetStore } from '../../src/core/working-set-store.js';
import { dbRun } from '../../src/core/db-wrapper.js';
import { EndlessModeConfigSchema } from '../../src/core/types.js';

/**
 * The working set and the older EventStore read event rows with their own SQL.
 * They classify a row from its raw columns like SQLiteEventStore does, so the
 * same row has the same origin whichever store returns it.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'cml-working-set-origin-'));
  dirs.push(dir);
  const store = new EventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  const at = new Date();
  const append = async (eventType: string, content: string, metadata?: Record<string, unknown>) =>
    (await store.append({ eventType, sessionId: 's1', timestamp: at, content, ...(metadata ? { metadata } : {}) } as never)).eventId!;
  const ids = {
    answer: await append('agent_response', 'a plain answer'),
    pulled: await append('agent_response', 'an answer from machine b', { mongoSync: { originHostname: 'b' } }),
    tool: await append('tool_observation', 'tool output'),
    unreadable: await append('agent_response', 'an answer whose metadata is a JSON string')
  };
  await dbRun(store.getDatabase(), `UPDATE events SET metadata = ? WHERE id = ?`, ['"{\\"turnId\\":\\"t\\"}"', ids.unreadable]);
  return { store, ids };
}

const EXPECTED = { answer: 'assistant', pulled: 'imported', tool: 'tool', unreadable: 'unknown' } as const;

describe('origin from the working set and the older EventStore', () => {
  it('classifies rows from their raw columns in EventStore reads', async () => {
    const { store, ids } = await seeded();
    try {
      for (const [key, id] of Object.entries(ids)) {
        expect((await store.getEvent(id))?.origin, key).toBe(EXPECTED[key as keyof typeof EXPECTED]);
      }
    } finally {
      await store.close();
    }
  });

  it('classifies rows from their raw columns in working-set reads', async () => {
    const { store, ids } = await seeded();
    try {
      const workingSet = createWorkingSetStore(store, EndlessModeConfigSchema.parse({}));
      for (const id of Object.values(ids)) await workingSet.add(id);
      const byId = new Map((await workingSet.get()).recentEvents.map((event) => [event.id, event.origin]));
      for (const [key, id] of Object.entries(ids)) {
        expect(byId.get(id), key).toBe(EXPECTED[key as keyof typeof EXPECTED]);
      }
    } finally {
      await store.close();
    }
  });
});

describe('working-set reads', () => {
  it('leave out events that are quarantined, as every SQLiteEventStore read does', async () => {
    const { store, ids } = await seeded();
    try {
      await dbRun(store.getDatabase(), `UPDATE events SET metadata = ? WHERE id = ?`, [
        JSON.stringify({ quarantine: { status: 'active', category: 'superseded' } }),
        ids.answer
      ]);
      const workingSet = createWorkingSetStore(store, EndlessModeConfigSchema.parse({}));
      for (const id of Object.values(ids)) await workingSet.add(id);
      const shown = (await workingSet.get()).recentEvents.map((event) => event.id);
      expect(shown).not.toContain(ids.answer);
      expect(shown).toContain(ids.pulled);
    } finally {
      await store.close();
    }
  });
});
