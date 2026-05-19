import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { ActionRepository } from '../../src/core/operations/action-repository.js';
import { TaskActionProjector } from '../../src/core/operations/action-projector.js';
import { sqliteAll, sqliteRun } from '../../src/core/sqlite-wrapper.js';

const tempDirs: string[] = [];

interface TaskFixtureInput {
  entityId: string;
  title: string;
  currentJson: Record<string, unknown>;
  entityType?: 'task' | 'condition' | 'artifact';
  status?: 'active' | 'deprecated';
}

async function createFixture(): Promise<{
  store: SQLiteEventStore;
  actions: ActionRepository;
  projector: TaskActionProjector;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-action-projector-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  const actions = new ActionRepository(store.getDatabase());
  const projector = new TaskActionProjector(store.getDatabase(), actions);
  return { store, actions, projector, cleanup: async () => store.close() };
}

function insertEntity(store: SQLiteEventStore, input: TaskFixtureInput): void {
  const now = new Date('2026-05-19T00:00:00Z').toISOString();
  sqliteRun(
    store.getDatabase(),
    `INSERT INTO entities (
      entity_id, entity_type, canonical_key, title, stage, status,
      current_json, title_norm, search_text, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.entityId,
      input.entityType ?? 'task',
      `${input.entityType ?? 'task'}:${input.entityId}`,
      input.title,
      'verified',
      input.status ?? 'active',
      JSON.stringify(input.currentJson),
      input.title.toLowerCase(),
      `${input.title} ${JSON.stringify(input.currentJson)}`,
      now,
      now
    ]
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('TaskActionProjector', () => {
  it('projects matching task entities into idempotent project-scoped actions with source evidence', async () => {
    const { store, actions, projector, cleanup } = await createFixture();
    const append = await store.append({
      eventType: 'user_prompt',
      sessionId: 'session-1',
      timestamp: new Date('2026-05-19T00:00:00Z'),
      content: 'please ship task action projector'
    });
    if (!append.success) throw new Error('append failed');
    const sourceEventId = append.eventId;
    const ignoredSourceRef = 'not-an-event-id';

    insertEntity(store, {
      entityId: 'task-projector',
      title: 'Ship task action projector',
      currentJson: {
        status: 'blocked',
        priority: 'critical',
        project: 'project-a',
        sourceEventIds: [sourceEventId, ignoredSourceRef]
      }
    });
    insertEntity(store, {
      entityId: 'task-other-project',
      title: 'Other project task',
      currentJson: { status: 'pending', priority: 'critical', project: 'project-b', sourceEventIds: ['other-event'] }
    });
    insertEntity(store, {
      entityId: 'condition-not-action',
      entityType: 'condition',
      title: 'Condition should not become action',
      currentJson: { project: 'project-a' }
    });

    const first = await projector.project({ projectHash: 'hash-a', project: 'project-a', actor: 'tester' });
    const second = await projector.project({ projectHash: 'hash-a', project: 'project-a', actor: 'tester' });
    const projected = await actions.list({ projectHash: 'hash-a', includeTerminal: true });
    const auditRows = sqliteAll<Record<string, unknown>>(
      store.getDatabase(),
      `SELECT operation, target_type FROM memory_governance_audit WHERE operation = 'action_update'`
    );
    await cleanup();

    expect(first).toMatchObject({ scanned: 1, created: 1, updated: 0, unchanged: 0, skipped: 0 });
    expect(second).toMatchObject({ scanned: 1, created: 0, updated: 0, unchanged: 1, skipped: 0 });
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      projectHash: 'hash-a',
      title: 'Ship task action projector',
      status: 'blocked',
      priority: 100,
      sourceEventIds: [sourceEventId],
      relatedEntityIds: ['task-projector']
    });
    expect(auditRows).toHaveLength(1);
  });

  it('updates existing projections and converts task blocker edges into action dependencies', async () => {
    const { store, actions, projector, cleanup } = await createFixture();
    insertEntity(store, {
      entityId: 'task-prerequisite',
      title: 'Finish prerequisite',
      currentJson: { status: 'done', priority: 'low', project: 'project-a' }
    });
    insertEntity(store, {
      entityId: 'task-dependent',
      title: 'Ship dependent work',
      currentJson: { status: 'pending', priority: 'high', project: 'project-a' }
    });
    sqliteRun(
      store.getDatabase(),
      `INSERT INTO edges (edge_id, src_type, src_id, rel_type, dst_type, dst_id, meta_json)
       VALUES (?, 'entity', ?, 'blocked_by', 'entity', ?, ?)`,
      ['edge-dependent-prerequisite', 'task-dependent', 'task-prerequisite', JSON.stringify({ confidence: 0.7 })]
    );

    await projector.project({ projectHash: 'hash-a', project: 'project-a', actor: 'tester' });
    insertEntity(store, {
      entityId: 'task-later',
      title: 'Later irrelevant task',
      currentJson: { status: 'pending', priority: 'medium', project: 'project-b' }
    });
    const dependent = (await actions.list({ projectHash: 'hash-a', includeTerminal: true }))
      .find((action) => action.title === 'Ship dependent work');
    expect(dependent).toBeDefined();

    insertEntity(store, {
      entityId: 'task-dependent-copy-for-update-check',
      title: 'Unused copy',
      currentJson: { status: 'pending', priority: 'low', project: 'project-a' }
    });
    sqliteRun(
      store.getDatabase(),
      `UPDATE entities SET current_json = json_set(current_json, '$.status', 'in_progress', '$.priority', 'critical')
       WHERE entity_id = ?`,
      ['task-dependent']
    );
    const updateResult = await projector.project({ projectHash: 'hash-a', project: 'project-a', actor: 'tester' });
    const updatedDependent = actions.get(dependent!.actionId);
    const edges = sqliteAll<Record<string, unknown>>(
      store.getDatabase(),
      `SELECT rel_type, dst_type, dst_id, confidence FROM memory_action_edges WHERE src_action_id = ?`,
      [dependent!.actionId]
    );
    await cleanup();

    expect(updateResult.updated).toBe(1);
    expect(updatedDependent?.status).toBe('in_progress');
    expect(updatedDependent?.priority).toBe(100);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ rel_type: 'depends_on', dst_type: 'action', confidence: 0.7 });
    expect(String(edges[0].dst_id)).not.toBe('task-prerequisite');
  });

  it('removes stale projected dependency edges and skips malformed task JSON', async () => {
    const { store, actions, projector, cleanup } = await createFixture();
    insertEntity(store, {
      entityId: 'task-blocker',
      title: 'Blocker task',
      currentJson: { status: 'pending', priority: 'medium', project: 'project-a' }
    });
    insertEntity(store, {
      entityId: 'task-unblocked',
      title: 'Task that becomes unblocked',
      currentJson: { status: 'pending', priority: 'medium', project: 'project-a' }
    });
    sqliteRun(
      store.getDatabase(),
      `INSERT INTO entities (
        entity_id, entity_type, canonical_key, title, stage, status,
        current_json, title_norm, search_text, created_at, updated_at
      ) VALUES (?, 'task', ?, ?, 'verified', 'active', ?, ?, ?, ?, ?)`,
      [
        'task-malformed-json',
        'task:malformed',
        'Malformed task JSON',
        '{not-valid-json',
        'malformed task json',
        'Malformed task JSON',
        new Date('2026-05-19T00:00:00Z').toISOString(),
        new Date('2026-05-19T00:00:00Z').toISOString()
      ]
    );
    sqliteRun(
      store.getDatabase(),
      `INSERT INTO edges (edge_id, src_type, src_id, rel_type, dst_type, dst_id, meta_json)
       VALUES (?, 'entity', ?, 'blocked_by', 'entity', ?, ?)`,
      ['edge-stale-blocker', 'task-unblocked', 'task-blocker', JSON.stringify({ confidence: 1 })]
    );

    await projector.project({ projectHash: 'hash-a', project: 'project-a', actor: 'tester' });
    const projectedAction = (await actions.list({ projectHash: 'hash-a', includeTerminal: true }))
      .find((action) => action.title === 'Task that becomes unblocked');
    expect(projectedAction).toBeDefined();
    const blockerAction = (await actions.list({ projectHash: 'hash-a', includeTerminal: true }))
      .find((action) => action.title === 'Blocker task');
    expect(blockerAction).toBeDefined();
    await actions.addEdge({
      srcActionId: projectedAction!.actionId,
      relType: 'depends_on',
      dstType: 'action',
      dstId: blockerAction!.actionId,
      confidence: 0.9
    });
    expect(sqliteAll<Record<string, unknown>>(
      store.getDatabase(),
      `SELECT edge_id FROM memory_action_edges WHERE src_action_id = ?`,
      [projectedAction!.actionId]
    )).toHaveLength(2);

    sqliteRun(store.getDatabase(), `DELETE FROM edges WHERE edge_id = ?`, ['edge-stale-blocker']);
    const result = await projector.project({ projectHash: 'hash-a', project: 'project-a', actor: 'tester' });
    const remainingEdges = sqliteAll<Record<string, unknown>>(
      store.getDatabase(),
      `SELECT dst_id, source FROM memory_action_edges WHERE src_action_id = ?`,
      [projectedAction!.actionId]
    );
    await cleanup();

    expect(result.scanned).toBe(2);
    expect(remainingEdges).toEqual([{ dst_id: blockerAction!.actionId, source: 'manual' }]);
  });

  it('fails closed when no task project scope is provided', async () => {
    const { store, actions, projector, cleanup } = await createFixture();
    insertEntity(store, {
      entityId: 'projectless-task',
      title: 'Projectless task',
      currentJson: { status: 'pending', priority: 'high' }
    });

    const result = await projector.project({ projectHash: 'hash-a', actor: 'tester' });
    const projected = await actions.list({ projectHash: 'hash-a', includeTerminal: true });
    await cleanup();

    expect(result).toMatchObject({ scanned: 0, created: 0, updated: 0, unchanged: 0, skipped: 0 });
    expect(projected).toEqual([]);
  });
});
