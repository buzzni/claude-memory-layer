import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  createSharedMemoryServices,
  type SharedMemoryServicesFactories
} from '../src/core/engine/shared-memory-services.js';
import type { Embedder } from '../src/core/embedder.js';
import type { Retriever } from '../src/core/retriever.js';
import type { SharedEventStore } from '../src/core/shared-event-store.js';
import type { SharedPromoter } from '../src/core/shared-promoter.js';
import type { SharedStore } from '../src/core/shared-store.js';
import type { Entry, SharedStoreConfig, SharedTroubleshootingEntry } from '../src/core/types.js';
import type { SharedVectorStore } from '../src/core/shared-vector-store.js';

const enabledConfig: SharedStoreConfig = {
  enabled: true,
  autoPromote: true,
  searchShared: true,
  minConfidenceForPromotion: 0.8,
  sharedStoragePath: '~/shared-memory'
};

function sharedEntry(entryId: string): SharedTroubleshootingEntry {
  return {
    entryId,
    sourceProjectHash: 'project-a',
    sourceEntryId: 'local-entry',
    title: 'Shared troubleshooting entry',
    symptoms: ['symptom'],
    rootCause: 'root cause',
    solution: 'solution',
    topics: ['shared'],
    technologies: ['typescript'],
    confidence: 0.9,
    usageCount: 0,
    promotedAt: new Date('2026-03-01T00:00:00.000Z'),
    createdAt: new Date('2026-03-01T00:00:00.000Z')
  };
}

function makeHarness(options?: { existingPaths?: string[] }) {
  const existing = new Set(options?.existingPaths ?? []);
  const mkdirCalls: string[] = [];
  const eventStoreInits: string[] = [];
  const vectorStoreInits: string[] = [];
  const closeCalls: string[] = [];
  const sharedStoreGets: string[] = [];
  const sharedStoreSearches: Array<{ query: string; options?: { topK?: number; minConfidence?: number } }> = [];
  const promoteCalls: Array<{ entry: Entry; projectHash: string }> = [];
  const setSharedStoresCalls: Array<{ store: SharedStore; vectorStore: SharedVectorStore }> = [];
  const createdEventStorePaths: string[] = [];
  const createdVectorStorePaths: string[] = [];
  const createdPromoters: Array<{ store: SharedStore; vectorStore: SharedVectorStore; embedder: Embedder; config?: SharedStoreConfig }> = [];

  const eventStore = {
    initialize: async () => { eventStoreInits.push('event-store'); },
    close: async () => { closeCalls.push('event-store'); }
  } as unknown as SharedEventStore;
  const sharedStore = {
    get: async (entryId: string) => {
      sharedStoreGets.push(entryId);
      return sharedEntry(entryId);
    },
    getStats: async () => ({
      total: 1,
      averageConfidence: 0.9,
      topTopics: [{ topic: 'shared', count: 1 }],
      totalUsageCount: 2
    }),
    search: async (query: string, searchOptions?: { topK?: number; minConfidence?: number }) => {
      sharedStoreSearches.push({ query, options: searchOptions });
      return [sharedEntry('search-result')];
    }
  } as unknown as SharedStore;
  const vectorStore = {
    initialize: async () => { vectorStoreInits.push('vector-store'); }
  } as unknown as SharedVectorStore;
  const promoter = {
    promoteEntry: async (entry: Entry, projectHash: string) => {
      promoteCalls.push({ entry, projectHash });
      return { success: true, entryId: 'shared-promoted' };
    }
  } as unknown as SharedPromoter;
  const embedder = { marker: 'embedder' } as unknown as Embedder;
  const retriever = {
    setSharedStores(store: SharedStore, sharedVectorStore: SharedVectorStore) {
      setSharedStoresCalls.push({ store, vectorStore: sharedVectorStore });
    }
  } as unknown as Retriever;

  const factories: SharedMemoryServicesFactories = {
    existsSync: (targetPath: string) => existing.has(targetPath),
    mkdirSync: (targetPath: string) => {
      mkdirCalls.push(targetPath);
      existing.add(targetPath);
    },
    createSharedEventStore: (dbPath: string) => {
      createdEventStorePaths.push(dbPath);
      return eventStore;
    },
    createSharedStore: (createdEventStore: SharedEventStore) => {
      expect(createdEventStore).toBe(eventStore);
      return sharedStore;
    },
    createSharedVectorStore: (dbPath: string) => {
      createdVectorStorePaths.push(dbPath);
      return vectorStore;
    },
    createSharedPromoter: (createdStore, createdVectorStore, createdEmbedder, config) => {
      createdPromoters.push({
        store: createdStore,
        vectorStore: createdVectorStore,
        embedder: createdEmbedder,
        config
      });
      return promoter;
    }
  };

  return {
    factories,
    embedder,
    retriever,
    eventStore,
    sharedStore,
    vectorStore,
    promoter,
    mkdirCalls,
    eventStoreInits,
    vectorStoreInits,
    closeCalls,
    sharedStoreGets,
    sharedStoreSearches,
    promoteCalls,
    setSharedStoresCalls,
    createdEventStorePaths,
    createdVectorStorePaths,
    createdPromoters
  };
}

describe('createSharedMemoryServices', () => {
  it('owns writable shared-store initialization and connects the retriever', async () => {
    const harness = makeHarness();
    const services = createSharedMemoryServices({
      config: enabledConfig,
      defaultSharedStoragePath: '/default/shared',
      readOnly: false,
      expandPath: (input) => input.replace('~', '/home/tester'),
      embedder: harness.embedder,
      retriever: harness.retriever,
      factories: harness.factories
    });

    await services.initialize();

    expect(services.getSharedStoragePath()).toBe('/home/tester/shared-memory');
    expect(harness.mkdirCalls).toEqual(['/home/tester/shared-memory']);
    expect(harness.createdEventStorePaths).toEqual([path.join('/home/tester/shared-memory', 'shared.duckdb')]);
    expect(harness.eventStoreInits).toEqual(['event-store']);
    expect(services.eventStore).toBe(harness.eventStore);
    expect(services.store).toBe(harness.sharedStore);
    expect(harness.createdVectorStorePaths).toEqual([path.join('/home/tester/shared-memory', 'vectors')]);
    expect(harness.vectorStoreInits).toEqual(['vector-store']);
    expect(services.vectorStore).toBe(harness.vectorStore);
    expect(services.promoter).toBe(harness.promoter);
    expect(harness.createdPromoters).toEqual([{
      store: harness.sharedStore,
      vectorStore: harness.vectorStore,
      embedder: harness.embedder,
      config: enabledConfig
    }]);
    expect(harness.setSharedStoresCalls).toEqual([{
      store: harness.sharedStore,
      vectorStore: harness.vectorStore
    }]);
  });

  it('opens only the shared event/store pair for disclosure reads', async () => {
    const harness = makeHarness({ existingPaths: ['/existing/shared'] });
    const services = createSharedMemoryServices({
      config: { ...enabledConfig, sharedStoragePath: '/existing/shared' },
      defaultSharedStoragePath: '/default/shared',
      readOnly: true,
      expandPath: (input) => input,
      embedder: harness.embedder,
      retriever: harness.retriever,
      factories: harness.factories
    });

    const store = await services.ensureStoreForRead();
    const entry = await services.getEntryForDisclosure('shared-entry-1');

    expect(store).toBe(harness.sharedStore);
    expect(entry).toMatchObject({ entryId: 'shared-entry-1', sourceProjectHash: 'project-a' });
    expect(harness.sharedStoreGets).toEqual(['shared-entry-1']);
    expect(harness.mkdirCalls).toEqual([]);
    expect(harness.createdEventStorePaths).toEqual([path.join('/existing/shared', 'shared.duckdb')]);
    expect(harness.eventStoreInits).toEqual(['event-store']);
    expect(harness.createdVectorStorePaths).toEqual([]);
    expect(harness.vectorStoreInits).toEqual([]);
    expect(harness.createdPromoters).toEqual([]);
    expect(harness.setSharedStoresCalls).toEqual([]);
  });

  it('does not create missing shared storage during read-only disclosure reads', async () => {
    const harness = makeHarness();
    const services = createSharedMemoryServices({
      config: enabledConfig,
      defaultSharedStoragePath: '/default/shared',
      readOnly: true,
      expandPath: (input) => input.replace('~', '/home/tester'),
      embedder: harness.embedder,
      retriever: harness.retriever,
      factories: harness.factories
    });

    await expect(services.ensureStoreForRead()).resolves.toBeNull();
    await expect(services.getEntryForDisclosure('missing')).resolves.toBeNull();

    expect(harness.mkdirCalls).toEqual([]);
    expect(harness.createdEventStorePaths).toEqual([]);
    expect(harness.createdVectorStorePaths).toEqual([]);
    expect(harness.createdPromoters).toEqual([]);
    expect(harness.setSharedStoresCalls).toEqual([]);
  });

  it('delegates promotion, stats, and shared search through the initialized store', async () => {
    const harness = makeHarness();
    const services = createSharedMemoryServices({
      config: enabledConfig,
      defaultSharedStoragePath: '/default/shared',
      readOnly: false,
      expandPath: (input) => input,
      embedder: harness.embedder,
      retriever: harness.retriever,
      factories: harness.factories
    });
    const entry = { id: 'entry-1', content: 'content' } as Entry;

    await services.initialize();

    await expect(services.promoteToShared(entry, 'project-a')).resolves.toEqual({
      success: true,
      entryId: 'shared-promoted'
    });
    await expect(services.getStats()).resolves.toEqual({
      total: 1,
      averageConfidence: 0.9,
      topTopics: [{ topic: 'shared', count: 1 }],
      totalUsageCount: 2
    });
    await expect(services.search('timeout', { topK: 3, minConfidence: 0.7 })).resolves.toMatchObject([
      { entryId: 'search-result' }
    ]);
    expect(harness.promoteCalls).toEqual([{ entry, projectHash: 'project-a' }]);
    expect(harness.sharedStoreSearches).toEqual([
      { query: 'timeout', options: { topK: 3, minConfidence: 0.7 } }
    ]);
  });

  it('keeps disabled shared-store configuration inert', async () => {
    const harness = makeHarness();
    const services = createSharedMemoryServices({
      config: { ...enabledConfig, enabled: false },
      defaultSharedStoragePath: '/default/shared',
      readOnly: false,
      expandPath: (input) => input,
      embedder: harness.embedder,
      retriever: harness.retriever,
      factories: harness.factories
    });

    await services.initialize();

    await expect(services.ensureStoreForRead()).resolves.toBeNull();
    await expect(services.getEntryForDisclosure('shared-entry')).resolves.toBeNull();
    await expect(services.getStats()).resolves.toBeNull();
    await expect(services.search('timeout')).resolves.toEqual([]);
    await expect(services.promoteToShared({ id: 'entry-1', content: 'content' } as Entry, 'project-a'))
      .resolves.toMatchObject({ success: false });
    expect(services.isEnabled()).toBe(false);
    expect(harness.mkdirCalls).toEqual([]);
    expect(harness.createdEventStorePaths).toEqual([]);
    expect(harness.createdVectorStorePaths).toEqual([]);
    expect(harness.createdPromoters).toEqual([]);
    expect(harness.setSharedStoresCalls).toEqual([]);
  });

  it('closes the shared event store when one was opened', async () => {
    const harness = makeHarness({ existingPaths: ['/existing/shared'] });
    const services = createSharedMemoryServices({
      config: { ...enabledConfig, sharedStoragePath: '/existing/shared' },
      defaultSharedStoragePath: '/default/shared',
      readOnly: true,
      expandPath: (input) => input,
      embedder: harness.embedder,
      retriever: harness.retriever,
      factories: harness.factories
    });

    await services.ensureStoreForRead();
    await services.close();

    expect(harness.closeCalls).toEqual(['event-store']);
    expect(services.eventStore).toBeNull();
    expect(services.store).toBeNull();
  });
});
