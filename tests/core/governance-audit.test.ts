import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { writeGovernanceAuditEntry } from '../../src/core/operations/governance-audit.js';
import { sqliteGet } from '../../src/core/sqlite-wrapper.js';

const tempDirs: string[] = [];

async function createStore(): Promise<{ store: SQLiteEventStore; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-governance-audit-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  return {
    store,
    cleanup: async () => {
      await store.close();
    }
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('writeGovernanceAuditEntry', () => {
  it('writes an auditable governance operation with normalized scope and JSON payloads', async () => {
    const { store, cleanup } = await createStore();
    const db = store.getDatabase();

    const entry = await writeGovernanceAuditEntry(db, {
      operation: 'facet_tag',
      actor: ' hermes ',
      projectHash: ' project-1 ',
      targetType: 'event',
      targetId: ' event-1 ',
      beforeJson: { previous: null },
      afterJson: { dimension: 'kind', value: 'debugging' },
      sourceEventIds: [' event-source-1 ', 'event-source-2']
    });

    const row = sqliteGet<Record<string, unknown>>(
      db,
      `SELECT * FROM memory_governance_audit WHERE audit_id = ?`,
      [entry.auditId]
    );
    await cleanup();

    expect(entry.actor).toBe('hermes');
    expect(entry.projectHash).toBe('project-1');
    expect(entry.targetId).toBe('event-1');
    expect(entry.sourceEventIds).toEqual(['event-source-1', 'event-source-2']);
    expect(row?.actor).toBe('hermes');
    expect(row?.project_hash).toBe('project-1');
    expect(JSON.parse(String(row?.before_json))).toEqual({ previous: null });
    expect(JSON.parse(String(row?.after_json))).toEqual({ dimension: 'kind', value: 'debugging' });
    expect(JSON.parse(String(row?.source_event_ids))).toEqual(['event-source-1', 'event-source-2']);
  });

  it('defaults source event ids and optional JSON fields safely', async () => {
    const { store, cleanup } = await createStore();
    const db = store.getDatabase();

    const entry = await writeGovernanceAuditEntry(db, {
      operation: 'verify',
      actor: 'system',
      targetType: 'lesson',
      targetId: 'lesson-1'
    });

    const row = sqliteGet<Record<string, unknown>>(
      db,
      `SELECT * FROM memory_governance_audit WHERE audit_id = ?`,
      [entry.auditId]
    );
    await cleanup();

    expect(entry.sourceEventIds).toEqual([]);
    expect(entry.projectHash).toBeUndefined();
    expect(row?.project_hash).toBeNull();
    expect(row?.before_json).toBeNull();
    expect(row?.after_json).toBeNull();
    expect(JSON.parse(String(row?.source_event_ids))).toEqual([]);
  });

  it('redacts credential-shaped and local-path-shaped audit payload strings', async () => {
    const { store, cleanup } = await createStore();
    const db = store.getDatabase();
    const localPath = ['/Users', 'fixture-user', 'workspace', 'private-note.md'].join('/');
    const tokenParam = ['token', 'fixture'].join('=');

    const entry = await writeGovernanceAuditEntry(db, {
      operation: 'facet_tag',
      actor: 'system',
      targetType: 'event',
      targetId: `${localPath}?${tokenParam}`,
      beforeJson: { apiKey: 'fixture', nested: { note: `read ${localPath}?${tokenParam}` } },
      afterJson: { clientSecret: 'fixture', url: `https://example.invalid/callback?${tokenParam}` },
      sourceEventIds: [`${localPath}#event`, tokenParam]
    });

    const row = sqliteGet<Record<string, unknown>>(
      db,
      `SELECT * FROM memory_governance_audit WHERE audit_id = ?`,
      [entry.auditId]
    );
    await cleanup();

    const beforeJson = JSON.parse(String(row?.before_json));
    const afterJson = JSON.parse(String(row?.after_json));
    const sourceEventIds = JSON.parse(String(row?.source_event_ids));

    const unredactedUserPathPrefix = ['/Users', 'fixture-user'].join('/');

    expect(String(row?.target_id)).not.toContain(unredactedUserPathPrefix);
    expect(String(row?.target_id)).not.toContain(tokenParam);
    expect(beforeJson.apiKey).toBe('[REDACTED]');
    expect(beforeJson.nested.note).not.toContain(unredactedUserPathPrefix);
    expect(beforeJson.nested.note).not.toContain(tokenParam);
    expect(afterJson.clientSecret).toBe('[REDACTED]');
    expect(afterJson.url).not.toContain(tokenParam);
    expect(sourceEventIds.join(' ')).not.toContain(unredactedUserPathPrefix);
    expect(sourceEventIds.join(' ')).not.toContain(tokenParam);
  });
});
