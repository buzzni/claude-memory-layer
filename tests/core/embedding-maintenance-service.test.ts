import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import {
  createEmbeddingMaintenanceService,
  type EmbeddingMaintenanceFileSystem
} from '../../src/core/engine/embedding-maintenance-service.js';

function event(id: string, content = `content for ${id}`) {
  return { id, content };
}

function createHarness(options?: {
  currentModel?: string;
  vectorCount?: number;
  files?: Record<string, string>;
  workerRunning?: boolean;
  nullWorker?: boolean;
  events?: Array<{ id: string; content: string }>;
}) {
  const storagePath = '/memory-root/project-a';
  const metaPath = path.join(storagePath, 'embedding-meta.json');
  const files = new Map<string, string>(Object.entries(options?.files ?? {}));
  const calls: string[] = [];

  const fileSystem: EmbeddingMaintenanceFileSystem = {
    existsSync: vi.fn((targetPath: string) => files.has(targetPath)),
    readFileSync: vi.fn((targetPath: string) => files.get(targetPath) ?? ''),
    writeFileSync: vi.fn((targetPath: string, content: string) => {
      files.set(targetPath, content);
    })
  };

  const initialize = vi.fn(async () => {
    calls.push('initialize');
  });
  const vectorStore = {
    count: vi.fn(async () => options?.vectorCount ?? 0),
    clearAll: vi.fn(async () => {
      calls.push('clear-vectors');
    })
  };
  const events = options?.events ?? [];
  const eventStore = {
    clearEmbeddingOutbox: vi.fn(async () => {
      calls.push('clear-outbox');
    }),
    getEventsPage: vi.fn(async (limit: number, offset: number) => events.slice(offset, offset + limit)),
    enqueueForEmbedding: vi.fn(async (eventId: string, _content: string) => {
      calls.push(`enqueue:${eventId}`);
    })
  };
  const worker = {
    isRunning: vi.fn(() => options?.workerRunning ?? false),
    stop: vi.fn(() => {
      calls.push('stop-worker');
    }),
    start: vi.fn(() => {
      calls.push('start-worker');
    })
  };

  const service = createEmbeddingMaintenanceService({
    storagePath,
    initialize,
    getEmbeddingModelName: vi.fn(() => options?.currentModel ?? 'embedding-model-a'),
    vectorStore,
    eventStore,
    getVectorWorker: () => (options?.nullWorker ? null : worker),
    fileSystem
  });

  return {
    service,
    storagePath,
    metaPath,
    files,
    calls,
    fileSystem,
    initialize,
    vectorStore,
    eventStore,
    worker
  };
}

describe('EmbeddingMaintenanceService', () => {
  it('initializes embedding metadata when no prior vectors exist', async () => {
    const h = createHarness({ vectorCount: 0 });

    const result = await h.service.ensureEmbeddingModelForImport();

    expect(result).toEqual({
      changed: false,
      previousModel: null,
      currentModel: 'embedding-model-a',
      enqueued: 0,
      reason: 'initialized-meta'
    });
    expect(h.initialize).toHaveBeenCalledTimes(1);
    expect(h.vectorStore.count).toHaveBeenCalledTimes(1);
    expect(h.vectorStore.clearAll).not.toHaveBeenCalled();
    expect(h.eventStore.clearEmbeddingOutbox).not.toHaveBeenCalled();
    expect(JSON.parse(h.files.get(h.metaPath)!)).toMatchObject({
      model: 'embedding-model-a',
      updatedAt: expect.any(String)
    });
  });

  it('returns unchanged when stored metadata already matches the current model', async () => {
    const metaPath = path.join('/memory-root/project-a', 'embedding-meta.json');
    const h = createHarness({
      vectorCount: 5,
      files: {
        [metaPath]: JSON.stringify({ model: 'embedding-model-a', updatedAt: '2026-05-02T00:00:00.000Z' })
      }
    });

    const result = await h.service.ensureEmbeddingModelForImport();

    expect(result).toEqual({
      changed: false,
      previousModel: 'embedding-model-a',
      currentModel: 'embedding-model-a',
      enqueued: 0
    });
    expect(h.fileSystem.writeFileSync).not.toHaveBeenCalled();
    expect(h.vectorStore.clearAll).not.toHaveBeenCalled();
    expect(h.eventStore.clearEmbeddingOutbox).not.toHaveBeenCalled();
  });

  it('reports a dry-run model mismatch without clearing vectors or outbox state', async () => {
    const metaPath = path.join('/memory-root/project-a', 'embedding-meta.json');
    const h = createHarness({
      currentModel: 'embedding-model-b',
      vectorCount: 2,
      files: {
        [metaPath]: JSON.stringify({ model: 'embedding-model-a' })
      }
    });

    const result = await h.service.ensureEmbeddingModelForImport({ autoMigrate: false });

    expect(result).toEqual({
      changed: true,
      previousModel: 'embedding-model-a',
      currentModel: 'embedding-model-b',
      enqueued: 0,
      reason: 'model-mismatch'
    });
    expect(h.vectorStore.clearAll).not.toHaveBeenCalled();
    expect(h.eventStore.clearEmbeddingOutbox).not.toHaveBeenCalled();
    expect(h.eventStore.enqueueForEmbedding).not.toHaveBeenCalled();
  });

  it('reports legacy vectors without metadata as a dry-run migration requirement', async () => {
    const h = createHarness({ vectorCount: 3 });

    const result = await h.service.ensureEmbeddingModelForImport({ autoMigrate: false });

    expect(result).toEqual({
      changed: true,
      previousModel: null,
      currentModel: 'embedding-model-a',
      enqueued: 0,
      reason: 'legacy-vectors-without-meta'
    });
    expect(h.fileSystem.writeFileSync).not.toHaveBeenCalled();
    expect(h.vectorStore.clearAll).not.toHaveBeenCalled();
  });

  it('migrates vectors by clearing indexes, re-enqueueing events, and restarting a running worker', async () => {
    const metaPath = path.join('/memory-root/project-a', 'embedding-meta.json');
    const h = createHarness({
      currentModel: 'embedding-model-b',
      vectorCount: 10,
      workerRunning: true,
      files: {
        [metaPath]: JSON.stringify({ model: 'embedding-model-a' })
      },
      events: [event('e1', 'first memory'), event('e2', 'second memory')]
    });

    const result = await h.service.ensureEmbeddingModelForImport();

    expect(result).toEqual({
      changed: true,
      previousModel: 'embedding-model-a',
      currentModel: 'embedding-model-b',
      enqueued: 2,
      reason: 'model-mismatch'
    });
    expect(h.calls).toEqual([
      'initialize',
      'stop-worker',
      'clear-vectors',
      'clear-outbox',
      'enqueue:e1',
      'enqueue:e2',
      'start-worker'
    ]);
    expect(h.eventStore.getEventsPage).toHaveBeenCalledWith(1000, 0);
    expect(h.eventStore.enqueueForEmbedding).toHaveBeenNthCalledWith(1, 'e1', 'first memory');
    expect(h.eventStore.enqueueForEmbedding).toHaveBeenNthCalledWith(2, 'e2', 'second memory');
    expect(JSON.parse(h.files.get(h.metaPath)!)).toMatchObject({
      model: 'embedding-model-b',
      previousModel: 'embedding-model-a',
      migratedAt: expect.any(String),
      enqueued: 2
    });
  });

  it('auto-migrates legacy vectors without metadata and does not restart an idle worker', async () => {
    const h = createHarness({
      vectorCount: 3,
      workerRunning: false,
      events: [event('legacy-1', 'legacy memory')]
    });

    const result = await h.service.ensureEmbeddingModelForImport();

    expect(result).toEqual({
      changed: true,
      previousModel: null,
      currentModel: 'embedding-model-a',
      enqueued: 1,
      reason: 'legacy-vectors-without-meta'
    });
    expect(h.worker.stop).not.toHaveBeenCalled();
    expect(h.worker.start).not.toHaveBeenCalled();
    expect(h.calls).toEqual(['initialize', 'clear-vectors', 'clear-outbox', 'enqueue:legacy-1']);
    expect(JSON.parse(h.files.get(h.metaPath)!)).toMatchObject({
      model: 'embedding-model-a',
      previousModel: null,
      migratedAt: expect.any(String),
      enqueued: 1
    });
  });

  it('re-enqueues events across page boundaries during migration', async () => {
    const metaPath = path.join('/memory-root/project-a', 'embedding-meta.json');
    const events = Array.from({ length: 1001 }, (_, index) => event(`event-${index + 1}`));
    const h = createHarness({
      currentModel: 'embedding-model-b',
      vectorCount: 1001,
      files: {
        [metaPath]: JSON.stringify({ model: 'embedding-model-a' })
      },
      events
    });

    const result = await h.service.ensureEmbeddingModelForImport();

    expect(result.enqueued).toBe(1001);
    expect(h.eventStore.getEventsPage).toHaveBeenNthCalledWith(1, 1000, 0);
    expect(h.eventStore.getEventsPage).toHaveBeenNthCalledWith(2, 1000, 1000);
    expect(h.eventStore.getEventsPage).toHaveBeenCalledTimes(2);
    expect(h.eventStore.enqueueForEmbedding).toHaveBeenCalledTimes(1001);
    expect(h.eventStore.enqueueForEmbedding).toHaveBeenNthCalledWith(1001, 'event-1001', 'content for event-1001');
  });

  it('migrates without worker lifecycle calls when no vector worker is available', async () => {
    const metaPath = path.join('/memory-root/project-a', 'embedding-meta.json');
    const h = createHarness({
      currentModel: 'embedding-model-b',
      vectorCount: 1,
      nullWorker: true,
      files: {
        [metaPath]: JSON.stringify({ model: 'embedding-model-a' })
      },
      events: [event('e1')]
    });

    const result = await h.service.ensureEmbeddingModelForImport();

    expect(result.enqueued).toBe(1);
    expect(h.calls).toEqual(['initialize', 'clear-vectors', 'clear-outbox', 'enqueue:e1']);
    expect(h.worker.isRunning).not.toHaveBeenCalled();
    expect(h.worker.stop).not.toHaveBeenCalled();
    expect(h.worker.start).not.toHaveBeenCalled();
  });
});
