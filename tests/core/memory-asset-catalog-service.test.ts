import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MemoryAssetCatalogService,
  canonicalMemoryAssetId
} from '../../src/core/operations/memory-asset-catalog-service.js';
import { MemoryAssetPermissionService } from '../../src/core/operations/memory-asset-permission-service.js';
import { CoreMemoryBlockRepository } from '../../src/core/operations/core-memory-block-repository.js';
import { LessonRepository } from '../../src/core/operations/lesson-repository.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteAll, sqliteGet } from '../../src/core/sqlite-wrapper.js';

const tempDirs: string[] = [];

async function createFixture(): Promise<{
  store: SQLiteEventStore;
  catalog: MemoryAssetCatalogService;
  lessons: LessonRepository;
  blocks: CoreMemoryBlockRepository;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-memory-asset-catalog-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  const db = store.getDatabase();
  return {
    store,
    catalog: new MemoryAssetCatalogService(db),
    lessons: new LessonRepository(db),
    blocks: new CoreMemoryBlockRepository(db)
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('MemoryAssetCatalogService', () => {
  it('previews and idempotently registers canonical lessons and core blocks without copying content', async () => {
    const { store, catalog, lessons, blocks } = await createFixture();
    try {
      const lesson = await lessons.upsert({
        projectHash: 'project-1',
        name: 'Release workflow',
        trigger: 'when releasing',
        steps: ['run tests'],
        sourceEventIds: ['event-lesson'],
        actor: 'curator'
      });
      await blocks.upsert({
        projectHash: 'project-1',
        blockKey: 'project',
        content: 'Private canonical core-memory content',
        sourceEventIds: ['event-project-block'],
        updatedBy: 'curator'
      });
      await blocks.upsert({
        projectHash: 'project-1',
        blockKey: 'user',
        content: '',
        sourceEventIds: [],
        updatedBy: 'curator'
      });

      const preview = await catalog.sync({
        projectHash: 'project-1', requesterActorId: 'catalog-owner', apply: false, limit: 100
      });
      expect(preview).toMatchObject({
        dryRun: true,
        totalCandidates: 3,
        scanned: 3,
        truncated: false,
        planned: 3,
        created: 0,
        existing: 0,
        conflicts: 0
      });
      expect(sqliteGet<{ count: number }>(store.getDatabase(), `SELECT COUNT(*) AS count FROM memory_assets`)?.count).toBe(0);

      const applied = await catalog.sync({
        projectHash: 'project-1', requesterActorId: 'catalog-owner', apply: true, limit: 100
      });
      expect(applied).toMatchObject({ dryRun: false, planned: 3, created: 3, existing: 0, conflicts: 0 });

      const assetRows = sqliteAll<{
        asset_id: string;
        asset_type: string;
        title: string;
        owner_actor_id: string;
        status: string;
        visibility: string;
        source_refs_json: string;
        metadata_json: string;
      }>(store.getDatabase(), `SELECT * FROM memory_assets WHERE project_hash = ? ORDER BY asset_id`, ['project-1']);
      expect(assetRows).toHaveLength(3);
      expect(assetRows.map((row) => row.asset_id)).toEqual([
        'core_memory_block:project',
        'core_memory_block:user',
        canonicalMemoryAssetId('lesson', lesson.lessonId)
      ]);
      expect(assetRows.every((row) => row.owner_actor_id === 'catalog-owner')).toBe(true);
      expect(assetRows.every((row) => row.visibility === 'private')).toBe(true);
      expect(assetRows.find((row) => row.asset_id === 'core_memory_block:user')?.status).toBe('archived');
      expect(assetRows.find((row) => row.asset_id === 'core_memory_block:project')?.title).toBe('Core memory: project');
      expect(JSON.stringify(assetRows)).not.toContain('Private canonical core-memory content');
      expect(JSON.parse(assetRows.find((row) => row.asset_id.startsWith('lesson:'))!.source_refs_json)).toEqual([
        canonicalMemoryAssetId('lesson', lesson.lessonId)
      ]);

      const canonicalBlock = await blocks.get({ projectHash: 'project-1', blockKey: 'project' });
      expect(canonicalBlock?.content).toBe('Private canonical core-memory content');

      const rerun = await catalog.sync({
        projectHash: 'project-1', requesterActorId: 'different-caller', apply: true, limit: 100
      });
      expect(rerun).toMatchObject({ planned: 0, created: 0, existing: 3, conflicts: 0 });
      expect(rerun.items.every((item) => !('asset' in item))).toBe(true);

      const assetAudits = sqliteAll<{ operation: string }>(
        store.getDatabase(),
        `SELECT operation FROM memory_governance_audit WHERE operation = 'memory_asset_create'`
      );
      expect(assetAudits).toHaveLength(3);
    } finally {
      await store.close();
    }
  });

  it('reports deterministic-id conflicts without overwriting an existing asset', async () => {
    const { store, catalog, lessons } = await createFixture();
    try {
      const lesson = await lessons.upsert({
        projectHash: 'project-1',
        name: 'Conflicting lesson',
        trigger: 'when conflict testing',
        steps: ['do not overwrite'],
        sourceEventIds: ['event-conflict']
      });
      const assetId = canonicalMemoryAssetId('lesson', lesson.lessonId);
      const permissions = new MemoryAssetPermissionService(store.getDatabase());
      await permissions.create({
        projectHash: 'project-1',
        requesterActorId: 'existing-owner',
        assetId,
        assetType: 'wiki',
        title: 'Existing unrelated asset',
        sourceRefs: ['wiki:unrelated']
      });

      const result = await catalog.sync({
        projectHash: 'project-1', requesterActorId: 'catalog-owner', apply: true
      });
      expect(result).toMatchObject({ planned: 0, created: 0, existing: 0, conflicts: 1 });
      expect(result.items[0]).toMatchObject({ action: 'conflict' });

      const unchanged = await permissions.get({
        projectHash: 'project-1', requesterActorId: 'existing-owner', assetId
      });
      expect(unchanged).toMatchObject({ assetType: 'wiki', title: 'Existing unrelated asset' });
    } finally {
      await store.close();
    }
  });

  it('keeps project scopes isolated and reports bounded scans as truncated', async () => {
    const { store, catalog, lessons } = await createFixture();
    try {
      await lessons.upsert({
        projectHash: 'project-1', name: 'One', trigger: 'one', steps: ['one'], sourceEventIds: ['event-1']
      });
      await lessons.upsert({
        projectHash: 'project-1', name: 'Two', trigger: 'two', steps: ['two'], sourceEventIds: ['event-2']
      });
      await lessons.upsert({
        projectHash: 'project-2', name: 'Other project', trigger: 'other', steps: ['other'], sourceEventIds: ['event-3']
      });

      const result = await catalog.sync({
        projectHash: 'project-1', requesterActorId: 'owner', apply: false, limit: 1
      });
      expect(result).toMatchObject({ totalCandidates: 2, scanned: 1, truncated: true, planned: 1 });
      expect(result.items[0].candidate.title).not.toBe('Other project');
    } finally {
      await store.close();
    }
  });
});
