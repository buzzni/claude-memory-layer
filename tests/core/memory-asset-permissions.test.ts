import { describe, expect, it } from 'vitest';

import {
  checkMemoryAssetPermission,
  type MemoryAsset,
  type MemoryAssetBinding,
  type MemoryAssetGrant
} from '../../src/core/operations/memory-asset-permissions.js';

const asset: MemoryAsset = {
  assetId: 'asset-1',
  projectHash: 'project-1',
  assetType: 'memory',
  title: 'Release checklist',
  ownerActorId: 'owner',
  version: 1,
  status: 'active',
  visibility: 'private',
  sourceRefs: ['lesson-1'],
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-01T00:00:00.000Z')
};

const binding: MemoryAssetBinding = {
  projectHash: 'project-1',
  assetId: 'asset-1',
  actorId: 'reader',
  injectionMode: 'reference',
  priority: 0,
  enabled: true,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-01T00:00:00.000Z')
};

const grant: MemoryAssetGrant = {
  projectHash: 'project-1',
  assetId: 'asset-1',
  actorId: 'editor',
  permissions: ['read', 'write'],
  createdBy: 'owner',
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-01T00:00:00.000Z')
};

describe('checkMemoryAssetPermission', () => {
  it('gives the owner every permission', () => {
    for (const permission of ['read', 'write', 'bind', 'grant'] as const) {
      expect(checkMemoryAssetPermission({ asset, actorId: 'owner', permission })).toMatchObject({
        allowed: true,
        source: 'owner'
      });
    }
  });

  it('limits project/shared visibility to read permission', () => {
    const visible = { ...asset, visibility: 'project' as const };
    expect(checkMemoryAssetPermission({ asset: visible, actorId: 'viewer', permission: 'read' })).toMatchObject({
      allowed: true,
      source: 'visibility'
    });
    expect(checkMemoryAssetPermission({ asset: visible, actorId: 'viewer', permission: 'write' }).allowed).toBe(false);
  });

  it('lets an enabled binding read a private asset but never mutate it', () => {
    expect(checkMemoryAssetPermission({ asset, actorId: 'reader', permission: 'read', binding })).toMatchObject({
      allowed: true,
      source: 'binding'
    });
    expect(checkMemoryAssetPermission({ asset, actorId: 'reader', permission: 'write', binding }).allowed).toBe(false);
    expect(checkMemoryAssetPermission({
      asset,
      actorId: 'reader',
      permission: 'read',
      binding: { ...binding, enabled: false }
    }).allowed).toBe(false);
  });

  it('applies only permissions present in an explicit grant', () => {
    expect(checkMemoryAssetPermission({ asset, actorId: 'editor', permission: 'write', grant })).toMatchObject({
      allowed: true,
      source: 'grant'
    });
    expect(checkMemoryAssetPermission({ asset, actorId: 'editor', permission: 'grant', grant }).allowed).toBe(false);
  });

  it('uses a generic denial reason that does not disclose policy details', () => {
    expect(checkMemoryAssetPermission({ asset, actorId: 'stranger', permission: 'read' })).toEqual({
      allowed: false,
      permission: 'read',
      source: 'none',
      reason: 'permission denied'
    });
  });
});
