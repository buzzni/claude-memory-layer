import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { VectorStore } from '../../src/core/vector-store.js';
import {
  MemoryStoreResolutionError,
  createReadOnlyDiagnosticsService
} from '../../src/services/read-only-diagnostics-service.js';
import { diffMemoryRootSnapshots, snapshotMemoryRoot } from '../helpers/memory-root-snapshot.js';

async function createStore(homeDir: string, projectHash: string): Promise<string> {
  const storagePath = path.join(homeDir, '.claude-code', 'memory', 'projects', projectHash);
  const store = new SQLiteEventStore(path.join(storagePath, 'events.sqlite'));
  await store.initialize();
  await store.append({
    id: 'event-1',
    eventType: 'user_prompt',
    sessionId: 'session-1',
    timestamp: new Date('2026-08-12T00:00:00.000Z'),
    content: 'read only diagnostics fixture',
    canonicalKey: 'event-1',
    dedupeKey: 'event-1'
  });
  await store.close();
  return storagePath;
}

describe('read-only diagnostics service', () => {
  it('returns an uncached empty reader for a missing store without creating artifacts', async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-diagnostics-missing-'));
    const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
    const before = snapshotMemoryRoot(memoryRoot);
    const first = createReadOnlyDiagnosticsService('abc12345', { homeDir });
    const second = createReadOnlyDiagnosticsService('abc12345', { homeDir });

    expect(first).not.toBe(second);
    expect(first.storeStatus).toBe('missing');
    await expect(first.getStats()).resolves.toEqual({ totalEvents: 0, vectorCount: 0, levelStats: [] });
    await expect(first.getOutboxStats()).resolves.toMatchObject({
      embedding: { pending: 0, failed: 0 },
      vector: { pending: 0, failed: 0 }
    });
    await first.shutdown();
    await second.shutdown();
    expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(memoryRoot))).toEqual([]);
  });

  it('leaves an existing SQLite store unchanged across aggregate reads', async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-diagnostics-existing-'));
    const storagePath = await createStore(homeDir, 'abc12345');
    const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
    const before = snapshotMemoryRoot(memoryRoot);
    const service = createReadOnlyDiagnosticsService('abc12345', { homeDir });

    expect(service.storeStatus).toBe('existing');
    await service.initialize();
    await expect(service.getStats()).resolves.toMatchObject({ totalEvents: 1, vectorCount: 0 });
    await Promise.all([
      service.getOutboxStats(),
      service.getDerivationLiveness(),
      service.getEventTypeCounts(),
      service.getDistinctSessionCount(),
      service.getRecentEvents(5),
      service.getRetrievalTraceStats(),
      service.getRetrievalTelemetryStats(),
      service.getHelpfulnessStats()
    ]);
    await service.shutdown();

    expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(memoryRoot))).toEqual([]);
    expect(snapshotMemoryRoot(storagePath)).not.toHaveProperty('vectors');
  });

  it('counts an existing Lance table without changing its artifacts', async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-diagnostics-vectors-'));
    const storagePath = await createStore(homeDir, 'abc12345');
    const vectorStore = new VectorStore(path.join(storagePath, 'vectors'));
    await vectorStore.upsert({
      id: 'vector-1',
      eventId: 'event-1',
      sessionId: 'session-1',
      eventType: 'user_prompt',
      content: 'vector fixture',
      vector: [0.1, 0.2, 0.3],
      timestamp: '2026-08-12T00:00:00.000Z'
    });
    const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
    const before = snapshotMemoryRoot(memoryRoot);
    const service = createReadOnlyDiagnosticsService('abc12345', { homeDir });

    await expect(service.getStats()).resolves.toMatchObject({ vectorCount: 1 });
    await service.shutdown();

    expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(memoryRoot))).toEqual([]);
  });

  it('does not depend on MemoryService, an embedder, or a service registry', () => {
    const source = readFileSync('src/services/read-only-diagnostics-service.ts', 'utf8');
    expect(source).not.toContain("from './memory-service.js'");
    expect(source).not.toContain('getDefaultEmbedder');
    expect(source).not.toContain('createMemoryServiceRegistry');
  });

  it('fails invalid and corrupt targets with a path-safe classified error', () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-diagnostics-errors-'));
    expect(() => createReadOnlyDiagnosticsService('   ', { homeDir })).toThrowError(
      expect.objectContaining<Partial<MemoryStoreResolutionError>>({ storeStatus: 'invalid' })
    );
  });
});
