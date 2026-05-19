import { describe, expect, it } from 'vitest';

import { ConfigSchema } from '../../src/core/types.js';
import {
  DEFAULT_ENABLED_MEMORY_OPERATIONS_CONFIG,
  DEFAULT_ENABLED_SHARED_STORE_CONFIG as CONFIG_DEFAULT_ENABLED_SHARED_STORE_CONFIG,
  DISABLED_MEMORY_OPERATIONS_CONFIG,
  DISABLED_SHARED_STORE_CONFIG as CONFIG_DISABLED_SHARED_STORE_CONFIG,
  DEFAULT_SHARED_STORAGE_PATH as CONFIG_DEFAULT_SHARED_STORAGE_PATH
} from '../../src/services/memory-service-config.js';
import {
  DEFAULT_ENABLED_SHARED_STORE_CONFIG as FACADE_DEFAULT_ENABLED_SHARED_STORE_CONFIG,
  DISABLED_SHARED_STORE_CONFIG as FACADE_DISABLED_SHARED_STORE_CONFIG
} from '../../src/services/memory-service.js';

/**
 * MemoryService should stay a thin compatibility facade. Shared defaults are
 * owned by memory-service-config so registries can import them without pulling
 * in the MemoryService class and creating a service-locator cycle.
 */
describe('memory-service-config', () => {
  it('owns disabled shared-store defaults while memory-service preserves the public export', () => {
    expect(CONFIG_DISABLED_SHARED_STORE_CONFIG).toMatchObject({
      enabled: false,
      autoPromote: false,
      searchShared: false,
      minConfidenceForPromotion: 0.8
    });
    expect(CONFIG_DISABLED_SHARED_STORE_CONFIG.sharedStoragePath).toContain('.claude-code');
    expect(CONFIG_DISABLED_SHARED_STORE_CONFIG.sharedStoragePath).toContain('shared');
    expect(FACADE_DISABLED_SHARED_STORE_CONFIG).toBe(CONFIG_DISABLED_SHARED_STORE_CONFIG);
  });

  it('owns enabled shared-store defaults while memory-service preserves the public export', () => {
    expect(CONFIG_DEFAULT_ENABLED_SHARED_STORE_CONFIG).toEqual({
      enabled: true,
      autoPromote: true,
      searchShared: true,
      minConfidenceForPromotion: 0.8,
      sharedStoragePath: CONFIG_DEFAULT_SHARED_STORAGE_PATH
    });
    expect(FACADE_DEFAULT_ENABLED_SHARED_STORE_CONFIG).toBe(CONFIG_DEFAULT_ENABLED_SHARED_STORE_CONFIG);
  });

  it('ships memory operations disabled by default with safe subfeatures', () => {
    expect(DISABLED_MEMORY_OPERATIONS_CONFIG).toEqual({
      enabled: false,
      facets: { enabled: true },
      actions: { enabled: true },
      retention: { enabled: false, policyVersion: 'v1' },
      graphExpansion: { enabled: false, maxHops: 1 },
      lessons: { enabled: false }
    });

    expect(DEFAULT_ENABLED_MEMORY_OPERATIONS_CONFIG).toEqual({
      ...DISABLED_MEMORY_OPERATIONS_CONFIG,
      enabled: true
    });
  });

  it('parses memory operations config defaults without enabling ranking-changing features', () => {
    const parsed = ConfigSchema.parse({});

    expect(parsed.operations).toEqual(DISABLED_MEMORY_OPERATIONS_CONFIG);
  });
});
