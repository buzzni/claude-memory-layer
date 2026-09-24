import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { FacetRepository } from '../../src/core/operations/facet-repository.js';
import { applyRetentionLifecycle } from '../../src/core/operations/retention-lifecycle.js';
import { hashProjectPath } from '../../src/core/registry/project-path.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteExec, sqliteGet } from '../../src/core/sqlite-wrapper.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('retention lifecycle apply', () => {
  it('writes audited lifecycle state idempotently without deleting canonical events', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-retention-lifecycle-'));
    roots.push(root);
    const projectHash = hashProjectPath(path.join(root, 'project'));
    const store = new SQLiteEventStore(path.join(root, 'events.sqlite'));
    await store.initialize();
    const appended = await store.append({
      eventType: 'tool_observation',
      sessionId: 'session-1',
      timestamp: new Date('2025-01-01T00:00:00.000Z'),
      content: 'bounded canonical evidence',
      metadata: { scope: { project: { hash: projectHash } } }
    });
    if (!appended.success) throw new Error('fixture append failed');
    const db = store.getDatabase();

    const first = await applyRetentionLifecycle(db, {
      projectHash,
      actor: 'test-operator',
      policyVersion: 'v1',
      expectedLifecycleVersion: 0,
      now: new Date('2026-08-31T00:00:00.000Z')
    });
    const second = await applyRetentionLifecycle(db, {
      projectHash,
      actor: 'test-operator',
      policyVersion: 'v1',
      expectedLifecycleVersion: 1,
      now: new Date('2026-08-31T00:00:00.000Z')
    });

    expect(first).toMatchObject({ written: 1, deletedEvents: 0, lifecycleVersion: 1 });
    expect(second).toMatchObject({ written: 0, unchanged: 1, deletedEvents: 0, lifecycleVersion: 1 });
    expect(Number(sqliteGet<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM events')?.count)).toBe(1);
    expect(Number(sqliteGet<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM memory_retention_scores')?.count)).toBe(1);
    expect(Number(sqliteGet<{ count: number }>(db, "SELECT COUNT(*) AS count FROM memory_governance_audit WHERE operation = 'retention_score'")?.count)).toBe(1);

    await expect(applyRetentionLifecycle(db, {
      projectHash,
      actor: 'test-operator',
      policyVersion: 'v1',
      expectedLifecycleVersion: 0
    })).rejects.toThrow(/version conflict/);
    await store.close();
  });

  it('rolls back scores and lifecycle version when audit persistence fails', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-retention-lifecycle-'));
    roots.push(root);
    const projectHash = hashProjectPath(path.join(root, 'project'));
    const store = new SQLiteEventStore(path.join(root, 'events.sqlite'));
    await store.initialize();
    const appended = await store.append({
      eventType: 'tool_observation',
      sessionId: 'session-rollback',
      timestamp: new Date('2025-01-01T00:00:00.000Z'),
      content: 'rollback evidence',
      metadata: { scope: { project: { hash: projectHash } } }
    });
    if (!appended.success) throw new Error('fixture append failed');
    const db = store.getDatabase();
    sqliteExec(db, 'DROP TABLE memory_governance_audit');

    await expect(applyRetentionLifecycle(db, {
      projectHash,
      actor: 'test-operator',
      policyVersion: 'v1',
      expectedLifecycleVersion: 0,
      now: new Date('2026-08-31T00:00:00.000Z')
    })).rejects.toThrow();
    expect(Number(sqliteGet<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM memory_retention_scores')?.count)).toBe(0);
    expect(sqliteGet(db, 'SELECT value FROM endless_config WHERE key = ?', [`retention_lifecycle_version:${projectHash}`])).toBeUndefined();
    await store.close();
  });

  it('allows a newer keep decision to reverse an earlier lifecycle decision', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-retention-lifecycle-'));
    roots.push(root);
    const projectHash = hashProjectPath(path.join(root, 'project'));
    const store = new SQLiteEventStore(path.join(root, 'events.sqlite'));
    await store.initialize();
    const appended = await store.append({
      eventType: 'tool_observation',
      sessionId: 'session-2',
      timestamp: new Date('2025-01-01T00:00:00.000Z'),
      content: 'reversible lifecycle evidence',
      metadata: { scope: { project: { hash: projectHash } } }
    });
    if (!appended.success) throw new Error('fixture append failed');
    const db = store.getDatabase();
    await applyRetentionLifecycle(db, {
      projectHash,
      actor: 'test-operator',
      policyVersion: 'v1',
      expectedLifecycleVersion: 0,
      now: new Date('2026-08-31T00:00:00.000Z')
    });
    await new FacetRepository(db).assign({
      targetType: 'event',
      targetId: appended.eventId,
      dimension: 'retention',
      value: 'keep',
      confidence: 1,
      source: 'manual',
      projectHash,
      evidenceEventIds: [appended.eventId]
    });
    const result = await applyRetentionLifecycle(db, {
      projectHash,
      actor: 'test-operator',
      policyVersion: 'v1',
      expectedLifecycleVersion: 1,
      now: new Date('2026-08-31T00:00:00.000Z')
    });
    const score = sqliteGet<{ decision: string }>(db, 'SELECT decision FROM memory_retention_scores WHERE target_id = ?', [appended.eventId]);
    expect(result.written).toBe(1);
    expect(score?.decision).toBe('keep');
    expect(Number(sqliteGet<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM events')?.count)).toBe(1);
    await store.close();
  });

  it('rejects a partially numeric persisted lifecycle version', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-retention-lifecycle-invalid-version-'));
    roots.push(root);
    const projectHash = hashProjectPath(path.join(root, 'project'));
    const store = new SQLiteEventStore(path.join(root, 'events.sqlite'));
    await store.initialize();
    const db = store.getDatabase();
    sqliteExec(db, `
      INSERT INTO endless_config (key, value, updated_at)
      VALUES ('retention_lifecycle_version:${projectHash}', '1garbage', CURRENT_TIMESTAMP)
    `);

    await expect(applyRetentionLifecycle(db, {
      projectHash,
      actor: 'test-operator',
      policyVersion: 'v1',
      expectedLifecycleVersion: 1
    })).rejects.toThrow(/stored retention lifecycle version is invalid/);
    await store.close();
  });
});
