import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteAll, sqliteGet } from '../../src/core/sqlite-wrapper.js';
import { evaluateRetentionPolicy } from '../../src/core/operations/retention-policy.js';
import { RetentionRepository } from '../../src/core/operations/retention-repository.js';

const tempDirs: string[] = [];
const NOW = new Date('2026-05-19T00:00:00.000Z');

async function createFixture(): Promise<{ store: SQLiteEventStore; repo: RetentionRepository; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-retention-repo-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  return { store, repo: new RetentionRepository(store.getDatabase()), cleanup: async () => store.close() };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function retentionResult(overrides: Record<string, unknown> = {}) {
  return evaluateRetentionPolicy({
    targetId: 'event-1',
    targetType: 'event',
    projectHash: 'project-1',
    eventType: 'agent_response',
    memoryLevel: 'L3',
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    lastAccessedAt: new Date('2026-05-18T00:00:00.000Z'),
    retrievalCount: 9,
    helpfulnessScore: 0.7,
    adherenceScore: 0.8,
    evidenceConfidence: 0.9,
    metadata: {},
    facets: [],
    ...overrides
  }, { now: NOW });
}

describe('RetentionRepository', () => {
  it('upserts retention scores idempotently by target, project, and policy version', async () => {
    const { store, repo, cleanup } = await createFixture();

    const first = await repo.upsert({
      ...retentionResult({ targetId: 'event-stable', projectHash: 'project-1' }),
      sourceEventIds: ['source-event-1'],
      actor: 'retention-audit'
    });
    const second = await repo.upsert({
      ...retentionResult({
        targetId: 'event-stable',
        projectHash: 'project-1',
        memoryLevel: 'L0',
        retrievalCount: 0,
        helpfulnessScore: 0,
        adherenceScore: 0,
        evidenceConfidence: 0
      }),
      sourceEventIds: ['source-event-2'],
      actor: 'retention-audit'
    });

    const rows = sqliteAll<Record<string, unknown>>(
      store.getDatabase(),
      `SELECT * FROM memory_retention_scores WHERE target_id = ?`,
      ['event-stable']
    );
    const audits = sqliteAll<Record<string, unknown>>(
      store.getDatabase(),
      `SELECT operation, before_json, after_json, source_event_ids FROM memory_governance_audit WHERE operation = 'retention_score' ORDER BY created_at ASC`,
      []
    );
    await cleanup();

    expect(second.scoreId).toBe(first.scoreId);
    expect(second.decision).not.toBe(first.decision);
    expect(second.sourceEventIds).toEqual(['source-event-2']);
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.createdAt.getTime());
    expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0]?.factors_json))).toMatchObject({ level: expect.any(Number), retrieval: expect.any(Number) });
    expect(JSON.parse(String(rows[0]?.reasons_json))).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: expect.any(String), message: expect.any(String) })
    ]));
    expect(audits).toHaveLength(2);
    expect(audits[0]?.before_json).toBeNull();
    expect(JSON.parse(String(audits[1]?.before_json))).toMatchObject({ scoreId: first.scoreId, decision: first.decision });
    expect(JSON.parse(String(audits[1]?.after_json))).toMatchObject({ scoreId: second.scoreId, decision: second.decision });
    expect(JSON.parse(String(audits[1]?.source_event_ids))).toEqual(['source-event-2']);
  });

  it('keeps identical targets separate across project scopes and requires projectHash', async () => {
    const { repo, cleanup } = await createFixture();

    const projectOne = await repo.upsert({
      ...retentionResult({ targetId: 'shared-event', projectHash: 'project-1' }),
      sourceEventIds: ['event-project-1']
    });
    const projectTwo = await repo.upsert({
      ...retentionResult({ targetId: 'shared-event', projectHash: 'project-2' }),
      sourceEventIds: ['event-project-2']
    });

    const fetchedOne = await repo.getLatestForTarget({ targetType: 'event', targetId: 'shared-event', projectHash: 'project-1' });
    const fetchedTwo = await repo.getLatestForTarget({ targetType: 'event', targetId: 'shared-event', projectHash: 'project-2' });
    const projectOneList = await repo.list({ projectHash: 'project-1' });
    const unscopedWrite = repo.upsert({
      ...retentionResult({ targetId: 'unscoped-event', projectHash: undefined }),
      projectHash: undefined
    });
    await cleanup();

    expect(projectOne.scoreId).not.toBe(projectTwo.scoreId);
    expect(fetchedOne?.scoreId).toBe(projectOne.scoreId);
    expect(fetchedTwo?.scoreId).toBe(projectTwo.scoreId);
    expect(projectOneList.map((score) => score.scoreId)).toEqual([projectOne.scoreId]);
    await expect(unscopedWrite).rejects.toThrow(/projectHash is required/);
  });

  it('lists decision candidates by project without leaking raw factors or reasons across targets', async () => {
    const { repo, cleanup } = await createFixture();

    const tombstone = await repo.upsert({
      ...retentionResult({
        targetId: 'discard-event',
        projectHash: 'project-1',
        facets: [{ dimension: 'retention', value: 'discard', confidence: 1 }]
      }),
      sourceEventIds: ['discard-event']
    });
    await repo.upsert({
      ...retentionResult({
        targetId: 'review-event',
        projectHash: 'project-1',
        metadata: { private: true },
        memoryLevel: 'L0',
        retrievalCount: 0,
        helpfulnessScore: 0,
        adherenceScore: 0,
        evidenceConfidence: 0
      }),
      sourceEventIds: ['review-event']
    });
    await repo.upsert({
      ...retentionResult({
        targetId: 'other-project-discard',
        projectHash: 'project-2',
        facets: [{ dimension: 'retention', value: 'discard', confidence: 1 }]
      }),
      sourceEventIds: ['other-project-discard']
    });

    const candidates = await repo.list({ projectHash: 'project-1', decision: 'tombstone_candidate' });
    await cleanup();

    expect(candidates.map((candidate) => candidate.scoreId)).toEqual([tombstone.scoreId]);
    expect(candidates[0]?.targetId).toBe('discard-event');
    expect(candidates[0]?.reasons.map((reason) => reason.code)).toContain('manual_retention_discard');
    expect(JSON.stringify(candidates[0]?.factors)).not.toContain('review-event');
    expect(candidates.map((candidate) => candidate.projectHash)).toEqual(['project-1']);
  });

  it('rejects explicit projectHash mismatches between wrapper input and policy result', async () => {
    const { store, repo, cleanup } = await createFixture();

    await expect(repo.upsert({
      result: retentionResult({ targetId: 'mismatch-event', projectHash: 'project-1' }),
      projectHash: 'project-2'
    })).rejects.toThrow(/projectHash mismatch/);
    const row = sqliteGet<Record<string, unknown>>(
      store.getDatabase(),
      `SELECT COUNT(*) AS count FROM memory_retention_scores WHERE target_id = ?`,
      ['mismatch-event']
    );
    await cleanup();

    expect(Number(row?.count)).toBe(0);
  });
});
