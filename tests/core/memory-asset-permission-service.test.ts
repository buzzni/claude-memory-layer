import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryAssetPermissionService } from '../../src/core/operations/memory-asset-permission-service.js';
import { MemoryAssetPermissionDeniedError } from '../../src/core/operations/memory-asset-permissions.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteAll, sqliteGet, sqliteRun } from '../../src/core/sqlite-wrapper.js';

const tempDirs: string[] = [];

async function createFixture(): Promise<{ store: SQLiteEventStore; service: MemoryAssetPermissionService }> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-memory-asset-permissions-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  return { store, service: new MemoryAssetPermissionService(store.getDatabase()) };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('MemoryAssetPermissionService', () => {
  it('creates a private owner asset and hides it from unauthorized reads and lists', async () => {
    const { store, service } = await createFixture();
    try {
      const created = await service.create({
        projectHash: 'project-1',
        requesterActorId: 'owner',
        assetType: 'lesson',
        title: 'Safe deployment order',
        sourceRefs: ['lesson-1']
      });

      expect(created).toMatchObject({ ownerActorId: 'owner', visibility: 'private', version: 1 });
      expect(await service.get({ projectHash: 'project-1', assetId: created.assetId, requesterActorId: 'stranger' })).toBeNull();
      expect(await service.list({ projectHash: 'project-1', requesterActorId: 'stranger' })).toEqual([]);
      expect(await service.list({ projectHash: 'project-1', requesterActorId: 'owner' })).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it('grants exact capabilities and supports audited empty-set revocation', async () => {
    const { store, service } = await createFixture();
    try {
      const asset = await service.create({
        projectHash: 'project-1',
        requesterActorId: 'owner',
        assetType: 'memory',
        title: 'Private memory'
      });
      await service.setGrant({
        projectHash: 'project-1',
        requesterActorId: 'owner',
        assetId: asset.assetId,
        actorId: 'editor',
        permissions: ['read', 'write']
      });

      expect(service.check({
        projectHash: 'project-1', assetId: asset.assetId, requesterActorId: 'editor', permission: 'write'
      }).decision).toMatchObject({ allowed: true, source: 'grant' });
      const updated = await service.update({
        projectHash: 'project-1',
        requesterActorId: 'editor',
        assetId: asset.assetId,
        expectedVersion: 1,
        title: 'Edited memory'
      });
      expect(updated).toMatchObject({ title: 'Edited memory', version: 2 });

      await service.setGrant({
        projectHash: 'project-1',
        requesterActorId: 'owner',
        assetId: asset.assetId,
        actorId: 'editor',
        permissions: []
      });
      expect(service.check({
        projectHash: 'project-1', assetId: asset.assetId, requesterActorId: 'editor', permission: 'read'
      }).decision.allowed).toBe(false);

      const audit = sqliteAll<{ operation: string }>(
        store.getDatabase(),
        `SELECT operation FROM memory_governance_audit WHERE target_id LIKE ? ORDER BY created_at`,
        [`${asset.assetId}%`]
      );
      expect(audit.map((row) => row.operation)).toEqual([
        'memory_asset_create',
        'memory_asset_grant_set',
        'memory_asset_update',
        'memory_asset_grant_set'
      ]);
    } finally {
      await store.close();
    }
  });

  it('uses bindings for private read access without granting write access', async () => {
    const { store, service } = await createFixture();
    try {
      const asset = await service.create({
        projectHash: 'project-1', requesterActorId: 'owner', assetType: 'wiki', title: 'Runbook'
      });
      await service.bind({
        projectHash: 'project-1', requesterActorId: 'owner', assetId: asset.assetId, actorId: 'agent-a'
      });
      expect(await service.get({
        projectHash: 'project-1', assetId: asset.assetId, requesterActorId: 'agent-a'
      })).toMatchObject({ assetId: asset.assetId });
      await expect(service.update({
        projectHash: 'project-1', requesterActorId: 'agent-a', assetId: asset.assetId, title: 'Nope'
      })).rejects.toBeInstanceOf(MemoryAssetPermissionDeniedError);

      await service.bind({
        projectHash: 'project-1', requesterActorId: 'owner', assetId: asset.assetId, actorId: 'agent-a', enabled: false
      });
      expect(await service.get({
        projectHash: 'project-1', assetId: asset.assetId, requesterActorId: 'agent-a'
      })).toBeNull();
    } finally {
      await store.close();
    }
  });

  it('rejects stale versions and unauthorized grant delegation', async () => {
    const { store, service } = await createFixture();
    try {
      const asset = await service.create({
        projectHash: 'project-1', requesterActorId: 'owner', assetType: 'code_graph', title: 'Graph'
      });
      await expect(service.update({
        projectHash: 'project-1', requesterActorId: 'owner', assetId: asset.assetId, expectedVersion: 99, title: 'Stale'
      })).rejects.toThrow('version conflict');
      await expect(service.setGrant({
        projectHash: 'project-1', requesterActorId: 'stranger', assetId: asset.assetId, actorId: 'editor', permissions: ['read']
      })).rejects.toBeInstanceOf(MemoryAssetPermissionDeniedError);
    } finally {
      await store.close();
    }
  });

  it('allows the same external asset id in different project scopes without leakage', async () => {
    const { store, service } = await createFixture();
    try {
      await service.create({
        projectHash: 'project-1', requesterActorId: 'owner-1', assetId: 'lesson:release', assetType: 'lesson', title: 'Project one'
      });
      await service.create({
        projectHash: 'project-2', requesterActorId: 'owner-2', assetId: 'lesson:release', assetType: 'lesson', title: 'Project two'
      });

      expect(await service.get({
        projectHash: 'project-1', requesterActorId: 'owner-1', assetId: 'lesson:release'
      })).toMatchObject({ title: 'Project one' });
      expect(await service.get({
        projectHash: 'project-2', requesterActorId: 'owner-2', assetId: 'lesson:release'
      })).toMatchObject({ title: 'Project two' });
      expect(await service.get({
        projectHash: 'project-2', requesterActorId: 'owner-1', assetId: 'lesson:release'
      })).toBeNull();
    } finally {
      await store.close();
    }
  });

  it('does not reveal whether a denied asset exists through permission checks', async () => {
    const { store, service } = await createFixture();
    try {
      const asset = await service.create({
        projectHash: 'project-1', requesterActorId: 'owner', assetId: 'private-asset', assetType: 'memory', title: 'Private'
      });
      const denied = service.check({
        projectHash: 'project-1', requesterActorId: 'stranger', assetId: asset.assetId, permission: 'read'
      });
      const missing = service.check({
        projectHash: 'project-1', requesterActorId: 'stranger', assetId: 'missing-asset', permission: 'read'
      });

      expect(denied).toEqual(missing);
      expect(denied.asset).toBeUndefined();
      expect(denied.decision).toMatchObject({ allowed: false, source: 'none', reason: 'permission denied' });
    } finally {
      await store.close();
    }
  });

  it('continues paging until list reaches readable assets behind private rows', async () => {
    const { store, service } = await createFixture();
    try {
      await service.create({
        projectHash: 'project-1', requesterActorId: 'owner', assetId: 'zz-readable', assetType: 'memory',
        title: 'Readable', visibility: 'project'
      });
      for (let index = 0; index < 101; index++) {
        await service.create({
          projectHash: 'project-1', requesterActorId: 'other-owner',
          assetId: `private-${String(index).padStart(3, '0')}`, assetType: 'memory', title: `Private ${index}`
        });
      }
      sqliteRun(store.getDatabase(), `UPDATE memory_assets SET updated_at = ? WHERE project_hash = ? AND asset_id = ?`, [
        '2026-01-01T00:00:00.000Z', 'project-1', 'zz-readable'
      ]);
      sqliteRun(store.getDatabase(), `UPDATE memory_assets SET updated_at = ? WHERE project_hash = ? AND asset_id LIKE 'private-%'`, [
        '2026-02-01T00:00:00.000Z', 'project-1'
      ]);

      const listed = await service.list({ projectHash: 'project-1', requesterActorId: 'viewer', limit: 1 });
      expect(listed).toHaveLength(1);
      expect(listed[0].assetId).toBe('zz-readable');
    } finally {
      await store.close();
    }
  });

  it('rolls back an asset mutation when its governance audit cannot be written', async () => {
    const { store, service } = await createFixture();
    try {
      sqliteRun(store.getDatabase(), 'DROP TABLE memory_governance_audit');
      await expect(service.create({
        projectHash: 'project-1', requesterActorId: 'owner', assetId: 'must-rollback', assetType: 'memory', title: 'Rollback'
      })).rejects.toThrow(/memory_governance_audit/);

      const row = sqliteGet<{ count: number }>(
        store.getDatabase(),
        `SELECT COUNT(*) AS count FROM memory_assets WHERE project_hash = ? AND asset_id = ?`,
        ['project-1', 'must-rollback']
      );
      expect(row?.count).toBe(0);
    } finally {
      await store.close();
    }
  });
});
