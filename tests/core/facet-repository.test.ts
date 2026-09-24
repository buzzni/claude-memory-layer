import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteAll } from '../../src/core/sqlite-wrapper.js';
import { FacetRepository } from '../../src/core/operations/facet-repository.js';

const tempDirs: string[] = [];

async function createRepo(): Promise<{ store: SQLiteEventStore; repo: FacetRepository; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-facet-repo-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  const repo = new FacetRepository(store.getDatabase());
  return {
    store,
    repo,
    cleanup: async () => {
      await store.close();
    }
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('FacetRepository', () => {
  it('assigns a normalized facet and idempotently updates the existing assignment', async () => {
    const { repo, cleanup } = await createRepo();

    const first = await repo.assign({
      targetType: 'event',
      targetId: ' event-1 ',
      dimension: 'kind',
      value: ' debugging ',
      confidence: 0.7,
      source: 'manual',
      evidenceEventIds: [' ev-1 ', ''],
      projectHash: ' project-1 '
    });

    const second = await repo.assign({
      targetType: 'event',
      targetId: 'event-1',
      dimension: 'kind',
      value: 'debugging',
      confidence: 0.9,
      source: 'manual',
      evidenceEventIds: ['ev-2'],
      projectHash: 'project-1'
    });

    const facets = await repo.listForTarget('event', 'event-1');
    await cleanup();

    expect(first.targetId).toBe('event-1');
    expect(first.value).toBe('debugging');
    expect(first.evidenceEventIds).toEqual(['ev-1']);
    expect(first.projectHash).toBe('project-1');
    expect(second.id).toBe(first.id);
    expect(second.confidence).toBe(0.9);
    expect(second.evidenceEventIds).toEqual(['ev-2']);
    expect(facets).toHaveLength(1);
    expect(facets[0]?.id).toBe(first.id);
  });

  it('queries facets by project, dimension, and value ordered by confidence', async () => {
    const { repo, cleanup } = await createRepo();

    await repo.assign({ targetType: 'event', targetId: 'event-low', dimension: 'kind', value: 'debugging', confidence: 0.4, projectHash: 'project-1' });
    await repo.assign({ targetType: 'event', targetId: 'event-high', dimension: 'kind', value: 'debugging', confidence: 0.9, projectHash: 'project-1' });
    await repo.assign({ targetType: 'event', targetId: 'event-workflow', dimension: 'workflow', value: 'release', confidence: 1, projectHash: 'project-1' });
    await repo.assign({ targetType: 'event', targetId: 'event-other-project', dimension: 'kind', value: 'debugging', confidence: 1, projectHash: 'project-2' });

    const results = await repo.query({ projectHash: 'project-1', dimension: 'kind', value: 'debugging' });
    await cleanup();

    expect(results.map((facet) => facet.targetId)).toEqual(['event-high', 'event-low']);
  });

  it('keeps identical facet assignments separate across project scopes', async () => {
    const { repo, cleanup } = await createRepo();

    const projectOne = await repo.assign({ targetType: 'event', targetId: 'event-shared', dimension: 'kind', value: 'debugging', confidence: 0.4, projectHash: 'project-1' });
    const projectTwo = await repo.assign({ targetType: 'event', targetId: 'event-shared', dimension: 'kind', value: 'debugging', confidence: 0.9, projectHash: 'project-2' });
    const unscoped = await repo.assign({ targetType: 'event', targetId: 'event-shared', dimension: 'kind', value: 'debugging', confidence: 0.6 });

    const projectOneResults = await repo.query({ projectHash: 'project-1', targetType: 'event', targetId: 'event-shared', dimension: 'kind', value: 'debugging' });
    const projectTwoResults = await repo.query({ projectHash: 'project-2', targetType: 'event', targetId: 'event-shared', dimension: 'kind', value: 'debugging' });
    const allResults = await repo.query({ targetType: 'event', targetId: 'event-shared', dimension: 'kind', value: 'debugging' });
    await cleanup();

    expect(new Set([projectOne.id, projectTwo.id, unscoped.id])).toHaveProperty('size', 3);
    expect(projectOneResults.map((facet) => facet.id)).toEqual([projectOne.id]);
    expect(projectTwoResults.map((facet) => facet.id)).toEqual([projectTwo.id]);
    expect(allResults.map((facet) => facet.id).sort()).toEqual([projectOne.id, projectTwo.id, unscoped.id].sort());
  });

  it('writes a governance audit row when assignment actor is supplied', async () => {
    const { store, repo, cleanup } = await createRepo();

    const facet = await repo.assign({
      targetType: 'event',
      targetId: 'event-audited',
      dimension: 'kind',
      value: 'debugging',
      confidence: 1,
      actor: 'cml-cli',
      projectHash: 'project-1',
      evidenceEventIds: ['source-event-1']
    });

    const rows = sqliteAll<Record<string, unknown>>(
      store.getDatabase(),
      `SELECT * FROM memory_governance_audit WHERE target_type = ? AND target_id = ?`,
      ['event', 'event-audited']
    );
    await cleanup();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.operation).toBe('facet_tag');
    expect(rows[0]?.actor).toBe('cml-cli');
    expect(rows[0]?.project_hash).toBe('project-1');
    expect(JSON.parse(String(rows[0]?.source_event_ids))).toEqual(['source-event-1']);
    expect(JSON.parse(String(rows[0]?.after_json))).toMatchObject({ id: facet.id, dimension: 'kind', value: 'debugging' });
  });

  it('removes facets idempotently and respects project scope when supplied', async () => {
    const { repo, cleanup } = await createRepo();

    await repo.assign({ targetType: 'entity', targetId: 'entity-1', dimension: 'quality', value: 'verified', projectHash: 'project-1' });

    const mismatchRemoved = await repo.remove({ targetType: 'entity', targetId: 'entity-1', dimension: 'quality', value: 'verified', projectHash: 'project-2' });
    const removed = await repo.remove({ targetType: 'entity', targetId: 'entity-1', dimension: 'quality', value: 'verified', projectHash: 'project-1' });
    const removedAgain = await repo.remove({ targetType: 'entity', targetId: 'entity-1', dimension: 'quality', value: 'verified', projectHash: 'project-1' });
    const facets = await repo.listForTarget('entity', 'entity-1');
    await cleanup();

    expect(mismatchRemoved).toBe(false);
    expect(removed).toBe(true);
    expect(removedAgain).toBe(false);
    expect(facets).toEqual([]);
  });

  it('removes only the unscoped assignment when project scope is omitted', async () => {
    const { repo, cleanup } = await createRepo();

    const scoped = await repo.assign({ targetType: 'entity', targetId: 'entity-shared', dimension: 'quality', value: 'verified', projectHash: 'project-1' });
    const unscoped = await repo.assign({ targetType: 'entity', targetId: 'entity-shared', dimension: 'quality', value: 'verified' });

    const removed = await repo.remove({ targetType: 'entity', targetId: 'entity-shared', dimension: 'quality', value: 'verified' });
    const facets = await repo.listForTarget('entity', 'entity-shared');
    await cleanup();

    expect(removed).toBe(true);
    expect(facets.map((facet) => facet.id)).toEqual([scoped.id]);
    expect(facets.map((facet) => facet.id)).not.toContain(unscoped.id);
  });
});
