import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { LeaseRepository } from '../../src/core/operations/lease-repository.js';
import { sqliteAll } from '../../src/core/sqlite-wrapper.js';

const tempDirs: string[] = [];

async function createFixture(): Promise<{ store: SQLiteEventStore; repo: LeaseRepository; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-lease-repo-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  return { store, repo: new LeaseRepository(store.getDatabase()), cleanup: async () => store.close() };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('LeaseRepository', () => {
  it('atomically blocks another holder while an active lease exists', async () => {
    const { repo, cleanup } = await createFixture();
    const now = new Date('2026-05-19T00:00:00Z');

    const first = await repo.acquire({
      targetType: 'action',
      targetId: 'action-1',
      holder: 'agent-a',
      expiresAt: new Date('2026-05-19T00:10:00Z'),
      now,
      actor: 'tester'
    });
    const blocked = await repo.acquire({
      targetType: 'action',
      targetId: 'action-1',
      holder: 'agent-b',
      expiresAt: new Date('2026-05-19T00:20:00Z'),
      now: new Date('2026-05-19T00:01:00Z'),
      actor: 'tester'
    });
    await cleanup();

    expect(first.acquired).toBe(true);
    expect(blocked.acquired).toBe(false);
    expect(blocked.lease.leaseId).toBe(first.lease.leaseId);
    expect(blocked.lease.holder).toBe('agent-a');
  });

  it('prevents a stale expired lease from being renewed after another holder reclaimed the target', async () => {
    const { repo, cleanup } = await createFixture();
    const first = await repo.acquire({
      targetType: 'action',
      targetId: 'action-1',
      holder: 'agent-a',
      expiresAt: new Date('2026-05-19T00:00:01Z'),
      now: new Date('2026-05-19T00:00:00Z'),
      actor: 'tester'
    });
    const reclaimed = await repo.acquire({
      targetType: 'action',
      targetId: 'action-1',
      holder: 'agent-b',
      expiresAt: new Date('2026-05-19T00:05:00Z'),
      now: new Date('2026-05-19T00:02:00Z'),
      actor: 'tester'
    });

    const staleRenew = await repo.renew({
      leaseId: first.lease.leaseId,
      holder: 'agent-a',
      expiresAt: new Date('2026-05-19T00:20:00Z'),
      now: new Date('2026-05-19T00:03:00Z'),
      actor: 'tester'
    });
    const active = await repo.getActiveLease('action', 'action-1', new Date('2026-05-19T00:03:00Z'));
    await cleanup();

    expect(reclaimed.acquired).toBe(true);
    expect(staleRenew).toBeNull();
    expect(active?.leaseId).toBe(reclaimed.lease.leaseId);
    expect(active?.holder).toBe('agent-b');
  });

  it('reclaims expired leases and audits acquire, renew, and release transitions', async () => {
    const { store, repo, cleanup } = await createFixture();
    const first = await repo.acquire({
      targetType: 'action',
      targetId: 'action-1',
      holder: 'agent-a',
      expiresAt: new Date('2026-05-19T00:00:01Z'),
      now: new Date('2026-05-19T00:00:00Z'),
      actor: 'tester'
    });
    const reclaimed = await repo.acquire({
      targetType: 'action',
      targetId: 'action-1',
      holder: 'agent-b',
      expiresAt: new Date('2026-05-19T00:05:00Z'),
      now: new Date('2026-05-19T00:02:00Z'),
      actor: 'tester'
    });
    const renewed = await repo.renew({
      leaseId: reclaimed.lease.leaseId,
      holder: 'agent-b',
      expiresAt: new Date('2026-05-19T00:10:00Z'),
      now: new Date('2026-05-19T00:03:00Z'),
      actor: 'tester'
    });
    const released = await repo.release({ leaseId: reclaimed.lease.leaseId, holder: 'agent-b', actor: 'tester' });
    const releasedAgain = await repo.release({ leaseId: reclaimed.lease.leaseId, holder: 'agent-b', actor: 'tester' });
    const active = await repo.getActiveLease('action', 'action-1', new Date('2026-05-19T00:03:00Z'));
    const auditRows = sqliteAll<Record<string, unknown>>(
      store.getDatabase(),
      `SELECT operation, target_type, target_id, after_json FROM memory_governance_audit WHERE target_type = 'lease' ORDER BY rowid ASC`
    );
    await cleanup();

    expect(first.acquired).toBe(true);
    expect(reclaimed.acquired).toBe(true);
    expect(reclaimed.lease.holder).toBe('agent-b');
    expect(renewed?.expiresAt.toISOString()).toBe('2026-05-19T00:10:00.000Z');
    expect(released).toBe(true);
    expect(releasedAgain).toBe(false);
    expect(active).toBeNull();
    expect(auditRows.map((row) => JSON.parse(String(row.after_json)).transition)).toEqual([
      'acquire',
      'acquire',
      'renew',
      'release'
    ]);
  });
});
