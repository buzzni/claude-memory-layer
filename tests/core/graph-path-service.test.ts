import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { GraphPathService } from '../../src/core/operations/graph-path-service.js';
import { sqliteRun } from '../../src/core/sqlite-wrapper.js';
import type { NodeType, RelationType } from '../../src/core/types.js';

const tempDirs: string[] = [];

interface EntityFixtureInput {
  entityId: string;
  title: string;
  status?: 'active' | 'deprecated';
}

interface EdgeFixtureInput {
  edgeId: string;
  srcType?: NodeType;
  srcId: string;
  relType: RelationType;
  dstType?: NodeType;
  dstId: string;
  meta?: Record<string, unknown>;
}

async function createFixture(): Promise<{
  store: SQLiteEventStore;
  service: GraphPathService;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-graph-path-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  const service = new GraphPathService(store.getDatabase());
  return { store, service, cleanup: async () => store.close() };
}

function insertEntity(store: SQLiteEventStore, input: EntityFixtureInput): void {
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
      JSON.stringify({ project: 'project-a' }),
      input.title.toLowerCase(),
      input.title,
      now,
      now
    ]
  );
}

function insertEdge(store: SQLiteEventStore, input: EdgeFixtureInput): void {
  sqliteRun(
    store.getDatabase(),
    `INSERT INTO edges (edge_id, src_type, src_id, rel_type, dst_type, dst_id, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.edgeId,
      input.srcType ?? 'entity',
      input.srcId,
      input.relType,
      input.dstType ?? 'entity',
      input.dstId,
      JSON.stringify(input.meta ?? {}),
      new Date('2026-05-20T00:00:00Z').toISOString()
    ]
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('GraphPathService', () => {
  it('expands weighted paths and returns node-name explanations with score contributions', async () => {
    const { store, service, cleanup } = await createFixture();
    insertEntity(store, { entityId: 'alpha', title: 'Alpha Task' });
    insertEntity(store, { entityId: 'beta', title: 'Beta Bridge' });
    insertEntity(store, { entityId: 'gamma', title: 'Gamma Target' });
    insertEntity(store, { entityId: 'delta', title: 'Delta Detour' });
    insertEdge(store, { edgeId: 'alpha-beta', srcId: 'alpha', relType: 'evidence_of', dstId: 'beta', meta: { weight: 1 } });
    insertEdge(store, { edgeId: 'beta-gamma', srcId: 'beta', relType: 'derived_from', dstId: 'gamma', meta: { weight: 0.5 } });
    insertEdge(store, { edgeId: 'alpha-delta', srcId: 'alpha', relType: 'source_of', dstId: 'delta', meta: { weight: 0.25 } });
    insertEdge(store, { edgeId: 'delta-gamma', srcId: 'delta', relType: 'supersedes', dstId: 'gamma', meta: { weight: 1 } });

    const result = service.expand({
      startNodes: [{ type: 'entity', id: 'alpha' }],
      maxHops: 2,
      direction: 'outgoing'
    });
    await cleanup();

    const gamma = result.paths.find(path => path.target.id === 'gamma');
    expect(result.effectiveMaxHops).toBe(2);
    expect(gamma).toBeDefined();
    expect(gamma?.target).toEqual({ type: 'entity', id: 'gamma', name: 'Gamma Target' });
    expect(gamma?.hops).toBe(2);
    expect(gamma?.totalCost).toBeCloseTo(3);
    expect(gamma?.scoreContribution).toBeCloseTo(1 / 3);
    expect(gamma?.steps.map(step => step.relationType)).toEqual(['evidence_of', 'derived_from']);
    expect(gamma?.steps.map(step => [step.from.name, step.to.name])).toEqual([
      ['Alpha Task', 'Beta Bridge'],
      ['Beta Bridge', 'Gamma Target']
    ]);
    expect(gamma?.steps.map(step => step.weight)).toEqual([1, 0.5]);
    expect(gamma?.steps.map(step => step.cost)).toEqual([1, 2]);
    expect(gamma?.steps.map(step => step.scoreContribution)).toEqual([1, 0.5]);
  });

  it('clamps traversal to two hops and uses default weight 0.5 when metadata has no weight', async () => {
    const { store, service, cleanup } = await createFixture();
    insertEntity(store, { entityId: 'alpha', title: 'Alpha Task' });
    insertEntity(store, { entityId: 'beta', title: 'Beta Bridge' });
    insertEntity(store, { entityId: 'gamma', title: 'Gamma Target' });
    insertEntity(store, { entityId: 'omega', title: 'Omega Third Hop' });
    insertEdge(store, { edgeId: 'alpha-beta', srcId: 'alpha', relType: 'evidence_of', dstId: 'beta' });
    insertEdge(store, { edgeId: 'beta-gamma', srcId: 'beta', relType: 'derived_from', dstId: 'gamma' });
    insertEdge(store, { edgeId: 'gamma-omega', srcId: 'gamma', relType: 'supersedes', dstId: 'omega', meta: { weight: 1 } });

    const result = service.expand({
      startNodes: [{ type: 'entity', id: 'alpha' }],
      maxHops: 99,
      direction: 'outgoing'
    });
    await cleanup();

    expect(result.effectiveMaxHops).toBe(2);
    expect(result.paths.some(path => path.target.id === 'omega')).toBe(false);
    const gamma = result.paths.find(path => path.target.id === 'gamma');
    expect(gamma?.hops).toBe(2);
    expect(gamma?.totalCost).toBeCloseTo(4);
    expect(gamma?.scoreContribution).toBeCloseTo(0.25);
    expect(gamma?.steps.map(step => step.weight)).toEqual([0.5, 0.5]);
  });

  it('uses deterministic edge-id tie breaks for equal-cost paths to the same target', async () => {
    const { store, service, cleanup } = await createFixture();
    insertEntity(store, { entityId: 'alpha', title: 'Alpha Task' });
    insertEntity(store, { entityId: 'beta', title: 'Beta Bridge' });
    insertEdge(store, { edgeId: 'z-edge', srcId: 'alpha', relType: 'source_of', dstId: 'beta', meta: { weight: 0.5 } });
    insertEdge(store, { edgeId: 'a-edge', srcId: 'alpha', relType: 'derived_from', dstId: 'beta', meta: { weight: 0.5 } });

    const result = service.expand({
      startNodes: [{ type: 'entity', id: 'alpha' }],
      maxHops: 1,
      direction: 'outgoing'
    });
    await cleanup();

    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]?.steps[0]?.edgeId).toBe('a-edge');
    expect(result.paths[0]?.steps[0]?.relationType).toBe('derived_from');
  });

  it('can traverse incoming edges while preserving relation direction in the explanation', async () => {
    const { store, service, cleanup } = await createFixture();
    insertEntity(store, { entityId: 'query-entity', title: 'Query Entity' });
    insertEdge(store, {
      edgeId: 'entry-query-entity',
      srcType: 'entry',
      srcId: 'event-1',
      relType: 'evidence_of',
      dstType: 'entity',
      dstId: 'query-entity',
      meta: { weight: 0.8 }
    });

    const result = service.expand({
      startNodes: [{ type: 'entity', id: 'query-entity' }],
      maxHops: 1,
      direction: 'incoming'
    });
    await cleanup();

    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]).toMatchObject({
      target: { type: 'entry', id: 'event-1', name: 'event-1' },
      totalCost: 1.25,
      scoreContribution: 0.8
    });
    expect(result.paths[0]?.steps[0]).toMatchObject({
      relationType: 'evidence_of',
      direction: 'incoming',
      edgeId: 'entry-query-entity',
      from: { type: 'entry', id: 'event-1', name: 'event-1' },
      to: { type: 'entity', id: 'query-entity', name: 'Query Entity' },
      weight: 0.8,
      cost: 1.25,
      scoreContribution: 0.8
    });
  });
});
