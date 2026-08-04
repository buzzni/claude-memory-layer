import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { TemporalGraphService } from '../../src/core/operations/temporal-graph-service.js';
import { EdgeHistoryRepo } from '../../src/core/operations/edge-history-repo.js';
import { sqliteExec, sqliteRun } from '../../src/core/sqlite-wrapper.js';
import type { NodeType, RelationType } from '../../src/core/types.js';

const tempDirs: string[] = [];

async function createFixture(): Promise<{
  store: SQLiteEventStore;
  service: TemporalGraphService;
  edgeHistory: EdgeHistoryRepo;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-temporal-graph-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  return {
    store,
    service: new TemporalGraphService(store.getDatabase()),
    edgeHistory: new EdgeHistoryRepo(store.getDatabase())
  };
}

function insertEntity(store: SQLiteEventStore, input: { entityId: string; title: string; status?: 'active' | 'deprecated' }): void {
  const now = new Date('2026-05-20T00:00:00Z').toISOString();
  sqliteRun(
    store.getDatabase(),
    `INSERT INTO entities (
      entity_id, entity_type, canonical_key, title, stage, status,
      current_json, title_norm, search_text, created_at, updated_at
    ) VALUES (?, 'task', ?, ?, 'verified', ?, ?, ?, ?, ?, ?)`,
    [
      input.entityId,
      `task:${input.entityId}`,
      input.title,
      input.status ?? 'active',
      JSON.stringify({}),
      input.title.toLowerCase(),
      input.title,
      now,
      now
    ]
  );
}

async function recordEdge(
  edgeHistory: EdgeHistoryRepo,
  input: {
    edgeId: string;
    srcId: string;
    relType: RelationType;
    dstId: string;
    weight?: number;
    validFrom?: Date;
    srcType?: NodeType;
    dstType?: NodeType;
  }
): Promise<void> {
  await edgeHistory.recordVersion({
    edgeId: input.edgeId,
    srcType: input.srcType ?? 'entity',
    srcId: input.srcId,
    relType: input.relType,
    dstType: input.dstType ?? 'entity',
    dstId: input.dstId,
    weight: input.weight,
    validFrom: input.validFrom
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('TemporalGraphService', () => {
  it('returns the current graph state when asOf/knownAt are omitted', async () => {
    const { store, service, edgeHistory } = await createFixture();
    try {
      insertEntity(store, { entityId: 'alpha', title: 'Alpha' });
      insertEntity(store, { entityId: 'beta', title: 'Beta' });
      await recordEdge(edgeHistory, { edgeId: 'e1', srcId: 'alpha', relType: 'evidence_of', dstId: 'beta', weight: 0.9 });

      const result = service.expand({ startNodes: [{ type: 'entity', id: 'alpha' }], maxHops: 1, direction: 'outgoing' });

      expect(result.supported).toBe(true);
      expect(result.paths).toHaveLength(1);
      expect(result.paths[0]).toMatchObject({ target: { id: 'beta', name: 'Beta' }, hops: 1 });
    } finally {
      await store.close();
    }
  });

  it('reconstructs a past state through supersession: asOf before/after the change returns different weights/targets', async () => {
    const { store, service, edgeHistory } = await createFixture();
    try {
      insertEntity(store, { entityId: 'alpha', title: 'Alpha' });
      insertEntity(store, { entityId: 'beta', title: 'Beta' });

      await recordEdge(edgeHistory, {
        edgeId: 'e1', srcId: 'alpha', relType: 'evidence_of', dstId: 'beta',
        weight: 0.4, validFrom: new Date('2026-01-01T00:00:00.000Z')
      });
      await recordEdge(edgeHistory, {
        edgeId: 'e1', srcId: 'alpha', relType: 'evidence_of', dstId: 'beta',
        weight: 0.9, validFrom: new Date('2026-06-01T00:00:00.000Z')
      });

      const past = service.expand({
        startNodes: [{ type: 'entity', id: 'alpha' }],
        asOf: new Date('2026-03-01T00:00:00.000Z'),
        maxHops: 1,
        direction: 'outgoing'
      });
      const present = service.expand({
        startNodes: [{ type: 'entity', id: 'alpha' }],
        asOf: new Date('2026-09-01T00:00:00.000Z'),
        maxHops: 1,
        direction: 'outgoing'
      });

      expect(past.paths[0]?.steps[0]?.weight).toBe(0.4);
      expect(present.paths[0]?.steps[0]?.weight).toBe(0.9);
    } finally {
      await store.close();
    }
  });

  it('excludes edges committed after knownAt', async () => {
    const { store, service, edgeHistory } = await createFixture();
    try {
      insertEntity(store, { entityId: 'alpha', title: 'Alpha' });
      insertEntity(store, { entityId: 'beta', title: 'Beta' });
      await recordEdge(edgeHistory, { edgeId: 'e1', srcId: 'alpha', relType: 'evidence_of', dstId: 'beta', weight: 0.9 });

      const result = service.expand({
        startNodes: [{ type: 'entity', id: 'alpha' }],
        knownAt: new Date('2000-01-01T00:00:00.000Z'),
        maxHops: 1,
        direction: 'outgoing'
      });

      expect(result.paths).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it('excludes edges touching a superseded entity, matching current-graph GraphPathService behavior', async () => {
    const { store, service, edgeHistory } = await createFixture();
    try {
      insertEntity(store, { entityId: 'alpha', title: 'Alpha' });
      insertEntity(store, { entityId: 'beta', title: 'Beta', status: 'deprecated' });
      await recordEdge(edgeHistory, { edgeId: 'e1', srcId: 'alpha', relType: 'evidence_of', dstId: 'beta', weight: 0.9 });

      const result = service.expand({ startNodes: [{ type: 'entity', id: 'alpha' }], maxHops: 1, direction: 'outgoing' });

      expect(result.paths).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it('returns supported: false and no crash on a legacy store missing edge_history', async () => {
    const { store, service } = await createFixture();
    try {
      insertEntity(store, { entityId: 'alpha', title: 'Alpha' });
      sqliteExec(store.getDatabase(), `DROP TABLE edge_history`);

      const result = service.expand({ startNodes: [{ type: 'entity', id: 'alpha' }], asOf: new Date(), maxHops: 1 });

      expect(result.supported).toBe(false);
      expect(result.paths).toEqual([]);
    } finally {
      await store.close();
    }
  });
});
