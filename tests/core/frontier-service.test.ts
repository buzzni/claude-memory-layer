import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { ActionRepository } from '../../src/core/operations/action-repository.js';
import { FacetRepository } from '../../src/core/operations/facet-repository.js';
import { FrontierService } from '../../src/core/operations/frontier-service.js';
import { LeaseRepository } from '../../src/core/operations/lease-repository.js';

const tempDirs: string[] = [];

interface Fixture {
  store: SQLiteEventStore;
  actions: ActionRepository;
  facets: FacetRepository;
  frontier: FrontierService;
  leases: LeaseRepository;
  cleanup: () => Promise<void>;
}

async function createFixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-frontier-service-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  const db = store.getDatabase();
  return {
    store,
    actions: new ActionRepository(db),
    facets: new FacetRepository(db),
    frontier: new FrontierService(db),
    leases: new LeaseRepository(db),
    cleanup: async () => store.close()
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('FrontierService', () => {
  it('ranks project-scoped non-terminal actions with explainable priority, recency, lease, and verified-facet reasons', async () => {
    const { actions, facets, frontier, cleanup } = await createFixture();
    const now = new Date('2026-05-19T12:00:00Z');
    const freshVerified = await actions.upsert({
      projectHash: 'project-1',
      title: 'Fresh verified action',
      priority: 7,
      sourceEventIds: ['event-action-source']
    });
    const older = await actions.upsert({
      projectHash: 'project-1',
      title: 'Older action',
      priority: 9,
      sourceEventIds: ['event-older-source']
    });
    const done = await actions.upsert({ projectHash: 'project-1', title: 'Done action', status: 'done', priority: 100 });
    await actions.upsert({ projectHash: 'project-2', title: 'Other project action', priority: 100 });
    await actions.update({
      actionId: older.actionId,
      projectHash: 'project-1',
      sourceEventIds: ['event-older-source'],
      priority: 9
    });
    await facets.assign({
      targetType: 'action',
      targetId: freshVerified.actionId,
      dimension: 'quality',
      value: 'verified',
      confidence: 0.95,
      projectHash: 'project-1',
      evidenceEventIds: ['event-facet-evidence']
    });

    const frontierItems = await frontier.rank({ projectHash: 'project-1', now, limit: 10 });
    await cleanup();

    expect(frontierItems.map((item) => item.action.title)).toEqual(['Fresh verified action', 'Older action']);
    expect(frontierItems.map((item) => item.action.actionId)).not.toContain(done.actionId);
    expect(frontierItems[0]?.score).toBeGreaterThan(frontierItems[1]?.score ?? 0);
    expect(frontierItems[0]?.reasons).toEqual(expect.arrayContaining([
      'priority:7',
      'recent_update',
      'no_active_lease',
      'quality:verified'
    ]));
    expect(frontierItems[0]?.sourceRefs).toEqual(expect.arrayContaining(['event-action-source', 'event-facet-evidence']));
  });

  it('deprioritizes blocked actions by default and explains blocker edges', async () => {
    const { actions, frontier, cleanup } = await createFixture();
    const blocker = await actions.upsert({ projectHash: 'project-1', title: 'Prerequisite action', priority: 1 });
    const blocked = await actions.upsert({ projectHash: 'project-1', title: 'Blocked high priority action', status: 'blocked', priority: 100 });
    const ready = await actions.upsert({ projectHash: 'project-1', title: 'Ready lower priority action', priority: 10 });
    await actions.addEdge({
      srcActionId: blocked.actionId,
      relType: 'depends_on',
      dstType: 'action',
      dstId: blocker.actionId,
      confidence: 1
    });

    const defaultFrontier = await frontier.rank({ projectHash: 'project-1', now: new Date('2026-05-19T12:00:00Z') });
    const includeBlocked = await frontier.rank({ projectHash: 'project-1', now: new Date('2026-05-19T12:00:00Z'), includeBlocked: true });
    await cleanup();

    expect(defaultFrontier[0]?.action.actionId).toBe(ready.actionId);
    expect(defaultFrontier.map((item) => item.action.actionId)).toContain(blocked.actionId);
    const blockedDefault = defaultFrontier.find((item) => item.action.actionId === blocked.actionId);
    expect(blockedDefault?.reasons).toEqual(expect.arrayContaining(['status:blocked_penalty', 'blocked_by:action']));
    expect(includeBlocked[0]?.action.actionId).toBe(blocked.actionId);
    expect(includeBlocked[0]?.reasons).toContain('status:blocked_included');
  });

  it('does not penalize dependencies that are already completed in the same project', async () => {
    const { actions, frontier, cleanup } = await createFixture();
    const completedPrerequisite = await actions.upsert({
      projectHash: 'project-1',
      title: 'Completed prerequisite',
      status: 'done',
      priority: 1
    });
    const readyHighPriority = await actions.upsert({
      projectHash: 'project-1',
      title: 'Ready high priority action',
      priority: 25
    });
    const readyLowerPriority = await actions.upsert({
      projectHash: 'project-1',
      title: 'Ready lower priority action',
      priority: 10
    });
    await actions.addEdge({
      srcActionId: readyHighPriority.actionId,
      relType: 'depends_on',
      dstType: 'action',
      dstId: completedPrerequisite.actionId,
      confidence: 1
    });

    const frontierItems = await frontier.rank({ projectHash: 'project-1', now: new Date('2026-05-19T12:00:00Z') });
    await cleanup();

    expect(frontierItems[0]?.action.actionId).toBe(readyHighPriority.actionId);
    expect(frontierItems[0]?.score).toBeGreaterThan(frontierItems.find((item) => item.action.actionId === readyLowerPriority.actionId)?.score ?? 0);
    expect(frontierItems[0]?.reasons).not.toContain('blocked_by:action');
  });

  it('penalizes active leases and omits terminal actions by default', async () => {
    const { actions, leases, frontier, cleanup } = await createFixture();
    const now = new Date('2026-05-19T12:00:00Z');
    const leased = await actions.upsert({ projectHash: 'project-1', title: 'Leased action', priority: 50 });
    const available = await actions.upsert({ projectHash: 'project-1', title: 'Available action', priority: 40 });
    await actions.upsert({ projectHash: 'project-1', title: 'Cancelled action', status: 'cancelled', priority: 100 });
    await leases.acquire({
      targetType: 'action',
      targetId: leased.actionId,
      holder: 'other-agent',
      expiresAt: new Date('2026-05-19T12:30:00Z'),
      now,
      actor: 'tester',
      projectHash: 'project-1'
    });

    const frontierItems = await frontier.rank({ projectHash: 'project-1', now, limit: 10 });
    await cleanup();

    expect(frontierItems[0]?.action.actionId).toBe(available.actionId);
    expect(frontierItems.map((item) => item.action.title)).not.toContain('Cancelled action');
    const leasedItem = frontierItems.find((item) => item.action.actionId === leased.actionId);
    expect(leasedItem?.reasons).toEqual(expect.arrayContaining(['active_lease:other-agent']));
  });
});
