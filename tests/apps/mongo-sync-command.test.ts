import { describe, expect, it, vi } from 'vitest';

import {
  createMongoSyncPostProcessor,
  processProjectEmbeddingsOnce,
  resolveMongoSyncProcessOptions
} from '../../src/apps/cli/mongo-sync-command.js';

describe('mongo-sync process-after-sync options', () => {
  it('resolves disabled defaults and strict process interval settings', () => {
    expect(resolveMongoSyncProcessOptions(
      { project: '/repo/app' },
      '/cwd',
      { getProjectStoragePath: () => '/tmp/cml-store' }
    )).toEqual({
      projectPath: '/repo/app',
      processAfterSync: false,
      processIntervalMs: 120_000,
      lockPath: '/tmp/cml-store/vector-worker.lock'
    });

    expect(resolveMongoSyncProcessOptions(
      { project: '/repo/app', processAfterSync: true, processInterval: '60000', processLockPath: '/tmp/custom.lock' },
      '/cwd',
      { getProjectStoragePath: () => '/tmp/cml-store' }
    )).toEqual({
      projectPath: '/repo/app',
      processAfterSync: true,
      processIntervalMs: 60_000,
      lockPath: '/tmp/custom.lock'
    });
  });

  it('rejects invalid process-after-sync intervals before side effects', () => {
    for (const processInterval of ['0', '-1', '1.5', '1e2', '100ms', '   ']) {
      expect(() => resolveMongoSyncProcessOptions(
        { project: '/repo/app', processAfterSync: true, processInterval },
        '/cwd',
        { getProjectStoragePath: () => '/tmp/cml-store' }
      )).toThrow('--process-interval must be a positive integer number of milliseconds');
    }

    expect(() => resolveMongoSyncProcessOptions(
      { project: '/repo/app', processAfterSync: true, processLockPath: '   ' },
      '/cwd',
      { getProjectStoragePath: () => '/tmp/cml-store' }
    )).toThrow('--process-lock-path must not be empty');
  });
});

describe('mongo-sync process-after-sync scheduler', () => {
  it('processes only after pulled events and debounces repeated watch ticks', async () => {
    let now = 1_000;
    const processOnce = vi.fn(async () => ({ skipped: false, processed: 3 }));
    const logs: string[] = [];
    const postProcessor = createMongoSyncPostProcessor(
      {
        projectPath: '/repo/app',
        processAfterSync: true,
        processIntervalMs: 120_000,
        lockPath: '/tmp/cml-store/vector-worker.lock'
      },
      {
        now: () => now,
        processOnce,
        log: (message) => logs.push(message)
      }
    );

    await postProcessor.afterSync({ pushed: 4, pulled: 0 });
    expect(processOnce).not.toHaveBeenCalled();

    await postProcessor.afterSync({ pushed: 0, pulled: 2 });
    expect(processOnce).toHaveBeenCalledTimes(1);
    expect(processOnce).toHaveBeenLastCalledWith({
      projectPath: '/repo/app',
      lockPath: '/tmp/cml-store/vector-worker.lock'
    });
    expect(logs).toContain('[mongo-sync] Processing pending embeddings after pulling 2 events...');
    expect(logs).toContain('[mongo-sync] Processed 3 embeddings after sync');

    now += 30_000;
    await postProcessor.afterSync({ pushed: 0, pulled: 1 });
    expect(processOnce).toHaveBeenCalledTimes(1);

    now += 90_000;
    await postProcessor.afterSync({ pushed: 0, pulled: 1 });
    expect(processOnce).toHaveBeenCalledTimes(2);
  });

  it('logs process failures without aborting the sync loop', async () => {
    const processOnce = vi.fn(async () => {
      throw new Error('fixture process failure');
    });
    const logs: string[] = [];
    const postProcessor = createMongoSyncPostProcessor(
      {
        projectPath: '/repo/app',
        processAfterSync: true,
        processIntervalMs: 120_000,
        lockPath: '/tmp/cml-store/vector-worker.lock'
      },
      {
        now: () => 1_000,
        processOnce,
        log: (message) => logs.push(message)
      }
    );

    await expect(postProcessor.afterSync({ pushed: 0, pulled: 1 })).resolves.toBeUndefined();

    expect(processOnce).toHaveBeenCalledTimes(1);
    expect(logs).toContain('[mongo-sync] Process-after-sync failed: fixture process failure');
  });

  it('is a no-op when process-after-sync is disabled', async () => {
    const processOnce = vi.fn(async () => ({ skipped: false, processed: 1 }));
    const postProcessor = createMongoSyncPostProcessor(
      {
        projectPath: '/repo/app',
        processAfterSync: false,
        processIntervalMs: 120_000,
        lockPath: '/tmp/cml-store/vector-worker.lock'
      },
      { processOnce }
    );

    await postProcessor.afterSync({ pushed: 0, pulled: 9 });

    expect(processOnce).not.toHaveBeenCalled();
  });
});

describe('mongo-sync process-after-sync service lifecycle', () => {
  it('creates a fresh one-shot memory service for repeated watch-mode processing', async () => {
    const release = vi.fn();
    const createWorkerLock = vi.fn(() => ({
      acquire: () => ({ acquired: true as const, lockPath: '/tmp/cml-store/vector-worker.lock', pid: 1, ownerId: 'test', staleRecovered: false as const }),
      release
    }));
    const services = [makeService(2), makeService(4)];
    const createMemoryService = vi.fn(() => services.shift()!);

    await processProjectEmbeddingsOnce(
      { projectPath: '/repo/app', lockPath: '/tmp/cml-store/vector-worker.lock' },
      {
        createWorkerLock,
        createMemoryService,
        getProjectStoragePath: () => '/tmp/cml-store',
        hashProjectPath: () => 'project-hash'
      }
    );
    await processProjectEmbeddingsOnce(
      { projectPath: '/repo/app', lockPath: '/tmp/cml-store/vector-worker.lock' },
      {
        createWorkerLock,
        createMemoryService,
        getProjectStoragePath: () => '/tmp/cml-store',
        hashProjectPath: () => 'project-hash'
      }
    );

    expect(createMemoryService).toHaveBeenCalledTimes(2);
    expect(createMemoryService).toHaveBeenCalledWith(expect.objectContaining({
      storagePath: '/tmp/cml-store',
      projectPath: '/repo/app',
      projectHash: 'project-hash',
      sharedStoreConfig: expect.objectContaining({ enabled: false }),
      analyticsEnabled: false
    }));
    expect(services).toHaveLength(0);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('releases the worker lock if one-shot service construction fails', async () => {
    const release = vi.fn();
    const createWorkerLock = vi.fn(() => ({
      acquire: () => ({ acquired: true as const, lockPath: '/tmp/cml-store/vector-worker.lock', pid: 1, ownerId: 'test', staleRecovered: false as const }),
      release
    }));
    const createMemoryService = vi.fn(() => {
      throw new Error('fixture service construction failure');
    });

    await expect(processProjectEmbeddingsOnce(
      { projectPath: '/repo/app', lockPath: '/tmp/cml-store/vector-worker.lock' },
      {
        createWorkerLock,
        createMemoryService,
        getProjectStoragePath: () => '/tmp/cml-store',
        hashProjectPath: () => 'project-hash'
      }
    )).rejects.toThrow('fixture service construction failure');

    expect(release).toHaveBeenCalledTimes(1);
  });
});

function makeService(processed: number) {
  return {
    initialize: vi.fn(async () => undefined),
    recoverStuckOutboxItems: vi.fn(async () => ({
      embedding: { recoveredProcessing: 0, retriedFailed: 0 },
      vector: { recoveredProcessing: 0, retriedFailed: 0 }
    })),
    processPendingEmbeddings: vi.fn(async () => processed),
    shutdown: vi.fn(async () => undefined)
  };
}
