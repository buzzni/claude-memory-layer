import { describe, expect, it, vi } from 'vitest';

import {
  createMemoryServiceComposition,
  type MemoryServiceCompositionFactories
} from '../src/core/engine/memory-service-composition.js';
import type { SharedStoreConfig, ToolObservationPayload } from '../src/core/types.js';

const sharedStoreConfig: SharedStoreConfig = {
  enabled: true,
  autoPromote: true,
  searchShared: true,
  minConfidenceForPromotion: 0.8,
  sharedStoragePath: '~/shared-memory'
};

describe('createMemoryServiceComposition', () => {
  it('wires engine, endless, shared, runtime, and embedding maintenance services for MemoryService', async () => {
    const initialize = vi.fn(async () => undefined);
    let projectHash: string | null = 'project-hash-1';
    let projectPath: string | null = '/repo/project';

    const sqliteStore = {
      clearEmbeddingOutbox: vi.fn(async () => undefined),
      getEventsPage: vi.fn(async () => [{ id: 'event-1', content: 'event content' }]),
      enqueueForEmbedding: vi.fn(async () => undefined)
    };
    const vectorStore = { name: 'vector-store' };
    const embedder = { getModelName: vi.fn(() => 'test-embedding-model') };
    const retriever = { setSharedStores: vi.fn() };
    const graduation = { name: 'graduation' };
    const ingestService = { name: 'ingest' };
    const queryService = { name: 'query' };
    const retrievalOrchestrator = { name: 'retrieval-orchestrator' };
    const retrievalDisclosureService = { name: 'retrieval-disclosure' };
    const retrievalAnalyticsService = { name: 'retrieval-analytics' };
    const endlessMemoryServices = { name: 'endless-memory' };
    const sharedMemoryServices = {
      isEnabled: vi.fn(() => true),
      getEntryForDisclosure: vi.fn(async (entryId: string) => ({ id: entryId }))
    };
    const runtimeService = { getVectorWorker: vi.fn(() => ({ name: 'vector-worker' })) };
    const embeddingMaintenanceService = { getEmbeddingModelName: vi.fn(() => 'maintenance-model') };

    const factories: MemoryServiceCompositionFactories = {
      expandPath: vi.fn((targetPath: string) => targetPath.replace('~', '/home/test')),
      createToolObservationEmbedding: vi.fn((toolName: string) => `embedding:${toolName}`),
      createMemoryEngineServices: vi.fn(() => ({
        storagePath: '/expanded/storage',
        sqliteStore,
        vectorStore,
        embedder,
        matcher: { name: 'matcher' },
        retriever,
        retrievalOrchestrator,
        retrievalDisclosureService,
        retrievalAnalyticsService,
        graduation,
        mdMirror: { name: 'md-mirror' },
        ingestService,
        queryService
      }) as any),
      createEndlessMemoryServices: vi.fn(() => endlessMemoryServices as any),
      createSharedMemoryServices: vi.fn(() => sharedMemoryServices as any),
      createMemoryRuntimeService: vi.fn(() => runtimeService as any),
      createEmbeddingMaintenanceService: vi.fn(() => embeddingMaintenanceService as any)
    };

    const composition = createMemoryServiceComposition({
      config: {
        storagePath: '~/memory-store',
        embeddingModel: 'explicit-model',
        readOnly: true,
        lightweightMode: true,
        embeddingOnly: true,
        projectHash,
        projectPath,
        sharedStoreConfig
      },
      defaultSharedStoragePath: '/default/shared',
      initialize,
      getProjectHash: () => projectHash,
      getProjectPath: () => projectPath,
      factories
    });

    expect(factories.expandPath).toHaveBeenCalledWith('~/memory-store');
    expect(factories.createMemoryEngineServices).toHaveBeenCalledWith(expect.objectContaining({
      storagePath: '/home/test/memory-store',
      readOnly: true,
      embeddingModel: 'explicit-model',
      initialize,
      getProjectHash: expect.any(Function),
      getProjectPath: expect.any(Function),
      hasSharedStore: expect.any(Function),
      sharedStore: expect.objectContaining({ get: expect.any(Function) }),
      createToolObservationEmbedding: expect.any(Function)
    }));

    const engineOptions = vi.mocked(factories.createMemoryEngineServices).mock.calls[0][0];
    expect(engineOptions.createToolObservationEmbedding({
      toolName: 'Read',
      metadata: { path: 'README.md' },
      success: true
    } as ToolObservationPayload)).toBe('embedding:Read');
    expect(factories.createToolObservationEmbedding).toHaveBeenCalledWith(
      'Read',
      { path: 'README.md' },
      true
    );

    expect(factories.createEndlessMemoryServices).toHaveBeenCalledWith({
      eventStore: sqliteStore,
      configStore: sqliteStore,
      initialize
    });
    expect(factories.createSharedMemoryServices).toHaveBeenCalledWith({
      config: sharedStoreConfig,
      defaultSharedStoragePath: '/default/shared',
      readOnly: true,
      expandPath: expect.any(Function),
      embedder,
      retriever
    });
    expect(factories.createMemoryRuntimeService).toHaveBeenCalledWith(expect.objectContaining({
      sqliteStore,
      eventStore: sqliteStore,
      vectorStore,
      embedder,
      retriever,
      graduation,
      endlessMemoryServices,
      sharedMemoryServices,
      readOnly: true,
      lightweightMode: true,
      embeddingOnly: true
    }));
    expect(factories.createEmbeddingMaintenanceService).toHaveBeenCalledWith(expect.objectContaining({
      storagePath: '/home/test/memory-store',
      initialize,
      getEmbeddingModelName: expect.any(Function),
      vectorStore,
      eventStore: expect.objectContaining({
        clearEmbeddingOutbox: expect.any(Function),
        getEventsPage: expect.any(Function),
        enqueueForEmbedding: expect.any(Function)
      }),
      getVectorWorker: expect.any(Function)
    }));

    const embeddingOptions = vi.mocked(factories.createEmbeddingMaintenanceService).mock.calls[0][0];
    expect(embeddingOptions.getEmbeddingModelName()).toBe('test-embedding-model');
    expect(embeddingOptions.getVectorWorker()).toEqual({ name: 'vector-worker' });
    await embeddingOptions.eventStore.clearEmbeddingOutbox();
    await expect(embeddingOptions.eventStore.getEventsPage(10, 0)).resolves.toEqual([
      { id: 'event-1', content: 'event content' }
    ]);
    await embeddingOptions.eventStore.enqueueForEmbedding('event-1', 'event content');
    expect(sqliteStore.clearEmbeddingOutbox).toHaveBeenCalled();
    expect(sqliteStore.getEventsPage).toHaveBeenCalledWith(10, 0);
    expect(sqliteStore.enqueueForEmbedding).toHaveBeenCalledWith('event-1', 'event content');

    expect(await engineOptions.sharedStore?.get('shared-1')).toEqual({ id: 'shared-1' });
    expect(engineOptions.hasSharedStore()).toBe(true);
    projectHash = 'project-hash-2';
    projectPath = '/repo/other';
    expect(engineOptions.getProjectHash()).toBe('project-hash-2');
    expect(engineOptions.getProjectPath?.()).toBe('/repo/other');

    expect(composition).toMatchObject({
      storagePath: '/home/test/memory-store',
      readOnly: true,
      lightweightMode: true,
      embeddingOnly: true,
      sqliteStore,
      vectorStore,
      embedder,
      retriever,
      retrievalOrchestrator,
      retrievalDisclosureService,
      retrievalAnalyticsService,
      graduation,
      ingestService,
      queryService,
      endlessMemoryServices,
      sharedMemoryServices,
      runtimeService,
      embeddingMaintenanceService
    });
  });
});
