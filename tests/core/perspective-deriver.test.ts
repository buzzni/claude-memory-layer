import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import {
  ActorRepository,
  PerspectiveObservationRepository,
  SessionActorRepository,
  createPerspectiveDeriver
} from '../../src/core/operations/index.js';
import type { MemoryActor, MemoryEvent } from '../../src/core/types.js';

const tempDirs: string[] = [];

function event(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    eventType: 'user_prompt',
    sessionId: 'session-1',
    timestamp: new Date('2026-05-24T00:00:00.000Z'),
    content: 'User prefers TDD and asks agents to continue through verification.',
    canonicalKey: 'canonical-event-1',
    dedupeKey: 'dedupe-event-1',
    metadata: { source: 'discord', displayName: '전하' },
    ...overrides
  };
}

async function createFixture(): Promise<{
  store: SQLiteEventStore;
  actors: ActorRepository;
  sessions: SessionActorRepository;
  observations: PerspectiveObservationRepository;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-perspective-deriver-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  const db = store.getDatabase();
  return {
    store,
    actors: new ActorRepository(db),
    sessions: new SessionActorRepository(db),
    observations: new PerspectiveObservationRepository(db),
    cleanup: async () => store.close()
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('PerspectiveDeriver', () => {
  it('is disabled by default and performs no extraction or writes', async () => {
    const extractor = { extract: vi.fn(async () => [{ content: 'should not run' }]) };
    const actors = { resolveFromEvent: vi.fn() };
    const sessions = { listBySession: vi.fn(), upsertMembership: vi.fn() };
    const observations = { create: vi.fn() };
    const deriver = createPerspectiveDeriver({
      actors: actors as never,
      sessions: sessions as never,
      observations: observations as never,
      extractor
    });

    const result = await deriver.deriveFromEvent(event(), { projectHash: 'project-1' });

    expect(result).toEqual({ status: 'skipped', reason: 'disabled', created: 0, updated: 0 });
    expect(extractor.extract).not.toHaveBeenCalled();
    expect(actors.resolveFromEvent).not.toHaveBeenCalled();
    expect(sessions.listBySession).not.toHaveBeenCalled();
    expect(observations.create).not.toHaveBeenCalled();
  });

  it('extracts before persistence so optional LLM work is outside DB writes', async () => {
    const order: string[] = [];
    const observedActor: MemoryActor = {
      actorId: 'actor:user:founder',
      projectHash: 'project-1',
      kind: 'user',
      displayName: '전하',
      source: 'discord',
      createdAt: new Date('2026-05-24T00:00:00.000Z'),
      updatedAt: new Date('2026-05-24T00:00:00.000Z')
    };
    const actors = {
      resolveFromEvent: vi.fn(async () => observedActor)
    };
    const sessions = {
      listBySession: vi.fn(async () => [
        {
          projectHash: 'project-1',
          sessionId: 'session-1',
          actorId: observedActor.actorId,
          roleInSession: 'speaker',
          observeSelf: true,
          observeOthers: false,
          joinedAt: new Date('2026-05-24T00:00:00.000Z')
        }
      ]),
      upsertMembership: vi.fn(async () => undefined)
    };
    const observations = {
      create: vi.fn(async () => {
        order.push('persist');
        return { observationId: 'saved-observation' };
      })
    };
    const extractor = {
      extract: vi.fn(async () => {
        order.push('extract');
        return [{ content: 'User prefers TDD before implementation.', confidence: 0.8 }];
      })
    };
    const deriver = createPerspectiveDeriver({
      actors: actors as never,
      sessions: sessions as never,
      observations: observations as never,
      extractor,
      config: { enabled: true, deriver: { enabled: true, maxEventsPerBatch: 20, maxObserversPerSession: 5 } }
    });

    const result = await deriver.deriveFromEvent(event(), { projectHash: 'project-1' });

    expect(result.status).toBe('ok');
    expect(order).toEqual(['extract', 'persist']);
    expect(observations.create).toHaveBeenCalledWith(expect.objectContaining({
      projectHash: 'project-1',
      observerActorId: observedActor.actorId,
      observedActorId: observedActor.actorId,
      sourceEventIds: ['11111111-1111-4111-8111-111111111111'],
      createdBy: 'rule'
    }));
  });

  it('redacts sensitive extractor failure details in direct derivation results', async () => {
    const secretKey = ['api', 'token'].join('_');
    const secretValue = ['perspective', 'fixture', 'secret'].join('-');
    const localPath = ['', 'tmp', 'private', 'project'].join('/');
    const extractor = {
      extract: vi.fn(async () => {
        throw new Error(`extractor failed under ${localPath} with ${secretKey}=${secretValue}`);
      })
    };
    const deriver = createPerspectiveDeriver({
      actors: { resolveFromEvent: vi.fn() } as never,
      sessions: { listBySession: vi.fn(), upsertMembership: vi.fn() } as never,
      observations: { create: vi.fn() } as never,
      extractor,
      config: { enabled: true, deriver: { enabled: true, maxEventsPerBatch: 20, maxObserversPerSession: 5 } }
    });

    const result = await deriver.deriveFromEvent(event(), { projectHash: 'project-1' });

    expect(result).toMatchObject({ status: 'failed', reason: 'extract_failed', created: 0, updated: 0 });
    if (result.status === 'failed') {
      expect(result.error).toContain('[REDACTED]');
      expect(result.error).not.toContain(localPath);
      expect(result.error).not.toContain(secretValue);
    }
  });

  it('dedupes generated observations by project, observer, observed, content, and source evidence', async () => {
    const { actors, sessions, observations, cleanup } = await createFixture();
    await actors.upsert({
      actorId: 'actor:assistant:hermes',
      projectHash: 'project-1',
      kind: 'assistant',
      displayName: 'Hermes',
      source: 'test'
    });
    await actors.upsert({
      actorId: 'actor:subagent:reviewer',
      projectHash: 'project-1',
      kind: 'subagent',
      displayName: 'Reviewer',
      source: 'delegate_task'
    });
    await sessions.upsertMembership({
      projectHash: 'project-1',
      sessionId: 'session-1',
      actorId: 'actor:assistant:hermes',
      roleInSession: 'assistant',
      observeOthers: true
    });
    await sessions.upsertMembership({
      projectHash: 'project-1',
      sessionId: 'session-1',
      actorId: 'actor:subagent:reviewer',
      roleInSession: 'observer',
      observeOthers: false
    });
    const extractor = {
      extract: vi.fn(async () => [{
        content: 'User prefers autonomous Continue execution with TDD validation.',
        confidence: 0.86
      }])
    };
    const deriver = createPerspectiveDeriver({
      actors,
      sessions,
      observations,
      extractor,
      config: { enabled: true, deriver: { enabled: true, maxEventsPerBatch: 20, maxObserversPerSession: 5 } }
    });

    await deriver.deriveFromEvent(event(), { projectHash: 'project-1' });
    await deriver.deriveFromEvent(event(), { projectHash: 'project-1' });
    const hermesView = await observations.query({
      projectHash: 'project-1',
      observerActorId: 'actor:assistant:hermes',
      levels: ['explicit'],
      limit: 10
    });
    const reviewerView = await observations.query({
      projectHash: 'project-1',
      observerActorId: 'actor:subagent:reviewer',
      levels: ['explicit'],
      limit: 10
    });
    await cleanup();

    expect(extractor.extract).toHaveBeenCalledTimes(2);
    expect(hermesView).toHaveLength(1);
    expect(hermesView[0].sourceEventIds).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect(hermesView[0].content).toBe('User prefers autonomous Continue execution with TDD validation.');
    expect(reviewerView).toEqual([]);
  });
});
