import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { planSqliteRedaction } from '../../src/core/operations/credential-redaction.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteAll } from '../../src/core/sqlite-wrapper.js';

const roots: string[] = [];
const stores: SQLiteEventStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SECRET = 'api_key=sk-live-1234567890abcdef';

async function seededStore(): Promise<{ store: SQLiteEventStore; leakedId: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-redact-audit-'));
  roots.push(dir);
  const store = new SQLiteEventStore(path.join(dir, 'events.sqlite'));
  await store.initialize();
  stores.push(store);
  const { eventId } = await store.append({
    eventType: 'user_prompt', sessionId: 's1', timestamp: new Date('2026-01-01T00:00:00.000Z'), content: 'placeholder'
  });
  // Rows written before the ingest-side filter existed still hold the raw secret.
  store.getDatabase().prepare('UPDATE events SET content = ? WHERE id = ?').run(`call it with ${SECRET}`, eventId);
  return { store, leakedId: eventId! };
}

function auditRows(store: SQLiteEventStore): Array<Record<string, string>> {
  return sqliteAll<Record<string, string>>(store.getDatabase(), 'SELECT * FROM memory_governance_audit');
}

describe('repair redact-credentials governance audit', () => {
  it('apply writes one credential_redact row with counts and event ids, never the secret', async () => {
    const { store, leakedId } = await seededStore();
    const db = store.getDatabase();

    const plan = planSqliteRedaction(db, {
      apply: true,
      audit: { actor: 'cli', fileChanges: [{ filePath: '/store/memory/default/user_prompt/2026-01-01.md', occurrences: 1 }] }
    });

    expect(plan.affectedEventIds).toEqual([leakedId]);
    const rows = auditRows(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operation: 'credential_redact', actor: 'cli', target_type: 'store', target_id: 'redact-credentials' });
    expect(JSON.parse(rows[0].after_json)).toEqual({
      rowsRedacted: 1, rowsByColumn: { 'events.content': 1 }, eventsAffected: 1, mirrorFilesRedacted: 1
    });
    expect(JSON.parse(rows[0].source_event_ids)).toEqual([leakedId]);
    expect(JSON.stringify(rows[0])).not.toContain('sk-live');
  });

  it('dry-run and a clean store write nothing', async () => {
    const { store } = await seededStore();
    const db = store.getDatabase();

    planSqliteRedaction(db, { apply: false, audit: { actor: 'cli', fileChanges: [] } });
    expect(auditRows(store)).toEqual([]);

    planSqliteRedaction(db, { apply: true, audit: { actor: 'cli', fileChanges: [] } });
    planSqliteRedaction(db, { apply: true, audit: { actor: 'cli', fileChanges: [] } });
    // The second apply finds nothing left to redact, so only the first left a row.
    expect(auditRows(store)).toHaveLength(1);
  });

  it('rolls the redaction back when the audit row cannot be written', async () => {
    const { store, leakedId } = await seededStore();

    expect(() => planSqliteRedaction(store.getDatabase(), { apply: true, audit: { actor: ' ', fileChanges: [] } }))
      .toThrow('actor is required');

    expect((await store.getEvent(leakedId))?.content).toContain(SECRET);
    expect(auditRows(store)).toEqual([]);
  });
});
