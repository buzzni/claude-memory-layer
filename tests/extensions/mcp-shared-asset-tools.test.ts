import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/core/registry/project-path.js', () => ({
  hashProjectPath: (projectPath: string) => projectPath.endsWith('/source') ? 'source-project' : 'destination-project',
  getProjectStoragePath: (projectPath: string) => `${projectPath}/.cml-memory`
}));

import { LessonRepository } from '../../src/core/operations/lesson-repository.js';
import { MemoryAssetPermissionService } from '../../src/core/operations/memory-asset-permission-service.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { SHARED_MEMORY_STORAGE_PATH_ENV } from '../../src/services/memory-service-config.js';
import { handleToolCall } from '../../src/extensions/mcp/handlers.js';

const tempDirs: string[] = [];
const originalSharedPath = process.env[SHARED_MEMORY_STORAGE_PATH_ENV];

function textOf(result: Awaited<ReturnType<typeof handleToolCall>>): string {
  return String(result.content[0]?.text ?? '');
}

function jsonOf(result: Awaited<ReturnType<typeof handleToolCall>>): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

afterEach(() => {
  if (originalSharedPath === undefined) delete process.env[SHARED_MEMORY_STORAGE_PATH_ENV];
  else process.env[SHARED_MEMORY_STORAGE_PATH_ENV] = originalSharedPath;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('MCP shared canonical asset reads', () => {
  it('requires identity mapping and source shared state before returning a lesson', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cml-mcp-shared-asset-'));
    tempDirs.push(root);
    const destinationProjectPath = join(root, 'destination');
    const sourceProjectPath = join(root, 'source');
    const sharedStorePath = join(root, 'shared');
    process.env[SHARED_MEMORY_STORAGE_PATH_ENV] = sharedStorePath;

    const sourceStore = new SQLiteEventStore(join(sourceProjectPath, '.cml-memory', 'events.sqlite'));
    await sourceStore.initialize();
    try {
      const lessons = new LessonRepository(sourceStore.getDatabase());
      const permissions = new MemoryAssetPermissionService(sourceStore.getDatabase());
      const lesson = await lessons.upsert({
        projectHash: 'source-project',
        name: 'Shared deploy order', trigger: 'deployment', steps: ['verify first'], sourceEventIds: ['event-1']
      });
      const assetId = `lesson:${lesson.lessonId}`;
      await permissions.create({
        projectHash: lesson.projectHash!, requesterActorId: 'source-owner', assetId, assetType: 'lesson',
        title: lesson.name, visibility: 'shared', sourceRefs: [assetId]
      });

      await handleToolCall('mem-shared-actor-link', {
        projectPath: destinationProjectPath, requesterActorId: 'destination-actor', sharedPrincipalId: 'principal-a'
      });
      await handleToolCall('mem-shared-actor-link', {
        projectPath: sourceProjectPath, requesterActorId: 'source-actor', sharedPrincipalId: 'principal-a'
      });

      const allowed = jsonOf(await handleToolCall('mem-shared-asset-get', {
        projectPath: destinationProjectPath,
        requesterActorId: 'destination-actor',
        sourceProjectPath,
        sourceActorId: 'source-actor',
        canonicalType: 'lesson',
        canonicalId: lesson.lessonId
      }));
      expect(allowed).toMatchObject({
        operation: 'mem-shared-asset-get', found: true,
        asset: { asset: { assetId, visibility: 'shared' }, canonical: { lessonId: lesson.lessonId } }
      });

      const wrongActor = jsonOf(await handleToolCall('mem-shared-asset-get', {
        projectPath: destinationProjectPath,
        requesterActorId: 'destination-actor',
        sourceProjectPath,
        sourceActorId: 'other-source-actor',
        canonicalType: 'lesson',
        canonicalId: lesson.lessonId
      }));
      expect(wrongActor).toEqual(expect.objectContaining({ found: false }));

      await permissions.update({
        projectHash: lesson.projectHash!, requesterActorId: 'source-owner', assetId, visibility: 'private'
      });
      const privateAsset = jsonOf(await handleToolCall('mem-shared-asset-get', {
        projectPath: destinationProjectPath,
        requesterActorId: 'destination-actor',
        sourceProjectPath,
        sourceActorId: 'source-actor',
        canonicalType: 'lesson',
        canonicalId: lesson.lessonId
      }));
      expect(privateAsset).toEqual(expect.objectContaining({ found: false }));
    } finally {
      await sourceStore.close();
    }
  });
});
