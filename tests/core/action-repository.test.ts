import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { ActionRepository } from '../../src/core/operations/action-repository.js';
import { sqliteAll, sqliteGet } from '../../src/core/sqlite-wrapper.js';

const tempDirs: string[] = [];

async function createFixture(): Promise<{ store: SQLiteEventStore; repo: ActionRepository; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-action-repo-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  return { store, repo: new ActionRepository(store.getDatabase()), cleanup: async () => store.close() };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ActionRepository', () => {
  it('creates and updates project-scoped actions with source event evidence and audit rows', async () => {
    const { store, repo, cleanup } = await createFixture();
    const append = await store.append({
      eventType: 'user_prompt',
      sessionId: 'session-1',
      timestamp: new Date('2026-05-19T00:00:00Z'),
      content: 'please ship the action repository'
    });
    expect(append.success).toBe(true);
    const sourceEventId = append.eventId!;

    const action = await repo.upsert({
      projectHash: 'project-1',
      title: 'Ship action repository',
      priority: 7,
      sourceEventIds: [sourceEventId],
      relatedEntityIds: ['entity-1'],
      actor: 'tester'
    });
    const updated = await repo.update({
      actionId: action.actionId,
      projectHash: 'project-1',
      status: 'in_progress',
      priority: 9,
      actor: 'tester',
      sourceEventIds: [sourceEventId]
    });

    const event = await store.getEvent(sourceEventId);
    const auditRows = sqliteAll<Record<string, unknown>>(
      store.getDatabase(),
      `SELECT operation, target_type, target_id, before_json, after_json, source_event_ids
       FROM memory_governance_audit WHERE target_type = 'action' ORDER BY created_at ASC`
    );
    await cleanup();

    expect(action.status).toBe('pending');
    expect(action.sourceEventIds).toEqual([sourceEventId]);
    expect(action.relatedEntityIds).toEqual(['entity-1']);
    expect(updated.status).toBe('in_progress');
    expect(updated.priority).toBe(9);
    expect(event?.content).toBe('please ship the action repository');
    expect(auditRows).toHaveLength(2);
    expect(auditRows.map((row) => row.operation)).toEqual(['action_update', 'action_update']);
    expect(auditRows[0].target_id).toBe(action.actionId);
    expect(auditRows[0].before_json).toBeNull();
    expect(JSON.parse(String(auditRows[1].before_json)).status).toBe('pending');
    expect(JSON.parse(String(auditRows[1].after_json)).status).toBe('in_progress');
    expect(JSON.parse(String(auditRows[1].source_event_ids))).toEqual([sourceEventId]);
  });

  it('records sanitized update notes in governance audit metadata without changing the action projection', async () => {
    const { store, repo, cleanup } = await createFixture();
    const action = await repo.upsert({ projectHash: 'project-1', title: 'Document handler notes', actor: 'tester' });

    const updated = await repo.update({
      actionId: action.actionId,
      projectHash: 'project-1',
      status: 'done',
      actor: 'tester',
      note: 'Validated from /tmp/private-plan.md with api_key=dk'
    });

    const auditRows = sqliteAll<Record<string, unknown>>(
      store.getDatabase(),
      `SELECT after_json FROM memory_governance_audit WHERE target_type = 'action' ORDER BY created_at ASC`
    );
    await cleanup();

    const updateAfterJson = JSON.parse(String(auditRows[1].after_json));
    expect(updated.status).toBe('done');
    expect(updated).not.toHaveProperty('note');
    expect(updateAfterJson.note).toContain('[REDACTED]');
    expect(updateAfterJson.note).not.toContain('/tmp/private-plan.md');
    expect(updateAfterJson.note).not.toContain('api_key=dk');
  });

  it('lists actions by project without leaking other project rows or terminal rows by default', async () => {
    const { repo, cleanup } = await createFixture();
    await repo.upsert({ projectHash: 'project-1', title: 'Open action', priority: 1 });
    await repo.upsert({ projectHash: 'project-1', title: 'Done action', status: 'done', priority: 10 });
    await repo.upsert({ projectHash: 'project-2', title: 'Other action', priority: 99 });

    const defaultList = await repo.list({ projectHash: 'project-1' });
    const includeTerminal = await repo.list({ projectHash: 'project-1', includeTerminal: true });
    await cleanup();

    expect(defaultList.map((action) => action.title)).toEqual(['Open action']);
    expect(includeTerminal.map((action) => action.title)).toEqual(['Done action', 'Open action']);
  });

  it('rejects direct update when an existing action id belongs to another project', async () => {
    const { repo, cleanup } = await createFixture();
    const action = await repo.upsert({ projectHash: 'project-1', title: 'Scoped action', priority: 2 });

    await expect(repo.update({
      actionId: action.actionId,
      projectHash: 'project-2',
      status: 'done'
    })).rejects.toThrow(/projectHash/);

    const unchanged = repo.get(action.actionId);
    await cleanup();

    expect(unchanged?.projectHash).toBe('project-1');
    expect(unchanged?.status).toBe('pending');
    expect(unchanged?.priority).toBe(2);
  });

  it('rejects upsert when an existing action id belongs to another project', async () => {
    const { repo, cleanup } = await createFixture();
    const action = await repo.upsert({ projectHash: 'project-1', title: 'Project one action', priority: 1 });

    await expect(repo.upsert({
      actionId: action.actionId,
      projectHash: 'project-2',
      title: 'Cross-project mutation',
      status: 'done',
      priority: 100
    })).rejects.toThrow(/projectHash/);

    const unchanged = repo.get(action.actionId);
    await cleanup();

    expect(unchanged?.projectHash).toBe('project-1');
    expect(unchanged?.title).toBe('Project one action');
    expect(unchanged?.status).toBe('pending');
    expect(unchanged?.priority).toBe(1);
  });

  it('stores action edges idempotently for dependencies and references', async () => {
    const { store, repo, cleanup } = await createFixture();
    const action = await repo.upsert({ projectHash: 'project-1', title: 'Blocked action' });

    const first = await repo.addEdge({
      srcActionId: action.actionId,
      relType: 'depends_on',
      dstType: 'event',
      dstId: 'event-1',
      confidence: 0.8
    });
    const second = await repo.addEdge({
      srcActionId: action.actionId,
      relType: 'depends_on',
      dstType: 'event',
      dstId: 'event-1',
      confidence: 0.6
    });
    const rows = sqliteAll<Record<string, unknown>>(store.getDatabase(), `SELECT * FROM memory_action_edges`);
    await cleanup();

    expect(second.edgeId).toBe(first.edgeId);
    expect(second.confidence).toBe(0.6);
    expect(second.source).toBe('manual');
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('manual');
  });

  it('rejects invalid action status without writing projection rows', async () => {
    const { store, repo, cleanup } = await createFixture();
    await expect(repo.upsert({ projectHash: 'project-1', title: 'Bad action', status: 'waiting' })).rejects.toThrow();
    const row = sqliteGet<Record<string, unknown>>(store.getDatabase(), `SELECT * FROM memory_actions`);
    await cleanup();
    expect(row).toBeUndefined();
  });
});
