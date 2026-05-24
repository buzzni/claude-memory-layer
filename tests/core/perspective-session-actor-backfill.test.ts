import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { ActorRepository, SessionActorRepository } from '../../src/core/operations/index.js';
import { backfillPerspectiveSessionActors } from '../../src/core/operations/perspective-session-actor-backfill.js';

const tempDirs: string[] = [];

async function createStore(): Promise<{ store: SQLiteEventStore; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-perspective-actor-backfill-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  return {
    store,
    cleanup: async () => store.close()
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('perspective session actor backfill', () => {
  it('dry-runs existing events without mutating actors or memberships and reports privacy-safe samples', async () => {
    const { store, cleanup } = await createStore();
    await store.append({
      eventType: 'user_prompt',
      sessionId: 'session-alpha',
      timestamp: new Date('2026-05-01T00:00:00Z'),
      content: 'RAW USER CONTENT SHOULD NOT APPEAR IN REPORT',
      metadata: {
        source: 'discord',
        userName: 'raw-platform-user-12345',
        privateMarker: 'fixture-sensitive-marker-should-not-appear'
      }
    });
    await store.append({
      eventType: 'agent_response',
      sessionId: 'session-alpha',
      timestamp: new Date('2026-05-01T00:01:00Z'),
      content: 'RAW ASSISTANT CONTENT SHOULD NOT APPEAR IN REPORT',
      metadata: { source: 'hermes', assistantName: 'Hermes' }
    });

    const result = await backfillPerspectiveSessionActors(store.getDatabase(), {
      projectHash: 'project-alpha',
      dryRun: true,
      sampleLimit: 5
    });
    const actors = await new ActorRepository(store.getDatabase()).list({ projectHash: 'project-alpha', limit: 20 });
    const members = await new SessionActorRepository(store.getDatabase()).listBySession({
      projectHash: 'project-alpha',
      sessionId: 'session-alpha',
      limit: 20
    });
    await cleanup();

    expect(result).toMatchObject({
      dryRun: true,
      projectHash: 'project-alpha',
      scannedEvents: 2,
      scannedSessions: 1,
      existingActors: 0,
      actorsCreated: 0,
      actorsWouldCreate: 2,
      existingMemberships: 0,
      membershipsCreated: 0,
      membershipsWouldCreate: 2
    });
    expect(result.samples).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'would-create', eventId: expect.any(String), sessionId: 'session-alpha', roleInSession: 'speaker', actorKind: 'user' }),
      expect.objectContaining({ action: 'would-create', eventId: expect.any(String), sessionId: 'session-alpha', roleInSession: 'assistant', actorKind: 'assistant' })
    ]));
    expect(actors).toHaveLength(0);
    expect(members).toHaveLength(0);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('RAW USER CONTENT');
    expect(serialized).not.toContain('RAW ASSISTANT CONTENT');
    expect(serialized).not.toContain('raw-platform-user-12345');
    expect(serialized).not.toContain('fixture-sensitive-marker-should-not-appear');
  });

  it('skips quarantined and foreign-scoped events so repair does not revive cross-project contamination', async () => {
    const { store, cleanup } = await createStore();
    await store.append({
      eventType: 'user_prompt',
      sessionId: 'session-alpha',
      timestamp: new Date('2026-05-01T00:00:00Z'),
      content: 'Valid project event.',
      metadata: { source: 'discord', displayName: 'Founder' }
    });
    await store.append({
      eventType: 'agent_response',
      sessionId: 'session-foreign',
      timestamp: new Date('2026-05-01T00:01:00Z'),
      content: 'Quarantined foreign event should not be backfilled.',
      metadata: {
        source: 'foreign-agent',
        assistantName: 'Foreign Assistant',
        quarantine: { status: 'active', reason: 'project-path-mismatch' }
      }
    });
    await store.append({
      eventType: 'agent_response',
      sessionId: 'session-foreign-scoped',
      timestamp: new Date('2026-05-01T00:02:00Z'),
      content: 'Unquarantined foreign scoped event should not be backfilled.',
      metadata: {
        source: 'foreign-agent',
        assistantName: 'Scoped Foreign Assistant',
        scope: { project: { hash: 'foreign-project' } }
      }
    });

    const result = await backfillPerspectiveSessionActors(store.getDatabase(), {
      projectHash: 'project-alpha',
      dryRun: true,
      sampleLimit: 10
    });
    await cleanup();

    expect(result).toMatchObject({
      scannedEvents: 1,
      scannedSessions: 1,
      actorsWouldCreate: 1,
      membershipsWouldCreate: 1
    });
    expect(JSON.stringify(result)).not.toContain('session-foreign');
    expect(JSON.stringify(result)).not.toContain('Foreign Assistant');
    expect(JSON.stringify(result)).not.toContain('session-foreign-scoped');
    expect(JSON.stringify(result)).not.toContain('Scoped Foreign Assistant');
  });

  it('applies idempotent actor and session membership backfill with observer defaults', async () => {
    const { store, cleanup } = await createStore();
    await store.append({
      eventType: 'user_prompt',
      sessionId: 'session-alpha',
      timestamp: new Date('2026-05-01T00:00:00Z'),
      content: 'User asks for autonomous implementation.',
      metadata: { source: 'discord', displayName: 'Founder' }
    });
    await store.append({
      eventType: 'agent_response',
      sessionId: 'session-alpha',
      timestamp: new Date('2026-05-01T00:01:00Z'),
      content: 'Assistant implements with tests.',
      metadata: { source: 'hermes', assistantName: 'Hermes' }
    });
    await store.append({
      eventType: 'tool_observation',
      sessionId: 'session-alpha',
      timestamp: new Date('2026-05-01T00:02:00Z'),
      content: 'Tool output.',
      metadata: { source: 'terminal', toolName: 'terminal' }
    });

    const first = await backfillPerspectiveSessionActors(store.getDatabase(), {
      projectHash: 'project-alpha',
      dryRun: false,
      sampleLimit: 10
    });
    const second = await backfillPerspectiveSessionActors(store.getDatabase(), {
      projectHash: 'project-alpha',
      dryRun: false,
      sampleLimit: 10
    });
    const actors = await new ActorRepository(store.getDatabase()).list({ projectHash: 'project-alpha', limit: 20 });
    const members = await new SessionActorRepository(store.getDatabase()).listBySession({
      projectHash: 'project-alpha',
      sessionId: 'session-alpha',
      limit: 20
    });
    await cleanup();

    expect(first).toMatchObject({
      dryRun: false,
      scannedEvents: 3,
      scannedSessions: 1,
      actorsCreated: 3,
      membershipsCreated: 3,
      membershipsWouldCreate: 0
    });
    expect(second).toMatchObject({
      dryRun: false,
      scannedEvents: 3,
      scannedSessions: 1,
      actorsCreated: 0,
      membershipsCreated: 0,
      existingActors: 3,
      existingMemberships: 3
    });
    expect(actors.map((actor) => actor.kind).sort()).toEqual(['assistant', 'tool', 'user']);
    expect(members.map((member) => [member.roleInSession, member.observeSelf, member.observeOthers]).sort()).toEqual([
      ['assistant', true, true],
      ['speaker', true, false],
      ['tool', false, false]
    ]);
  });
});
