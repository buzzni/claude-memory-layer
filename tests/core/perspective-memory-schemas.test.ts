import { describe, expect, it } from 'vitest';

import {
  ActorCardEntrySchema,
  CreatePerspectiveObservationInputSchema,
  MemoryActorSchema,
  UpsertActorCardInputSchema,
  UpsertMemoryActorInputSchema,
  UpsertSessionActorInputSchema
} from '../../src/core/types.js';

describe('Perspective memory schemas', () => {
  it('normalizes actors and rejects empty identity fields', () => {
    const parsed = UpsertMemoryActorInputSchema.parse({
      actorId: ' user:default ',
      projectHash: ' project-1 ',
      kind: 'user',
      displayName: ' 전하 ',
      source: ' discord ',
      metadata: { platform: 'discord' }
    });

    expect(parsed.actorId).toBe('user:default');
    expect(parsed.projectHash).toBe('project-1');
    expect(parsed.displayName).toBe('전하');
    expect(parsed.source).toBe('discord');
    expect(() => UpsertMemoryActorInputSchema.parse({
      kind: 'user',
      displayName: '',
      source: 'discord'
    })).toThrow();

    expect(() => MemoryActorSchema.parse({
      actorId: 'actor-1',
      kind: 'assistant',
      displayName: 'Hermes',
      source: 'hermes',
      createdAt: new Date('2026-05-23T00:00:00.000Z'),
      updatedAt: new Date('2026-05-23T00:00:00.000Z')
    })).not.toThrow();
  });

  it('enforces session actor policy defaults and bounded observation flags', () => {
    const parsed = UpsertSessionActorInputSchema.parse({
      projectHash: ' project-1 ',
      sessionId: ' session-a ',
      actorId: ' user:default ',
      roleInSession: 'speaker'
    });

    expect(parsed.projectHash).toBe('project-1');
    expect(parsed.sessionId).toBe('session-a');
    expect(parsed.observeSelf).toBe(true);
    expect(parsed.observeOthers).toBe(false);
  });

  it('validates actor card prefixes, entry limits, and secret-like values', () => {
    const validEntry = ActorCardEntrySchema.parse(' IDENTITY: founder of Buzzni ');
    expect(validEntry).toBe('IDENTITY: founder of Buzzni');

    const parsed = UpsertActorCardInputSchema.parse({
      projectHash: 'project-1',
      observerActorId: 'assistant:hermes',
      observedActorId: 'user:default',
      entries: [
        'IDENTITY: founder of Buzzni',
        'ATTRIBUTE: prefers Korean concise execution summaries',
        'INSTRUCTION: Continue means test, review, commit'
      ],
      sourceEventIds: ['event-1', ''],
      updatedBy: 'tester'
    });

    expect(parsed.entries).toHaveLength(3);
    expect(parsed.sourceEventIds).toEqual(['event-1']);
    expect(() => ActorCardEntrySchema.parse('NOTE: invalid prefix')).toThrow(/prefix/);
    expect(() => ActorCardEntrySchema.parse(`ATTRIBUTE: ${'x'.repeat(205)}`)).toThrow(/200/);
    expect(() => ActorCardEntrySchema.parse('ATTRIBUTE: token=dk')).toThrow(/secret|redacted|sensitive/i);
    expect(() => UpsertActorCardInputSchema.parse({
      observerActorId: 'assistant:hermes',
      observedActorId: 'user:default',
      entries: Array.from({ length: 41 }, (_, i) => `ATTRIBUTE: item ${i}`),
      updatedBy: 'tester'
    })).toThrow(/40/);
  });

  it('requires evidence for non-manual or derived observations and normalizes sources', () => {
    const manualExplicit = CreatePerspectiveObservationInputSchema.parse({
      projectHash: ' project-1 ',
      observerActorId: ' assistant:hermes ',
      observedActorId: ' user:default ',
      level: 'explicit',
      content: ' ATTRIBUTE: prefers TDD ',
      confidence: 0.8,
      createdBy: 'manual'
    });

    expect(manualExplicit.sourceEventIds).toEqual([]);
    expect(manualExplicit.content).toBe('ATTRIBUTE: prefers TDD');

    const derived = CreatePerspectiveObservationInputSchema.parse({
      projectHash: 'project-1',
      observerActorId: 'assistant:hermes',
      observedActorId: 'user:default',
      level: 'deductive',
      content: 'User likely wants autonomous execution',
      confidence: 0.7,
      createdBy: 'llm',
      sourceEventIds: ['event-1', ''],
      sourceObservationIds: ['obs-1']
    });

    expect(derived.sourceEventIds).toEqual(['event-1']);
    expect(derived.sourceObservationIds).toEqual(['obs-1']);
    expect(() => CreatePerspectiveObservationInputSchema.parse({
      observerActorId: 'assistant:hermes',
      observedActorId: 'user:default',
      level: 'deductive',
      content: 'Unsupported conclusion',
      createdBy: 'llm'
    })).toThrow(/source evidence/);
  });
});
