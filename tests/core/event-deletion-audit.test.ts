import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteAll } from '../../src/core/sqlite-wrapper.js';

const roots: string[] = [];
const stores: SQLiteEventStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function openStore(): Promise<SQLiteEventStore> {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-delete-audit-'));
  roots.push(dir);
  const store = new SQLiteEventStore(path.join(dir, 'events.sqlite'));
  await store.initialize();
  stores.push(store);
  return store;
}

interface AuditRow {
  operation: string;
  actor: string;
  target_type: string;
  target_id: string;
  before_json: string | null;
  after_json: string | null;
  source_event_ids: string;
}

function auditRows(store: SQLiteEventStore): AuditRow[] {
  return sqliteAll<AuditRow>(store.getDatabase(), 'SELECT * FROM memory_governance_audit ORDER BY created_at');
}

const SECRET_CONTENT = 'deploy with token sk-live-do-not-keep';

describe('event deletes write a governance audit row in the same transaction', () => {
  it('deleteEventById records scope and count, never the deleted content', async () => {
    const store = await openStore();
    const { eventId } = await store.append({
      eventType: 'user_prompt', sessionId: 's1', timestamp: new Date('2026-01-01T00:00:00.000Z'), content: SECRET_CONTENT
    });

    await expect(store.deleteEventById(eventId!, {
      operation: 'event_delete', actor: 'dashboard', targetType: 'event', targetId: eventId!, sourceEventIds: [eventId!]
    })).resolves.toBe(true);

    const rows = auditRows(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operation: 'event_delete', actor: 'dashboard', target_type: 'event', target_id: eventId });
    expect(JSON.parse(rows[0].after_json!)).toEqual({ deletedEvents: 1 });
    expect(JSON.parse(rows[0].source_event_ids)).toEqual([eventId]);
    expect(JSON.stringify(rows[0])).not.toContain('sk-live');
  });

  it('writes nothing when nothing was deleted', async () => {
    const store = await openStore();

    await expect(store.deleteEventById('missing', {
      operation: 'event_delete', actor: 'dashboard', targetType: 'event', targetId: 'missing'
    })).resolves.toBe(false);
    await expect(store.deleteSessionEvents('missing-session', {
      operation: 'session_reimport', actor: 'cli', targetType: 'session', targetId: 'missing-session'
    })).resolves.toBe(0);
    await expect(store.deleteEventsBefore(new Date('2026-02-01T00:00:00.000Z'), undefined, {
      operation: 'event_delete', actor: 'cli', targetType: 'events_before', targetId: '2026-02-01'
    })).resolves.toMatchObject({ deleted: 0 });

    expect(auditRows(store)).toEqual([]);
  });

  it('deleteSessionEvents and deleteEventsBefore write one row per call with the deleted count', async () => {
    const store = await openStore();
    for (const content of ['a', 'b', 'c']) {
      await store.append({ eventType: 'user_prompt', sessionId: 'reimported', timestamp: new Date('2026-03-01T00:00:00.000Z'), content });
    }
    for (const content of ['old 1', 'old 2']) {
      await store.append({ eventType: 'tool_observation', sessionId: 'other', timestamp: new Date('2026-01-01T00:00:00.000Z'), content });
    }

    await expect(store.deleteSessionEvents('reimported', {
      operation: 'session_reimport', actor: 'mcp', targetType: 'session', targetId: 'reimported', beforeJson: { source: 'claude' }
    })).resolves.toBe(3);
    await expect(store.deleteEventsBefore(new Date('2026-02-01T00:00:00.000Z'), 'tool_observation', {
      operation: 'event_delete', actor: 'cli', targetType: 'events_before', targetId: '2026-02-01:tool_observation'
    })).resolves.toMatchObject({ deleted: 2 });

    const rows = auditRows(store);
    expect(rows.map((row) => [row.operation, row.actor, row.target_id, JSON.parse(row.after_json!)])).toEqual([
      ['session_reimport', 'mcp', 'reimported', { deletedEvents: 3 }],
      ['event_delete', 'cli', '2026-02-01:tool_observation', { deletedEvents: 2 }]
    ]);
  });

  it('rolls the delete back when the audit row cannot be written', async () => {
    const store = await openStore();
    const { eventId } = await store.append({
      eventType: 'user_prompt', sessionId: 's1', timestamp: new Date('2026-01-01T00:00:00.000Z'), content: 'keep me'
    });

    // An empty actor is rejected by the audit writer, inside the delete transaction.
    await expect(store.deleteEventById(eventId!, {
      operation: 'event_delete', actor: ' ', targetType: 'event', targetId: eventId!
    })).rejects.toThrow('actor is required');

    expect(await store.getEvent(eventId!)).not.toBeNull();
    expect(auditRows(store)).toEqual([]);
    // The FTS triggers dropped inside the rolled-back transaction are back.
    expect(await store.keywordSearch('keep', 5)).toHaveLength(1);
  });
});
