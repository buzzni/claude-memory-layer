import { describe, expect, it } from 'vitest';

import {
  DISABLED_SHARED_STORE_CONFIG as CONFIG_DISABLED_SHARED_STORE_CONFIG
} from '../src/services/memory-service-config.js';
import {
  DISABLED_SHARED_STORE_CONFIG as FACADE_DISABLED_SHARED_STORE_CONFIG
} from '../src/services/memory-service.js';

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
});
