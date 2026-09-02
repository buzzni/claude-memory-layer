import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import {
  EdgeHistoryRepo,
  hasEdgeHistoryTable,
  makeEdgeKey
} from '../../src/core/operations/edge-history-repo.js';
import { sqliteExec } from '../../src/core/sqlite-wrapper.js';

const tempDirs: string[] = [];

async function createFixture(): Promise<{ store: SQLiteEventStore; repo: EdgeHistoryRepo }> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-edge-history-repo-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  return { store, repo: new EdgeHistoryRepo(store.getDatabase()) };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('makeEdgeKey', () => {
  it('is deterministic for the same logical relationship', () => {
    const a = makeEdgeKey('entity', 'e1', 'supersedes', 'entity', 'e2');
    const b = makeEdgeKey('entity', 'e1', 'supersedes', 'entity', 'e2');
    expect(a).toBe(b);
    expect(a).toBe('entity|e1|supersedes|entity|e2');
  });
});

describe('EdgeHistoryRepo.recordVersion', () => {
  it('creates the first active version for a new logical edge', async () => {
    const { store, repo } = await createFixture();
    try {
      const row = await repo.recordVersion({
        edgeId: 'edge-1',
        srcType: 'entity',
        srcId: 'a',
        relType: 'evidence_of',
        dstType: 'entity',
        dstId: 'b',
        weight: 0.9,
        sourceEventIds: ['event-1']
      });

      expect(row.status).toBe('active');
      expect(row.weight).toBe(0.9);
      expect(row.supersededByHistoryId).toBeUndefined();
      expect(row.sourceEventIds).toEqual(['event-1']);
    } finally {
      await store.close();
    }
  });

  it('is a NOOP (no new row) when re-recording the same weight with no validTo override', async () => {
    const { store, repo } = await createFixture();
    try {
      const edgeKey = makeEdgeKey('entity', 'a', 'evidence_of', 'entity', 'b');
      const first = await repo.recordVersion({
        edgeId: 'edge-1', srcType: 'entity', srcId: 'a', relType: 'evidence_of', dstType: 'entity', dstId: 'b', weight: 0.9
      });
      const second = await repo.recordVersion({
        edgeId: 'edge-1', srcType: 'entity', srcId: 'a', relType: 'evidence_of', dstType: 'entity', dstId: 'b', weight: 0.9
      });

      expect(second.historyId).toBe(first.historyId);
      const versions = await repo.listByEdgeKey(edgeKey);
      expect(versions).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it('records a new version when only meta_json changed, keeping history in sync with the edges projection', async () => {
    const { store, repo } = await createFixture();
    try {
      const edgeKey = makeEdgeKey('entity', 'a', 'evidence_of', 'entity', 'b');
      await repo.recordVersion({
        edgeId: 'edge-1', srcType: 'entity', srcId: 'a', relType: 'evidence_of', dstType: 'entity', dstId: 'b',
        weight: 0.9, metaJson: { actor: 'agent-a' }
      });
      const second = await repo.recordVersion({
        edgeId: 'edge-1', srcType: 'entity', srcId: 'a', relType: 'evidence_of', dstType: 'entity', dstId: 'b',
        weight: 0.9, metaJson: { actor: 'agent-b' }
      });

      expect(second.metaJson).toMatchObject({ actor: 'agent-b' });
      const versions = await repo.listByEdgeKey(edgeKey);
      expect(versions).toHaveLength(2);
      expect(await repo.getCurrent(edgeKey)).toMatchObject({ metaJson: { actor: 'agent-b' } });
    } finally {
      await store.close();
    }
  });

  it('leaves exactly one active row per edge key after a supersession', async () => {
    const { store, repo } = await createFixture();
    try {
      const edgeKey = makeEdgeKey('entity', 'a', 'evidence_of', 'entity', 'b');
      await repo.recordVersion({
        edgeId: 'edge-1', srcType: 'entity', srcId: 'a', relType: 'evidence_of', dstType: 'entity', dstId: 'b', weight: 0.5
      });
      await repo.recordVersion({
        edgeId: 'edge-1', srcType: 'entity', srcId: 'a', relType: 'evidence_of', dstType: 'entity', dstId: 'b', weight: 0.9
      });

      const versions = await repo.listByEdgeKey(edgeKey);
      expect(versions.filter((v) => v.status === 'active')).toHaveLength(1);
      expect(await repo.getCurrent(edgeKey)).not.toBeNull();
    } finally {
      await store.close();
    }
  });

  it('supersedes the previous active row when the weight changes', async () => {
    const { store, repo } = await createFixture();
    try {
      const edgeKey = makeEdgeKey('entity', 'a', 'evidence_of', 'entity', 'b');
      const first = await repo.recordVersion({
        edgeId: 'edge-1', srcType: 'entity', srcId: 'a', relType: 'evidence_of', dstType: 'entity', dstId: 'b', weight: 0.5
      });
      const second = await repo.recordVersion({
        edgeId: 'edge-1', srcType: 'entity', srcId: 'a', relType: 'evidence_of', dstType: 'entity', dstId: 'b', weight: 0.9
      });

      expect(second.historyId).not.toBe(first.historyId);
      expect(second.status).toBe('active');

      const versions = await repo.listByEdgeKey(edgeKey);
      expect(versions).toHaveLength(2);
      const supersededVersion = versions.find((v) => v.historyId === first.historyId);
      expect(supersededVersion?.status).toBe('superseded');
      expect(supersededVersion?.supersededByHistoryId).toBe(second.historyId);
      expect(supersededVersion?.validTo).toBeDefined();

      const current = await repo.getCurrent(edgeKey);
      expect(current?.historyId).toBe(second.historyId);
    } finally {
      await store.close();
    }
  });
});

describe('EdgeHistoryRepo.selectAsOf', () => {
  it('returns the version whose valid window contains asOf, even after it has since been superseded', async () => {
    const { store, repo } = await createFixture();
    try {
      const edgeKey = makeEdgeKey('entity', 'a', 'evidence_of', 'entity', 'b');
      const early = await repo.recordVersion({
        edgeId: 'edge-1', srcType: 'entity', srcId: 'a', relType: 'evidence_of', dstType: 'entity', dstId: 'b',
        weight: 0.4, validFrom: new Date('2026-01-01T00:00:00.000Z')
      });
      const late = await repo.recordVersion({
        edgeId: 'edge-1', srcType: 'entity', srcId: 'a', relType: 'evidence_of', dstType: 'entity', dstId: 'b',
        weight: 0.9, validFrom: new Date('2026-06-01T00:00:00.000Z')
      });

      const versions = await repo.listByEdgeKey(edgeKey);
      expect(versions.find((version) => version.historyId === early.historyId)?.validTo?.toISOString())
        .toBe('2026-06-01T00:00:00.000Z');
      expect(late.validFrom?.toISOString()).toBe('2026-06-01T00:00:00.000Z');

      const asOfEarly = await repo.selectAsOf({ edgeKey, asOf: new Date('2026-03-01T00:00:00.000Z') });
      expect(asOfEarly?.historyId).toBe(early.historyId);
      expect(asOfEarly?.weight).toBe(0.4);

      const asOfLate = await repo.selectAsOf({ edgeKey, asOf: new Date('2026-09-01T00:00:00.000Z') });
      expect(asOfLate?.weight).toBe(0.9);
    } finally {
      await store.close();
    }
  });

  it('excludes rows committed after knownAt', async () => {
    const { store, repo } = await createFixture();
    try {
      const edgeKey = makeEdgeKey('entity', 'a', 'evidence_of', 'entity', 'b');
      await repo.recordVersion({
        edgeId: 'edge-1', srcType: 'entity', srcId: 'a', relType: 'evidence_of', dstType: 'entity', dstId: 'b', weight: 0.5
      });

      const before = await repo.selectAsOf({ edgeKey, knownAt: new Date('2000-01-01T00:00:00.000Z') });
      expect(before).toBeNull();
    } finally {
      await store.close();
    }
  });

  it('returns null for an edge key with no recorded history', async () => {
    const { store, repo } = await createFixture();
    try {
      const result = await repo.selectAsOf({ edgeKey: makeEdgeKey('entity', 'x', 'evidence_of', 'entity', 'y') });
      expect(result).toBeNull();
    } finally {
      await store.close();
    }
  });
});

describe('hasEdgeHistoryTable', () => {
  it('detects a legacy store missing the edge_history table', async () => {
    const { store } = await createFixture();
    try {
      expect(hasEdgeHistoryTable(store.getDatabase())).toBe(true);
      sqliteExec(store.getDatabase(), `DROP TABLE edge_history`);
      expect(hasEdgeHistoryTable(store.getDatabase())).toBe(false);
    } finally {
      await store.close();
    }
  });
});
