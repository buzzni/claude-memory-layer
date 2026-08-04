import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { EntityRepo } from '../../src/core/entity-repo.js';
import { EdgeRepo } from '../../src/core/edge-repo.js';
import { sqliteAll } from '../../src/core/sqlite-wrapper.js';

const tempDirs: string[] = [];

async function createFixture(): Promise<{ store: SQLiteEventStore; entities: EntityRepo; edges: EdgeRepo }> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-entity-repo-supersede-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  return { store, entities: new EntityRepo(store.getDatabase()), edges: new EdgeRepo(store.getDatabase()) };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('EntityRepo.supersede', () => {
  it('marks the old entity superseded and links a supersedes edge from the new one', async () => {
    const { store, entities, edges } = await createFixture();
    try {
      const oldEntity = await entities.create({
        entityType: 'condition',
        title: 'Deploys go through Jenkins',
        currentJson: {}
      });
      const newEntity = await entities.create({
        entityType: 'condition',
        title: 'Deploys go through GitHub Actions',
        currentJson: {}
      });

      const result = await entities.supersede(oldEntity.entityId, newEntity.entityId, {
        actor: 'agent-a',
        sourceEventIds: ['event-1']
      });

      expect(result.old.status).toBe('superseded');
      expect(result.new.status).toBe('active');

      const refreshedOld = await entities.findById(oldEntity.entityId);
      expect(refreshedOld?.status).toBe('superseded');

      const { incoming } = await edges.findByNode(oldEntity.entityId);
      const supersedeEdge = incoming.find((edge) => edge.relType === 'supersedes');
      expect(supersedeEdge).toMatchObject({
        srcType: 'entity',
        srcId: newEntity.entityId,
        dstType: 'entity',
        dstId: oldEntity.entityId
      });
    } finally {
      await store.close();
    }
  });

  it('writes a governance audit entry with before/after status snapshots', async () => {
    const { store, entities } = await createFixture();
    try {
      const oldEntity = await entities.create({ entityType: 'condition', title: 'Old fact', currentJson: {} });
      const newEntity = await entities.create({ entityType: 'condition', title: 'New fact', currentJson: {} });

      await entities.supersede(oldEntity.entityId, newEntity.entityId, {
        actor: 'agent-a',
        sourceEventIds: ['event-1']
      });

      const rows = sqliteAll<{ operation: string; actor: string; target_id: string; before_json: string; after_json: string }>(
        store.getDatabase(),
        `SELECT operation, actor, target_id, before_json, after_json FROM memory_governance_audit
         WHERE target_type = 'entity' AND operation = 'entity_supersede'`
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].actor).toBe('agent-a');
      expect(rows[0].target_id).toBe(oldEntity.entityId);
      expect(JSON.parse(rows[0].before_json)).toMatchObject({ status: 'active' });
      expect(JSON.parse(rows[0].after_json)).toMatchObject({ status: 'superseded', supersededBy: newEntity.entityId });
    } finally {
      await store.close();
    }
  });

  it('is idempotent (NOOP) when repeating the exact same supersession', async () => {
    const { store, entities } = await createFixture();
    try {
      const oldEntity = await entities.create({ entityType: 'condition', title: 'Old fact', currentJson: {} });
      const newEntity = await entities.create({ entityType: 'condition', title: 'New fact', currentJson: {} });

      const first = await entities.supersede(oldEntity.entityId, newEntity.entityId, { actor: 'agent-a' });
      const second = await entities.supersede(oldEntity.entityId, newEntity.entityId, { actor: 'agent-b' });

      expect(first.alreadySuperseded).toBe(false);
      expect(second.alreadySuperseded).toBe(true);

      const rows = sqliteAll<{ operation: string }>(
        store.getDatabase(),
        `SELECT operation FROM memory_governance_audit WHERE target_type = 'entity' AND operation = 'entity_supersede'`
      );
      // Repeat of the same supersession is a NOOP: no duplicate audit entry.
      expect(rows).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it('throws instead of silently ignoring a conflicting supersession by a different entity', async () => {
    const { store, entities } = await createFixture();
    try {
      const oldEntity = await entities.create({ entityType: 'condition', title: 'Old fact', currentJson: {} });
      const newEntity = await entities.create({ entityType: 'condition', title: 'New fact', currentJson: {} });
      const newerEntity = await entities.create({ entityType: 'condition', title: 'Newer fact', currentJson: {} });

      await entities.supersede(oldEntity.entityId, newEntity.entityId, { actor: 'agent-a' });

      await expect(entities.supersede(oldEntity.entityId, newerEntity.entityId, { actor: 'agent-b' }))
        .rejects.toThrow(/already superseded by/);

      const rows = sqliteAll<{ operation: string }>(
        store.getDatabase(),
        `SELECT operation FROM memory_governance_audit WHERE target_type = 'entity' AND operation = 'entity_supersede'`
      );
      expect(rows).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it('writes the supersedes edge before flipping status, so a half-applied supersession stays retryable', async () => {
    const { store, entities, edges } = await createFixture();
    try {
      const oldEntity = await entities.create({ entityType: 'condition', title: 'Old fact', currentJson: {} });
      const newEntity = await entities.create({ entityType: 'condition', title: 'New fact', currentJson: {} });

      // Simulate the crash window: the edge landed but the status flip did not.
      await edges.upsert({
        srcType: 'entity', srcId: newEntity.entityId, relType: 'supersedes',
        dstType: 'entity', dstId: oldEntity.entityId, metaJson: { actor: 'agent-a' }
      });

      // A retry must complete the supersession rather than treating it as done.
      const retried = await entities.supersede(oldEntity.entityId, newEntity.entityId, { actor: 'agent-a' });
      expect(retried.alreadySuperseded).toBe(false);
      expect(retried.old.status).toBe('superseded');
    } finally {
      await store.close();
    }
  });

  it('throws when either entity id does not exist', async () => {
    const { store, entities } = await createFixture();
    try {
      const existing = await entities.create({ entityType: 'condition', title: 'Exists', currentJson: {} });
      await expect(entities.supersede('missing-old', existing.entityId, { actor: 'agent-a' }))
        .rejects.toThrow(/entity not found/);
      await expect(entities.supersede(existing.entityId, 'missing-new', { actor: 'agent-a' }))
        .rejects.toThrow(/entity not found/);
    } finally {
      await store.close();
    }
  });
});
