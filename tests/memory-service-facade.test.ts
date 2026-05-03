import { mkdtemp } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import {
  DISABLED_SHARED_STORE_CONFIG,
  MemoryService
} from '../src/services/memory-service.js';

describe('MemoryService facade delegation', () => {
  it('reads the embedding model name through the embedding maintenance facade', async () => {
    const storagePath = await mkdtemp(path.join(os.tmpdir(), 'memory-service-facade-'));
    const service = new MemoryService({
      storagePath,
      sharedStoreConfig: DISABLED_SHARED_STORE_CONFIG
    });
    const serviceInternals = service as unknown as {
      embedder: { getModelName(): string };
      embeddingMaintenanceService: { getEmbeddingModelName(): string };
    };
    serviceInternals.embedder = { getModelName: () => 'direct-embedder-model' };
    serviceInternals.embeddingMaintenanceService = {
      getEmbeddingModelName: () => 'maintenance-facade-model'
    };

    expect(service.getEmbeddingModelName()).toBe('maintenance-facade-model');
  });
});
