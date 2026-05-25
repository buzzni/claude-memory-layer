import { describe, expect, it } from 'vitest';

import {
  createMemoryRuntimeService,
  type MemoryRuntimeServicesFactories
} from '../../src/core/engine/memory-runtime-service.js';
import type { EventStore } from '../../src/core/event-store.js';
import type { Embedder } from '../../src/core/embedder.js';
import type { GraduationPipeline } from '../../src/core/graduation.js';
import type { Retriever } from '../../src/core/retriever.js';
import type { VectorStore } from '../../src/core/vector-store.js';
import type { Database } from '../../src/core/db-wrapper.js';

function makeHarness(options?: { readOnly?: boolean; lightweightMode?: boolean; embeddingOnly?: boolean; enableV2?: boolean }) {
  const calls: string[] = [];
  const eventStore = { marker: 'event-store' } as unknown as EventStore;
  const sqliteDb = { marker: 'sqlite-db' } as unknown as Database;
  const vectorStore = {
    initialize: async () => { calls.push('vector.initialize'); }
  } as unknown as VectorStore;
  const embedder = {
    initialize: async () => { calls.push('embedder.initialize'); }
  } as unknown as Embedder;
  const graduation = {
    marker: 'graduation',
    recordAccess: (eventId: string, sessionId: string, confidence: number = 1.0) => {
      calls.push(`graduation.recordAccess:${eventId}:${sessionId}:${confidence}`);
    }
  } as unknown as GraduationPipeline;
  const retriever = {
    setGraduationPipeline: (pipeline: GraduationPipeline) => {
      calls.push(pipeline === graduation ? 'retriever.setGraduationPipeline' : 'retriever.setGraduationPipeline:unknown');
    }
  } as unknown as Retriever;

  const vectorWorker = {
    start: () => { calls.push('vectorWorker.start'); },
    stop: () => { calls.push('vectorWorker.stop'); },
    processAll: async () => {
      calls.push('vectorWorker.processAll');
      return 3;
    }
  };
  const vectorWorkerV2 = {
    start: () => { calls.push('vectorWorkerV2.start'); },
    stop: () => { calls.push('vectorWorkerV2.stop'); },
    processAll: async () => {
      calls.push('vectorWorkerV2.processAll');
      return 5;
    }
  };
  const graduationWorker = {
    start: () => { calls.push('graduationWorker.start'); },
    stop: () => { calls.push('graduationWorker.stop'); },
    forceRun: async () => {
      calls.push('graduationWorker.forceRun');
      return { evaluated: 2, graduated: 1, byLevel: { L0: 1 } };
    }
  };

  const factories = {
    createVectorWorker: (receivedEventStore, receivedVectorStore, receivedEmbedder) => {
      calls.push(
        receivedEventStore === eventStore && receivedVectorStore === vectorStore && receivedEmbedder === embedder
          ? 'createVectorWorker'
          : 'createVectorWorker:unknown'
      );
      return vectorWorker as unknown as ReturnType<NonNullable<MemoryRuntimeServicesFactories['createVectorWorker']>>;
    },
    ...(options?.enableV2 ? {
      createVectorWorkerV2: (receivedDb: Database, receivedVectorStore: VectorStore, receivedEmbedder: Embedder) => {
        calls.push(
          receivedDb === sqliteDb && receivedVectorStore === vectorStore && receivedEmbedder === embedder
            ? 'createVectorWorkerV2'
            : 'createVectorWorkerV2:unknown'
        );
        return vectorWorkerV2;
      }
    } : {}),
    createGraduationWorker: (receivedEventStore, receivedGraduation) => {
      calls.push(
        receivedEventStore === eventStore && receivedGraduation === graduation
          ? 'createGraduationWorker'
          : 'createGraduationWorker:unknown'
      );
      return graduationWorker as unknown as ReturnType<NonNullable<MemoryRuntimeServicesFactories['createGraduationWorker']>>;
    }
  } as unknown as MemoryRuntimeServicesFactories;

  const sqliteStore = {
    initialize: async () => { calls.push('sqlite.initialize'); },
    close: async () => { calls.push('sqlite.close'); },
    ...(options?.enableV2 ? { getDatabase: () => sqliteDb } : {})
  };

  const service = createMemoryRuntimeService({
    sqliteStore,
    eventStore,
    vectorStore,
    embedder,
    retriever,
    graduation,
    endlessMemoryServices: {
      initializeFromSavedMode: async () => { calls.push('endless.initializeFromSavedMode'); },
      shutdown: () => { calls.push('endless.shutdown'); }
    },
    sharedMemoryServices: {
      initialize: async () => { calls.push('shared.initialize'); },
      close: async () => { calls.push('shared.close'); }
    },
    readOnly: options?.readOnly ?? false,
    lightweightMode: options?.lightweightMode ?? false,
    embeddingOnly: options?.embeddingOnly ?? false,
    factories
  });

  return { service, calls, vectorWorker, vectorWorkerV2 };
}

describe('createMemoryRuntimeService', () => {
  it('initializes only sqlite in lightweight mode and keeps initialize idempotent', async () => {
    const harness = makeHarness({ lightweightMode: true });

    await harness.service.initialize();
    await harness.service.initialize();

    expect(harness.service.isInitialized()).toBe(true);
    expect(harness.calls).toEqual(['sqlite.initialize']);
    await expect(harness.service.processPendingEmbeddings()).resolves.toBe(0);
    await expect(harness.service.forceGraduation()).resolves.toEqual({ evaluated: 0, graduated: 0, byLevel: {} });
  });

  it('records memory access through the graduation pipeline without initializing runtime workers', () => {
    const harness = makeHarness();

    harness.service.recordMemoryAccess('event-1', 'session-2', 0.42);

    expect(harness.service.isInitialized()).toBe(false);
    expect(harness.calls).toEqual(['graduation.recordAccess:event-1:session-2:0.42']);
  });

  it('starts vector and graduation workers plus writable lifecycle services by default', async () => {
    const harness = makeHarness();

    await harness.service.initialize();

    expect(harness.calls).toEqual([
      'sqlite.initialize',
      'vector.initialize',
      'embedder.initialize',
      'createVectorWorker',
      'vectorWorker.start',
      'retriever.setGraduationPipeline',
      'createGraduationWorker',
      'graduationWorker.start',
      'endless.initializeFromSavedMode',
      'shared.initialize'
    ]);
    expect(harness.service.getVectorWorker()).toBe(harness.vectorWorker);
    await expect(harness.service.processPendingEmbeddings()).resolves.toBe(3);
    await expect(harness.service.forceGraduation()).resolves.toEqual({ evaluated: 2, graduated: 1, byLevel: { L0: 1 } });
  });

  it('starts and drains V2 vector outbox work alongside legacy embedding work when a SQLite database is available', async () => {
    const harness = makeHarness({ enableV2: true });

    await harness.service.initialize();

    expect(harness.calls).toEqual([
      'sqlite.initialize',
      'vector.initialize',
      'embedder.initialize',
      'createVectorWorker',
      'vectorWorker.start',
      'createVectorWorkerV2',
      'vectorWorkerV2.start',
      'retriever.setGraduationPipeline',
      'createGraduationWorker',
      'graduationWorker.start',
      'endless.initializeFromSavedMode',
      'shared.initialize'
    ]);
    expect(harness.service.getVectorWorker()).toBe(harness.vectorWorker);
    harness.calls.length = 0;

    await expect(harness.service.processPendingEmbeddings()).resolves.toBe(8);
    expect(harness.calls).toEqual([
      'vectorWorker.processAll',
      'vectorWorkerV2.processAll'
    ]);

    harness.calls.length = 0;
    await harness.service.shutdown();
    expect(harness.calls).toEqual([
      'graduationWorker.stop',
      'endless.shutdown',
      'vectorWorker.stop',
      'vectorWorkerV2.stop',
      'shared.close',
      'sqlite.close'
    ]);
  });

  it('skips workers and write lifecycle services in read-only mode', async () => {
    const harness = makeHarness({ readOnly: true });

    await harness.service.initialize();

    expect(harness.calls).toEqual([
      'sqlite.initialize',
      'vector.initialize',
      'embedder.initialize'
    ]);
    expect(harness.service.getVectorWorker()).toBeNull();
  });

  it('embedding-only mode starts vector worker but skips graduation worker', async () => {
    const harness = makeHarness({ embeddingOnly: true });

    await harness.service.initialize();

    expect(harness.calls).toEqual([
      'sqlite.initialize',
      'vector.initialize',
      'embedder.initialize',
      'createVectorWorker',
      'vectorWorker.start',
      'endless.initializeFromSavedMode',
      'shared.initialize'
    ]);
    await expect(harness.service.forceGraduation()).resolves.toEqual({ evaluated: 0, graduated: 0, byLevel: {} });
  });

  it('returns a fresh empty graduation result when no graduation worker exists', async () => {
    const harness = makeHarness({ embeddingOnly: true });
    await harness.service.initialize();

    const first = await harness.service.forceGraduation();
    first.byLevel.L0 = 99;
    first.evaluated = 99;

    const second = await harness.service.forceGraduation();

    expect(second).toEqual({ evaluated: 0, graduated: 0, byLevel: {} });
    expect(second).not.toBe(first);
    expect(second.byLevel).not.toBe(first.byLevel);
  });

  it('shuts down workers and backing services in the historical MemoryService order', async () => {
    const harness = makeHarness();
    await harness.service.initialize();
    harness.calls.length = 0;

    await harness.service.shutdown();

    expect(harness.calls).toEqual([
      'graduationWorker.stop',
      'endless.shutdown',
      'vectorWorker.stop',
      'shared.close',
      'sqlite.close'
    ]);
  });
});
