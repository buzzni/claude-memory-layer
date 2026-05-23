import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import {
  ActorCardRepository,
  ActorRepository,
  PerspectiveObservationRepository,
  SessionActorRepository
} from '../../src/core/operations/index.js';

const tempDirs: string[] = [];

async function createFixture(): Promise<{
  store: SQLiteEventStore;
  actors: ActorRepository;
  sessions: SessionActorRepository;
  cards: ActorCardRepository;
  observations: PerspectiveObservationRepository;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-perspective-scenario-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  const db = store.getDatabase();
  return {
    store,
    actors: new ActorRepository(db),
    sessions: new SessionActorRepository(db),
    cards: new ActorCardRepository(db),
    observations: new PerspectiveObservationRepository(db),
    cleanup: async () => store.close()
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Perspective memory multi-actor scenarios', () => {
  it('keeps observer-specific actor cards, session observations, and project lanes isolated', async () => {
    const { actors, sessions, cards, observations, cleanup } = await createFixture();

    const user = await actors.upsert({
      actorId: 'actor:user:founder',
      projectHash: 'project-alpha',
      kind: 'user',
      displayName: '전하',
      source: 'discord',
      metadata: { role: 'founder' }
    });
    const assistant = await actors.upsert({
      actorId: 'actor:assistant:hermes',
      projectHash: 'project-alpha',
      kind: 'assistant',
      displayName: 'Hermes',
      source: 'hermes'
    });
    const reviewer = await actors.upsert({
      actorId: 'actor:subagent:reviewer',
      projectHash: 'project-alpha',
      kind: 'subagent',
      displayName: 'Reviewer',
      source: 'delegate_task'
    });
    const betaUser = await actors.upsert({
      actorId: 'actor:user:founder:beta',
      projectHash: 'project-beta',
      kind: 'user',
      displayName: '전하 beta',
      source: 'discord'
    });

    await sessions.upsertMembership({
      projectHash: 'project-alpha',
      sessionId: 'session-alpha',
      actorId: user.actorId,
      roleInSession: 'speaker',
      observeSelf: true,
      observeOthers: false
    });
    await sessions.upsertMembership({
      projectHash: 'project-alpha',
      sessionId: 'session-alpha',
      actorId: assistant.actorId,
      roleInSession: 'assistant',
      observeSelf: true,
      observeOthers: true
    });
    await sessions.upsertMembership({
      projectHash: 'project-alpha',
      sessionId: 'session-alpha',
      actorId: reviewer.actorId,
      roleInSession: 'observer',
      observeSelf: false,
      observeOthers: true
    });
    await sessions.upsertMembership({
      projectHash: 'project-beta',
      sessionId: 'session-beta',
      actorId: betaUser.actorId,
      roleInSession: 'speaker'
    });

    await cards.upsert({
      projectHash: 'project-alpha',
      observerActorId: assistant.actorId,
      observedActorId: user.actorId,
      entries: [
        'IDENTITY: founder and primary user',
        'INSTRUCTION: prefers TDD and autonomous Continue execution'
      ],
      sourceEventIds: ['event-alpha-1'],
      updatedBy: assistant.actorId
    });
    await cards.upsert({
      projectHash: 'project-alpha',
      observerActorId: reviewer.actorId,
      observedActorId: user.actorId,
      entries: ['ATTRIBUTE: reviewer sees only QA expectations'],
      sourceEventIds: ['event-reviewer-1'],
      updatedBy: reviewer.actorId
    });
    await cards.upsert({
      projectHash: 'project-beta',
      observerActorId: assistant.actorId,
      observedActorId: betaUser.actorId,
      entries: ['ATTRIBUTE: beta project only signal'],
      sourceEventIds: ['event-beta-1'],
      updatedBy: assistant.actorId
    });

    const explicit = await observations.create({
      projectHash: 'project-alpha',
      observerActorId: assistant.actorId,
      observedActorId: user.actorId,
      sessionId: 'session-alpha',
      level: 'explicit',
      content: 'User asked Hermes to implement plans with TDD.',
      confidence: 0.93,
      sourceEventIds: ['event-alpha-1'],
      createdBy: 'manual',
      actor: assistant.actorId
    });
    await observations.create({
      projectHash: 'project-alpha',
      observerActorId: assistant.actorId,
      observedActorId: user.actorId,
      level: 'deductive',
      content: 'Continue requests imply validation and concise progress reporting.',
      confidence: 0.81,
      sourceObservationIds: [explicit.observationId],
      createdBy: 'llm',
      actor: assistant.actorId
    });
    await observations.create({
      projectHash: 'project-alpha',
      observerActorId: reviewer.actorId,
      observedActorId: user.actorId,
      sessionId: 'session-alpha',
      level: 'explicit',
      content: 'Reviewer-only QA expectation should not appear in Hermes lane.',
      confidence: 0.88,
      sourceEventIds: ['event-reviewer-1'],
      createdBy: 'manual',
      actor: reviewer.actorId
    });
    await observations.create({
      projectHash: 'project-alpha',
      observerActorId: assistant.actorId,
      observedActorId: user.actorId,
      sessionId: 'session-other',
      level: 'explicit',
      content: 'Other session observation should be hidden when limiting to session-alpha.',
      confidence: 0.9,
      sourceEventIds: ['event-alpha-other'],
      createdBy: 'manual',
      actor: assistant.actorId
    });
    await observations.create({
      projectHash: 'project-beta',
      observerActorId: assistant.actorId,
      observedActorId: betaUser.actorId,
      sessionId: 'session-beta',
      level: 'explicit',
      content: 'Beta-only project observation should never leak to project-alpha.',
      confidence: 1,
      sourceEventIds: ['event-beta-1'],
      createdBy: 'manual',
      actor: assistant.actorId
    });

    const alphaHermesCard = await cards.get({
      projectHash: 'project-alpha',
      observerActorId: assistant.actorId,
      observedActorId: user.actorId
    });
    const alphaReviewerCard = await cards.get({
      projectHash: 'project-alpha',
      observerActorId: reviewer.actorId,
      observedActorId: user.actorId
    });
    const alphaSessionMembers = await sessions.listBySession({ projectHash: 'project-alpha', sessionId: 'session-alpha' });
    const alphaHermesPerspective = await observations.query({
      projectHash: 'project-alpha',
      observerActorId: assistant.actorId,
      observedActorId: user.actorId,
      sessionId: 'session-alpha',
      limit: 10
    });
    const betaPerspective = await observations.query({
      projectHash: 'project-beta',
      observerActorId: assistant.actorId,
      observedActorId: betaUser.actorId,
      limit: 10
    });
    await cleanup();

    expect(alphaHermesCard?.entries.join('\n')).toContain('autonomous Continue execution');
    expect(alphaHermesCard?.entries.join('\n')).not.toContain('reviewer sees only');
    expect(alphaReviewerCard?.entries.join('\n')).toContain('reviewer sees only QA expectations');

    expect(alphaSessionMembers.map((member) => [member.actorId, member.roleInSession, member.observeOthers])).toEqual(expect.arrayContaining([
      [user.actorId, 'speaker', false],
      [assistant.actorId, 'assistant', true],
      [reviewer.actorId, 'observer', true]
    ]));

    const alphaContents = alphaHermesPerspective.map((item) => item.content).join('\n');
    expect(alphaContents).toContain('TDD');
    expect(alphaContents).toContain('validation and concise progress');
    expect(alphaContents).not.toContain('Reviewer-only');
    expect(alphaContents).not.toContain('Other session observation');
    expect(alphaContents).not.toContain('Beta-only');
    expect(betaPerspective.map((item) => item.content).join('\n')).toContain('Beta-only project observation');
  });
});
