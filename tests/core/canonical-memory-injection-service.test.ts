import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CANONICAL_MEMORY_ACTOR_ID_ENV,
  CanonicalMemoryInjectionService,
  resolveCanonicalMemoryActorId
} from '../../src/core/operations/canonical-memory-injection-service.js';
import { MemoryAssetPermissionService } from '../../src/core/operations/memory-asset-permission-service.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

const tempDirs: string[] = [];

async function createFixture(): Promise<{
  store: SQLiteEventStore;
  permissions: MemoryAssetPermissionService;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-canonical-injection-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  return { store, permissions: new MemoryAssetPermissionService(store.getDatabase()) };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function registerLesson(
  permissions: MemoryAssetPermissionService,
  lessonId: string,
  injectionMode: 'direct' | 'summary' | 'reference' | 'tool',
  priority = 0,
  enabled = true
): Promise<void> {
  const assetId = `lesson:${lessonId}`;
  await permissions.create({
    projectHash: 'project-1', requesterActorId: 'owner', assetId, assetType: 'lesson',
    title: lessonId, sourceRefs: [assetId]
  });
  await permissions.bind({
    projectHash: 'project-1', requesterActorId: 'owner', assetId, actorId: 'agent-a',
    injectionMode, priority, enabled
  });
}

describe('CanonicalMemoryInjectionService', () => {
  it('preserves the original candidate order in legacy mode', async () => {
    const { store } = await createFixture();
    try {
      const service = new CanonicalMemoryInjectionService(store.getDatabase(), { mode: 'legacy' });
      const selection = service.select({
        projectHash: 'project-1', lane: 'context_pack', candidates: [
          { canonicalType: 'lesson', canonicalId: 'second', value: 'second' },
          { canonicalType: 'lesson', canonicalId: 'first', value: 'first' }
        ]
      });
      expect(selection).toMatchObject({ mode: 'legacy' });
      expect(selection.items).toEqual([
        { value: 'second', injectionMode: 'direct', priority: 0 },
        { value: 'first', injectionMode: 'direct', priority: 0 }
      ]);
    } finally {
      await store.close();
    }
  });

  it('requires an active binding for valid registrations and orders selected assets by priority', async () => {
    const { store, permissions } = await createFixture();
    try {
      await registerLesson(permissions, 'direct', 'direct', 10);
      await registerLesson(permissions, 'summary', 'summary', 5);
      await registerLesson(permissions, 'reference', 'reference', 5);
      await registerLesson(permissions, 'tool-only', 'tool', 50);
      await registerLesson(permissions, 'disabled', 'direct', 20, false);
      await registerLesson(permissions, 'archived', 'direct', 30);
      await permissions.update({
        projectHash: 'project-1', requesterActorId: 'owner', assetId: 'lesson:archived', status: 'archived'
      });
      await permissions.create({
        projectHash: 'project-1', requesterActorId: 'owner', assetId: 'lesson:conflict',
        assetType: 'wiki', title: 'conflict', sourceRefs: ['wiki:other']
      });

      const service = new CanonicalMemoryInjectionService(store.getDatabase(), { mode: 'registered' });
      const selection = service.select({
        projectHash: 'project-1', actorId: 'agent-a', lane: 'prompt', candidates: [
          ...['direct', 'summary', 'reference', 'tool-only', 'disabled', 'archived', 'unregistered', 'conflict']
            .map((canonicalId) => ({ canonicalType: 'lesson' as const, canonicalId, value: canonicalId }))
        ]
      });
      expect(selection.items).toEqual([
        { value: 'direct', injectionMode: 'direct', priority: 10 },
        { value: 'summary', injectionMode: 'summary', priority: 5 },
        { value: 'reference', injectionMode: 'reference', priority: 5 },
        { value: 'unregistered', injectionMode: 'direct', priority: 0 }
      ]);
    } finally {
      await store.close();
    }
  });

  it('fails closed for missing actors and unregistered assets in strict mode', async () => {
    const { store, permissions } = await createFixture();
    try {
      await registerLesson(permissions, 'bound', 'summary', 2);
      const service = new CanonicalMemoryInjectionService(store.getDatabase(), { mode: 'strict' });
      expect(() => service.select({
        projectHash: 'project-1', lane: 'context_pack', candidates: []
      })).toThrow('actor identity is required');

      const selection = service.select({
        projectHash: 'project-1', actorId: 'agent-a', lane: 'context_pack', candidates: [
          { canonicalType: 'lesson', canonicalId: 'bound', value: 'bound' },
          { canonicalType: 'lesson', canonicalId: 'unregistered', value: 'unregistered' }
        ]
      });
      expect(selection.items).toEqual([{ value: 'bound', injectionMode: 'summary', priority: 2 }]);
    } finally {
      await store.close();
    }
  });

  it('uses a hook input actor before the server fallback actor', () => {
    expect(resolveCanonicalMemoryActorId('input-actor', {
      [CANONICAL_MEMORY_ACTOR_ID_ENV]: 'env-actor'
    })).toBe('input-actor');
    expect(resolveCanonicalMemoryActorId(undefined, {
      [CANONICAL_MEMORY_ACTOR_ID_ENV]: 'env-actor'
    })).toBe('env-actor');
    expect(resolveCanonicalMemoryActorId('   ', {})).toBeUndefined();
  });
});
