import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CANONICAL_MEMORY_PERMISSION_MODE_ENV,
  CanonicalMemoryAccessDeniedError,
  CanonicalMemoryAccessService,
  resolveCanonicalMemoryPermissionMode
} from '../../src/core/operations/canonical-memory-access-service.js';
import { MemoryAssetPermissionService } from '../../src/core/operations/memory-asset-permission-service.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

const tempDirs: string[] = [];

async function createFixture(): Promise<{
  store: SQLiteEventStore;
  permissions: MemoryAssetPermissionService;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-canonical-access-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  return {
    store,
    permissions: new MemoryAssetPermissionService(store.getDatabase())
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('canonical memory permission mode', () => {
  it('defaults to legacy and rejects invalid configuration instead of silently downgrading', () => {
    expect(resolveCanonicalMemoryPermissionMode({})).toBe('legacy');
    expect(resolveCanonicalMemoryPermissionMode({
      [CANONICAL_MEMORY_PERMISSION_MODE_ENV]: ' REGISTERED '
    })).toBe('registered');
    expect(() => resolveCanonicalMemoryPermissionMode({
      [CANONICAL_MEMORY_PERMISSION_MODE_ENV]: 'registred'
    })).toThrow(`${CANONICAL_MEMORY_PERMISSION_MODE_ENV} must be legacy, registered, or strict`);
  });
});

describe('CanonicalMemoryAccessService', () => {
  it('preserves legacy access while registered and strict modes require a principal', async () => {
    const { store } = await createFixture();
    try {
      const legacy = new CanonicalMemoryAccessService(store.getDatabase(), { mode: 'legacy' });
      expect(legacy.check({
        projectHash: 'project-1', canonicalType: 'lesson', canonicalId: 'lesson-1', permission: 'read'
      })).toMatchObject({ allowed: true, mode: 'legacy', registered: false, source: 'legacy' });

      for (const mode of ['registered', 'strict'] as const) {
        const service = new CanonicalMemoryAccessService(store.getDatabase(), { mode });
        expect(() => service.check({
          projectHash: 'project-1', canonicalType: 'lesson', canonicalId: 'lesson-1', permission: 'read'
        })).toThrow(`requesterActorId is required when ${CANONICAL_MEMORY_PERMISSION_MODE_ENV}=${mode}`);
      }
    } finally {
      await store.close();
    }
  });

  it('uses unregistered fallback only in registered migration mode', async () => {
    const { store } = await createFixture();
    try {
      const registered = new CanonicalMemoryAccessService(store.getDatabase(), { mode: 'registered' });
      expect(registered.check({
        projectHash: 'project-1', canonicalType: 'core_memory_block', canonicalId: 'project',
        requesterActorId: 'caller', permission: 'write'
      })).toMatchObject({ allowed: true, registered: false, source: 'unregistered' });
      expect(registered.requireUnregisteredWrite('caller')).toMatchObject({ allowed: true, source: 'unregistered' });

      const strict = new CanonicalMemoryAccessService(store.getDatabase(), { mode: 'strict' });
      expect(strict.check({
        projectHash: 'project-1', canonicalType: 'core_memory_block', canonicalId: 'project',
        requesterActorId: 'caller', permission: 'write'
      })).toMatchObject({ allowed: false, registered: false, source: 'none' });
      expect(() => strict.requireUnregisteredWrite('caller')).toThrow(CanonicalMemoryAccessDeniedError);
    } finally {
      await store.close();
    }
  });

  it('enforces owner and explicit grants for valid canonical registrations', async () => {
    const { store, permissions } = await createFixture();
    try {
      await permissions.create({
        projectHash: 'project-1',
        requesterActorId: 'owner',
        assetId: 'lesson:lesson-1',
        assetType: 'lesson',
        title: 'Registered lesson',
        sourceRefs: ['lesson:lesson-1']
      });
      const service = new CanonicalMemoryAccessService(store.getDatabase(), { mode: 'registered' });
      expect(service.check({
        projectHash: 'project-1', canonicalType: 'lesson', canonicalId: 'lesson-1',
        requesterActorId: 'owner', permission: 'write'
      })).toMatchObject({ allowed: true, registered: true, source: 'owner' });
      expect(service.check({
        projectHash: 'project-1', canonicalType: 'lesson', canonicalId: 'lesson-1',
        requesterActorId: 'reader', permission: 'read'
      })).toMatchObject({ allowed: false, registered: true, source: 'none' });

      await permissions.setGrant({
        projectHash: 'project-1', requesterActorId: 'owner', assetId: 'lesson:lesson-1',
        actorId: 'reader', permissions: ['read']
      });
      expect(service.check({
        projectHash: 'project-1', canonicalType: 'lesson', canonicalId: 'lesson-1',
        requesterActorId: 'reader', permission: 'read'
      })).toMatchObject({ allowed: true, registered: true, source: 'grant' });
      expect(() => service.require({
        projectHash: 'project-1', canonicalType: 'lesson', canonicalId: 'lesson-1',
        requesterActorId: 'reader', permission: 'write'
      })).toThrow(CanonicalMemoryAccessDeniedError);
    } finally {
      await store.close();
    }
  });

  it('denies deterministic-id conflicts instead of treating them as unregistered fallback', async () => {
    const { store, permissions } = await createFixture();
    try {
      await permissions.create({
        projectHash: 'project-1',
        requesterActorId: 'caller',
        assetId: 'core_memory_block:project',
        assetType: 'wiki',
        title: 'Unrelated conflicting asset',
        sourceRefs: ['wiki:other']
      });
      const service = new CanonicalMemoryAccessService(store.getDatabase(), { mode: 'registered' });
      expect(service.check({
        projectHash: 'project-1', canonicalType: 'core_memory_block', canonicalId: 'project',
        requesterActorId: 'caller', permission: 'read'
      })).toMatchObject({ allowed: false, registered: false, source: 'none' });
    } finally {
      await store.close();
    }
  });
});
