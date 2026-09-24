import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { EdgeRepo } from '../../src/core/edge-repo.js';
import { EdgeHistoryRepo, makeEdgeKey } from '../../src/core/operations/edge-history-repo.js';

const tempDirs: string[] = [];

async function createFixture(): Promise<{ store: SQLiteEventStore; edges: EdgeRepo; edgeHistory: EdgeHistoryRepo }> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-edge-repo-history-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  return {
    store,
    edges: new EdgeRepo(store.getDatabase()),
    edgeHistory: new EdgeHistoryRepo(store.getDatabase())
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('EdgeRepo history recording (docs/graph-temporal-edge-spike.md)', () => {
  it('records a bitemporal history row for every edge created via EdgeRepo.create', async () => {
    const { store, edges, edgeHistory } = await createFixture();
    try {
      await edges.create({
        srcType: 'entity', srcId: 'a', relType: 'evidence_of', dstType: 'entity', dstId: 'b',
        metaJson: { weight: 0.8 }
      });

      const edgeKey = makeEdgeKey('entity', 'a', 'evidence_of', 'entity', 'b');
      const current = await edgeHistory.getCurrent(edgeKey);
      expect(current?.weight).toBe(0.8);
    } finally {
      await store.close();
    }
  });

  it('records a new history version when EdgeRepo.upsert changes the edge weight', async () => {
    const { store, edges, edgeHistory } = await createFixture();
    try {
      await edges.upsert({
        srcType: 'entity', srcId: 'a', relType: 'evidence_of', dstType: 'entity', dstId: 'b',
        metaJson: { weight: 0.5 }
      });
      await edges.upsert({
        srcType: 'entity', srcId: 'a', relType: 'evidence_of', dstType: 'entity', dstId: 'b',
        metaJson: { weight: 0.9 }
      });

      const edgeKey = makeEdgeKey('entity', 'a', 'evidence_of', 'entity', 'b');
      const versions = await edgeHistory.listByEdgeKey(edgeKey);
      expect(versions).toHaveLength(2);
      expect(versions.find((v) => v.status === 'active')?.weight).toBe(0.9);
      expect(versions.find((v) => v.status === 'superseded')?.weight).toBe(0.5);
    } finally {
      await store.close();
    }
  });
});
