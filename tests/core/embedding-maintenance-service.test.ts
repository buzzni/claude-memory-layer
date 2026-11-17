import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import {
  createEmbeddingMaintenanceService,
  type EmbeddingMaintenanceFileSystem
} from '../../src/core/engine/embedding-maintenance-service.js';

function event(id: string, content = `content for ${id}`) {
  return { id, content };
}

/** The current model, for these tests: a vector that depends only on the text. */
const currentModelVector = (text: string) => [text.length, text.charCodeAt(0) || 0, 1];

function createHarness(options?: {
  currentModel?: string;
  vectorCount?: number;
  files?: Record<string, string>;
  workerRunning?: boolean;
  nullWorker?: boolean;
  events?: Array<{ id: string; content: string }>;
  /** Rows the searched vector table returns as its sample; empty means it cannot be checked. */
  storedVectors?: Array<{ content: string; vector: number[] }>;
  /** What the current model makes of a text. */
  embed?: (text: string) => number[];
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
    }),
    sampleRows: vi.fn(async (limit: number) => (options?.storedVectors ?? []).slice(0, limit))
  };
  const embedder = { embed: vi.fn(async (text: string) => ({ vector: (options?.embed ?? currentModelVector)(text) })) };
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
    embedder,
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

/**
 * Regression: a store whose vectors predate embedding-meta.json was treated
 * as "model unknown" on every import, which drops the searched vector table
 * and re-embeds everything. Three real stores had no metadata file; on one,
 * that would have discarded 20,434 searchable vectors the current model had
 * made and queued about an hour of re-embedding.
 */
describe('EmbeddingMaintenanceService legacy vectors without metadata', () => {
  const stored = (text: string, vector = currentModelVector(text)) => ({ content: text, vector });

  it('records the current model instead of migrating when the current model made the stored vectors', async () => {
    const h = createHarness({
      vectorCount: 3,
      events: [event('legacy-1', 'legacy memory')],
      storedVectors: [stored('release workflow'), stored('rollback checkpoint')]
    });

    const result = await h.service.ensureEmbeddingModelForImport();

    expect(result).toEqual({
      changed: false,
      previousModel: null,
      currentModel: 'embedding-model-a',
      enqueued: 0,
      reason: 'verified-legacy-vectors'
    });
    expect(h.calls).toEqual(['initialize']);
    expect(JSON.parse(h.files.get(h.metaPath)!)).toMatchObject({ model: 'embedding-model-a', updatedAt: expect.any(String) });
  });

  it('keeps them in a dry run too, since nothing needs migrating', async () => {
    const h = createHarness({ vectorCount: 3, storedVectors: [stored('release workflow')] });

    const result = await h.service.ensureEmbeddingModelForImport({ autoMigrate: false });

    expect(result).toMatchObject({ changed: false, reason: 'verified-legacy-vectors' });
    expect(h.vectorStore.clearAll).not.toHaveBeenCalled();
  });

  it('still migrates when another model made the stored vectors', async () => {
    const h = createHarness({
      vectorCount: 3,
      events: [event('legacy-1', 'legacy memory')],
      storedVectors: [stored('release workflow', [9, 9, 9])]
    });

    const result = await h.service.ensureEmbeddingModelForImport();

    expect(result).toMatchObject({ changed: true, enqueued: 1, reason: 'legacy-vectors-without-meta' });
    expect(h.calls).toEqual(['initialize', 'clear-vectors', 'clear-outbox', 'enqueue:legacy-1']);
  });

  it('checks only a few stored vectors', async () => {
    const h = createHarness({
      vectorCount: 50,
      storedVectors: Array.from({ length: 50 }, (_, i) => stored(`memory ${i}`))
    });

    await h.service.ensureEmbeddingModelForImport();

    expect(h.vectorStore.sampleRows).toHaveBeenCalledWith(5);
  });
});

describe('VectorStore.sampleRows', () => {
  it('returns text and vector of rows in the searched table', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { VectorStore } = await import('../../src/core/vector-store.js');
    const root = mkdtempSync(path.join(tmpdir(), 'cml-vector-sample-'));
    try {
      const store = new VectorStore(path.join(root, 'vectors'));
      const row = (eventId: string, metadata: Record<string, unknown> = {}) => ({
        id: `vec-${eventId}`, eventId, sessionId: 's', eventType: 'agent_response', content: `text of ${eventId}`,
        vector: [0.1, 0.2, 0.3], timestamp: '2026-08-31T00:00:00.000Z', metadata
      });
      await store.upsertBatch([row('a'), row('b'), row('spare', { itemKind: 'event', embeddingVersion: 'v1' })]);

      const rows = await store.sampleRows(5);

      expect(rows.map((r) => r.content).sort()).toEqual(['text of a', 'text of b']);
      expect(rows[0].vector).toEqual([expect.closeTo(0.1), expect.closeTo(0.2), expect.closeTo(0.3)]);
      await expect(new VectorStore(path.join(root, 'missing'), { readOnly: true, canonicalRoot: root }).sampleRows(5)).resolves.toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
