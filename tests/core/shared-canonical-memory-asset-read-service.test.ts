import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LessonRepository } from '../../src/core/operations/lesson-repository.js';
import { CoreMemoryBlockRepository } from '../../src/core/operations/core-memory-block-repository.js';
import { MemoryAssetPermissionService } from '../../src/core/operations/memory-asset-permission-service.js';
import { SharedCanonicalMemoryAssetReadService } from '../../src/core/operations/shared-canonical-memory-asset-read-service.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

const tempDirs: string[] = [];

async function createFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cml-shared-canonical-read-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  return {
    store,
    lessons: new LessonRepository(store.getDatabase()),
    blocks: new CoreMemoryBlockRepository(store.getDatabase()),
    permissions: new MemoryAssetPermissionService(store.getDatabase()),
    service: new SharedCanonicalMemoryAssetReadService(store.getDatabase())
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SharedCanonicalMemoryAssetReadService', () => {
  it('returns only active, shared, valid canonical source records', async () => {
    const { store, lessons, permissions, service } = await createFixture();
    try {
      const lesson = await lessons.upsert({
        projectHash: 'source-project', name: 'Shared deploy', trigger: 'deploy', steps: ['verify'], sourceEventIds: ['event-1']
      });
      const assetId = `lesson:${lesson.lessonId}`;
      await permissions.create({
        projectHash: 'source-project', requesterActorId: 'owner', assetId, assetType: 'lesson',
        title: 'Shared deploy', visibility: 'shared', sourceRefs: [assetId]
      });

      await expect(service.get({
        projectHash: 'source-project', actorId: 'source-actor', canonicalType: 'lesson', canonicalId: lesson.lessonId
      })).resolves.toMatchObject({
        asset: { assetId, visibility: 'shared', status: 'active' },
        canonicalType: 'lesson',
        value: { lessonId: lesson.lessonId, steps: ['verify'] }
      });
    } finally {
      await store.close();
    }
  });

  it('fails closed for private, inactive, conflicting, and absent canonical records', async () => {
    const { store, lessons, permissions, service } = await createFixture();
    try {
      const lesson = await lessons.upsert({
        projectHash: 'source-project', name: 'Private deploy', trigger: 'deploy', steps: ['verify'], sourceEventIds: ['event-2']
      });
      const assetId = `lesson:${lesson.lessonId}`;
      await permissions.create({
        projectHash: 'source-project', requesterActorId: 'owner', assetId, assetType: 'lesson',
        title: 'Private deploy', visibility: 'private', sourceRefs: [assetId]
      });
      await expect(service.get({
        projectHash: 'source-project', actorId: 'owner', canonicalType: 'lesson', canonicalId: lesson.lessonId
      })).resolves.toBeNull();

      await permissions.update({
        projectHash: 'source-project', requesterActorId: 'owner', assetId, visibility: 'shared', status: 'archived'
      });
      await expect(service.get({
        projectHash: 'source-project', actorId: 'owner', canonicalType: 'lesson', canonicalId: lesson.lessonId
      })).resolves.toBeNull();

      await permissions.create({
        projectHash: 'source-project', requesterActorId: 'owner', assetId: 'lesson:conflict', assetType: 'wiki',
        title: 'Conflict', visibility: 'shared', sourceRefs: ['wiki:other']
      });
      await expect(service.get({
        projectHash: 'source-project', actorId: 'owner', canonicalType: 'lesson', canonicalId: 'conflict'
      })).resolves.toBeNull();
      await expect(service.get({
        projectHash: 'source-project', actorId: 'owner', canonicalType: 'lesson', canonicalId: 'missing'
      })).resolves.toBeNull();
    } finally {
      await store.close();
    }
  });

  it('loads a shared core-memory block only from its registered source project', async () => {
    const { store, blocks, permissions, service } = await createFixture();
    try {
      await blocks.upsert({
        projectHash: 'source-project', blockKey: 'project', content: 'Keep deploys reversible',
        sourceEventIds: ['event-3'], updatedBy: 'owner'
      });
      await permissions.create({
        projectHash: 'source-project', requesterActorId: 'owner', assetId: 'core_memory_block:project',
        assetType: 'memory', title: 'Project core memory', visibility: 'shared',
        sourceRefs: ['core_memory_block:project']
      });

      await expect(service.get({
        projectHash: 'source-project', actorId: 'source-actor', canonicalType: 'core_memory_block', canonicalId: 'project'
      })).resolves.toMatchObject({
        canonicalType: 'core_memory_block', value: { content: 'Keep deploys reversible' }
      });
      await expect(service.get({
        projectHash: 'another-project', actorId: 'source-actor', canonicalType: 'core_memory_block', canonicalId: 'project'
      })).resolves.toBeNull();
    } finally {
      await store.close();
    }
  });
});
