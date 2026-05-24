import { describe, expect, it, vi } from 'vitest';

import { createPerspectiveConsolidator } from '../../src/core/operations/index.js';
import type {
  ActorCard,
  MemoryOperationsConfig,
  PerspectiveConsolidationSpecialistKind,
  PerspectiveObservation
} from '../../src/core/types.js';

const BASE_DATE = new Date('2026-05-24T00:00:00.000Z');

function observation(index: number, overrides: Partial<PerspectiveObservation> = {}): PerspectiveObservation {
  const padded = String(index).padStart(12, '0');
  return {
    observationId: `11111111-1111-4111-8111-${padded}`,
    projectHash: 'project-1',
    observerActorId: 'assistant:hermes',
    observedActorId: 'user:default',
    sessionId: 'session-1',
    level: 'explicit',
    content: 'User prefers TDD before implementation.',
    confidence: 0.9,
    sourceEventIds: [`event-${index}`],
    sourceObservationIds: [],
    createdBy: 'manual',
    createdAt: BASE_DATE,
    updatedAt: BASE_DATE,
    ...overrides
  };
}

function actorCard(overrides: Partial<ActorCard> = {}): ActorCard {
  return {
    cardId: '22222222-2222-4222-8222-222222222222',
    projectHash: 'project-1',
    observerActorId: 'assistant:hermes',
    observedActorId: 'user:default',
    entries: ['IDENTITY: existing safe profile'],
    sourceEventIds: ['event-existing'],
    updatedBy: 'tester',
    createdAt: BASE_DATE,
    updatedAt: BASE_DATE,
    ...overrides
  };
}

type SpecialistConfig = NonNullable<NonNullable<MemoryOperationsConfig['perspectiveMemory']>['specialists']>;

function enabledConfig(overrides: Partial<SpecialistConfig> = {}): Partial<SpecialistConfig> {
  const defaultKinds: PerspectiveConsolidationSpecialistKind[] = [
    'deduction',
    'induction',
    'contradiction',
    'actor_card_maintenance'
  ];
  return {
    enabled: true,
    enabledProjectHashes: ['project-1'],
    enabledKinds: defaultKinds,
    maxSourceObservations: 20,
    maxDerivedObservations: 5,
    maxCardUpdates: 3,
    ...overrides
  };
}

describe('PerspectiveConsolidator', () => {
  it('skips all specialists unless the project is explicitly opted in', async () => {
    const observations = {
      query: vi.fn(),
      create: vi.fn(),
      deleteSoft: vi.fn()
    };
    const actorCards = {
      get: vi.fn(),
      upsert: vi.fn()
    };
    const consolidator = createPerspectiveConsolidator({
      observations: observations as never,
      actorCards: actorCards as never,
      config: enabledConfig({ enabledProjectHashes: ['other-project'] })
    });

    const result = await consolidator.run({
      projectHash: 'project-1',
      observerActorId: 'assistant:hermes',
      observedActorId: 'user:default',
      actor: 'tester'
    });

    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toBe('not_opted_in');
    }
    expect(result.metrics).toMatchObject({
      observationsExamined: 0,
      observationsCreated: 0,
      observationsDeleted: 0,
      cardUpdates: 0
    });
    expect(observations.query).not.toHaveBeenCalled();
    expect(observations.create).not.toHaveBeenCalled();
    expect(actorCards.upsert).not.toHaveBeenCalled();
  });

  it('creates bounded derived observations with source chains and metrics', async () => {
    const sourceObservations = [
      observation(1, { content: 'User prefers TDD before implementation.', confidence: 0.92 }),
      observation(2, { content: 'User prefers focused validation before commit.', confidence: 0.88 })
    ];
    const observations = {
      query: vi.fn(async () => sourceObservations),
      create: vi.fn(async (input: Record<string, unknown>) => observation(10 + observations.create.mock.calls.length, {
        level: input.level as PerspectiveObservation['level'],
        content: String(input.content),
        sourceEventIds: input.sourceEventIds as string[],
        sourceObservationIds: input.sourceObservationIds as string[],
        createdBy: input.createdBy as PerspectiveObservation['createdBy']
      })),
      deleteSoft: vi.fn()
    };
    const actorCards = {
      get: vi.fn(async () => null),
      upsert: vi.fn()
    };
    const consolidator = createPerspectiveConsolidator({
      observations: observations as never,
      actorCards: actorCards as never,
      config: enabledConfig({ enabledKinds: ['deduction', 'induction'], maxDerivedObservations: 3, maxCardUpdates: 0 })
    });

    const result = await consolidator.run({
      projectHash: 'project-1',
      observerActorId: 'assistant:hermes',
      observedActorId: 'user:default',
      sessionId: 'session-1',
      actor: 'tester'
    });

    expect(observations.query).toHaveBeenCalledWith(expect.objectContaining({
      projectHash: 'project-1',
      observerActorId: 'assistant:hermes',
      observedActorId: 'user:default',
      sessionId: 'session-1',
      levels: ['explicit'],
      limit: 20
    }));
    expect(observations.create).toHaveBeenCalledTimes(3);
    for (const [input] of observations.create.mock.calls) {
      expect(input).toMatchObject({
        projectHash: 'project-1',
        observerActorId: 'assistant:hermes',
        observedActorId: 'user:default',
        createdBy: 'rule',
        actor: 'perspective-consolidator'
      });
      expect(input.sourceObservationIds.length).toBeGreaterThan(0);
      expect(input.sourceEventIds.length).toBeGreaterThan(0);
      expect(input.metadata.specialist).toMatch(/deduction|induction/);
    }
    expect(result.status).toBe('ok');
    expect(result.metrics).toMatchObject({
      observationsExamined: 2,
      observationsCreated: 3,
      observationsDeleted: 0,
      cardUpdates: 0
    });
    expect(result.metrics.specialists.deduction.observationsCreated).toBe(2);
    expect(result.metrics.specialists.induction.observationsCreated).toBe(1);
  });

  it('updates actor cards within card caps and preserves source evidence', async () => {
    const existingEntries = Array.from({ length: 39 }, (_, index) => `ATTRIBUTE: Existing safe fact ${index + 1}`);
    const sourceObservations = [
      observation(1, { content: 'User prefers focused validation.', confidence: 0.94, sourceEventIds: ['event-1'] }),
      observation(2, { content: 'User prefers source references.', confidence: 0.93, sourceEventIds: ['event-2'] })
    ];
    const observations = {
      query: vi.fn(async () => sourceObservations),
      create: vi.fn(),
      deleteSoft: vi.fn()
    };
    const actorCards = {
      get: vi.fn(async () => actorCard({ entries: existingEntries, sourceEventIds: ['event-existing'] })),
      upsert: vi.fn(async (input: Record<string, unknown>) => actorCard({
        entries: input.entries as string[],
        sourceEventIds: input.sourceEventIds as string[]
      }))
    };
    const consolidator = createPerspectiveConsolidator({
      observations: observations as never,
      actorCards: actorCards as never,
      config: enabledConfig({ enabledKinds: ['actor_card_maintenance'], maxDerivedObservations: 0, maxCardUpdates: 5 })
    });

    const result = await consolidator.run({
      projectHash: 'project-1',
      observerActorId: 'assistant:hermes',
      observedActorId: 'user:default',
      actor: 'tester'
    });

    expect(actorCards.upsert).toHaveBeenCalledTimes(1);
    const [cardInput] = actorCards.upsert.mock.calls[0];
    expect(cardInput.entries).toHaveLength(40);
    expect(cardInput.entries).toContain('INSTRUCTION: Prefers focused validation.');
    expect(cardInput.entries).not.toContain('INSTRUCTION: Prefers source references.');
    expect(cardInput.sourceEventIds).toEqual(expect.arrayContaining(['event-existing', 'event-1']));
    expect(cardInput.sourceEventIds).not.toContain('event-2');
    expect(result.metrics.cardUpdates).toBe(1);
    expect(result.metrics.specialists.actor_card_maintenance.cardUpdates).toBe(1);
  });

  it('skips actor card candidates when sanitization leaves only redacted content', async () => {
    const localPath = ['', 'tmp', 'private', 'profile'].join('/');
    const observations = {
      query: vi.fn(async () => [
        observation(1, { content: `User prefers ${localPath}.`, confidence: 0.95, sourceEventIds: ['event-1'] })
      ]),
      create: vi.fn(),
      deleteSoft: vi.fn()
    };
    const actorCards = {
      get: vi.fn(async () => actorCard({ entries: ['IDENTITY: existing safe profile'], sourceEventIds: ['event-existing'] })),
      upsert: vi.fn()
    };
    const consolidator = createPerspectiveConsolidator({
      observations: observations as never,
      actorCards: actorCards as never,
      config: enabledConfig({ enabledKinds: ['actor_card_maintenance'], maxDerivedObservations: 0, maxCardUpdates: 3 })
    });

    const result = await consolidator.run({
      projectHash: 'project-1',
      observerActorId: 'assistant:hermes',
      observedActorId: 'user:default',
      actor: 'tester'
    });

    expect(actorCards.upsert).not.toHaveBeenCalled();
    expect(result.metrics.cardUpdates).toBe(0);
    expect(result.metrics.specialists.actor_card_maintenance.rejectedCandidates).toBe(1);
  });

  it('flags contradictions with source observation chains', async () => {
    const sourceObservations = [
      observation(1, { content: 'User prefers autonomous commits.', confidence: 0.9, sourceEventIds: ['event-1'] }),
      observation(2, { content: 'User does not prefer autonomous commits.', confidence: 0.9, sourceEventIds: ['event-2'] })
    ];
    const observations = {
      query: vi.fn(async () => sourceObservations),
      create: vi.fn(async (input: Record<string, unknown>) => observation(20, {
        level: input.level as PerspectiveObservation['level'],
        content: String(input.content),
        sourceEventIds: input.sourceEventIds as string[],
        sourceObservationIds: input.sourceObservationIds as string[],
        createdBy: input.createdBy as PerspectiveObservation['createdBy']
      })),
      deleteSoft: vi.fn()
    };
    const actorCards = {
      get: vi.fn(async () => null),
      upsert: vi.fn()
    };
    const consolidator = createPerspectiveConsolidator({
      observations: observations as never,
      actorCards: actorCards as never,
      config: enabledConfig({ enabledKinds: ['contradiction'], maxDerivedObservations: 5, maxCardUpdates: 0 })
    });

    const result = await consolidator.run({
      projectHash: 'project-1',
      observerActorId: 'assistant:hermes',
      observedActorId: 'user:default',
      actor: 'tester'
    });

    expect(observations.create).toHaveBeenCalledTimes(1);
    const [input] = observations.create.mock.calls[0];
    expect(input).toMatchObject({
      level: 'contradiction',
      sourceObservationIds: [sourceObservations[0].observationId, sourceObservations[1].observationId],
      sourceEventIds: ['event-1', 'event-2']
    });
    expect(String(input.content)).toContain('Contradiction');
    expect(result.metrics.specialists.contradiction.observationsCreated).toBe(1);
  });
});
