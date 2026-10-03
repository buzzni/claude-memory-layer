import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { makeCanonicalKey, makeDedupeKey } from '../../src/core/canonical-key.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import type { EventType, MemoryEvent } from '../../src/core/types.js';

const roots: string[] = [];
const stores: SQLiteEventStore[] = [];
const sessionId = 'role-dedupe-session';
const content = 'The same text can be a request and an answer.';
const timestamp = new Date('2026-10-01T00:00:00Z');
const input = (eventType: EventType) => ({ eventType, sessionId, content, timestamp });
const legacy = (eventType: EventType): MemoryEvent => ({
  ...input(eventType), id: randomUUID(), canonicalKey: makeCanonicalKey(content), dedupeKey: makeDedupeKey(content, sessionId)
});

function fixture(dbPath?: string) {
  if (!dbPath) {
    const root = mkdtempSync(join(tmpdir(), 'cml-dedupe-roles-'));
    roots.push(root);
    dbPath = join(root, 'events.sqlite');
  }
  const store = new SQLiteEventStore(dbPath);
  stores.push(store);
  return { store, dbPath };
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => undefined)));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('SQLite event dedupe across roles and legacy keys', () => {
  it.each(['user_prompt', 'agent_response', 'tool_observation', 'session_summary'] as const)(
    'preserves a legacy %s and a different role with identical text across restarts', async (firstRole) => {
      const { store, dbPath } = fixture();
      const old = legacy(firstRole);
      expect(await store.importEvents([old])).toEqual({ inserted: 1, skipped: 0 });
      expect(await store.hasSessionUserPrompt(sessionId, [content])).toBe(firstRole === 'user_prompt');
      expect(await store.append(input(firstRole))).toMatchObject({ isDuplicate: true, eventId: old.id });

      const secondRole = firstRole === 'user_prompt' ? 'agent_response' : 'user_prompt';
      const second = await store.append(input(secondRole));
      expect(second).toMatchObject({ success: true, isDuplicate: false });
      expect(second.eventId).not.toBe(old.id);
      expect(await store.hasSessionUserPrompt(sessionId, [content])).toBe(true);
      expect(await store.hasSessionUserPrompt('another-session', [content])).toBe(false);
      expect(await store.append(input(secondRole))).toMatchObject({ isDuplicate: true, eventId: second.eventId });
      expect(await store.getSessionEvents(sessionId)).toHaveLength(2);

      expect(await store.deleteEventById(old.id)).toBe(true);
      await store.close();
      const reopened = fixture(dbPath).store;
      expect(await reopened.append(input(secondRole))).toMatchObject({ isDuplicate: true, eventId: second.eventId });
      expect(await reopened.getSessionEvents(sessionId)).toHaveLength(1);
    }
  );

  it('recognizes older exports after a typed append without duplicating the same role', async () => {
    const { store } = fixture();
    const prompt = await store.append(input('user_prompt'));
    const oldPrompt = legacy('user_prompt');
    const oldAnswer = legacy('agent_response');
    expect(await store.importEvents([oldPrompt, oldAnswer])).toEqual({ inserted: 1, skipped: 1 });
    expect(await store.getEvent(oldPrompt.id)).toBeNull();
    expect(await store.getEvent(oldAnswer.id)).toMatchObject({ eventType: 'agent_response', content });
    expect(await store.importEvents([oldPrompt, oldAnswer])).toEqual({ inserted: 0, skipped: 2 });
    expect(await store.append(input('user_prompt'))).toMatchObject({ eventId: prompt.eventId, isDuplicate: true });
    expect(await store.append(input('agent_response'))).toMatchObject({ eventId: oldAnswer.id, isDuplicate: true });
  });

  it('preserves both stable IDs when older exports share a content key across roles', async () => {
    const { store } = fixture();
    const rows = [legacy('agent_response'), legacy('user_prompt')];
    expect(await store.importEvents(rows)).toEqual({ inserted: 2, skipped: 0 });
    expect(await store.importEvents(rows)).toEqual({ inserted: 0, skipped: 2 });
    expect((await store.getSessionEvents(sessionId)).map((event) => event.id).sort()).toEqual(rows.map((event) => event.id).sort());
    expect(await store.hasSessionUserPrompt(sessionId, [content])).toBe(true);
  });

  it('dedupes cross-machine replication regardless of the order roles were appended', async () => {
    const a = fixture().store;
    const b = fixture().store;
    for (const role of ['user_prompt', 'agent_response'] as const) await a.append(input(role));
    for (const role of ['agent_response', 'user_prompt'] as const) await b.append(input(role));
    expect(await a.importEvents(await b.getSessionEvents(sessionId))).toEqual({ inserted: 0, skipped: 2 });
    expect(await b.importEvents(await a.getSessionEvents(sessionId))).toEqual({ inserted: 0, skipped: 2 });
    expect(await a.getSessionEvents(sessionId)).toHaveLength(2);
    expect(await b.getSessionEvents(sessionId)).toHaveLength(2);
  });
});
