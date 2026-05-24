import { describe, expect, it, vi } from 'vitest';

import { generateCitationId } from '../../src/core/citation-generator.js';
import {
  createPerspectiveQueryAgent,
  type PerspectiveQueryAgentTools
} from '../../src/core/operations/index.js';
import type { ActorCard, MemoryEvent, PerspectiveObservation, SessionActor } from '../../src/core/types.js';

function observation(overrides: Partial<PerspectiveObservation> = {}): PerspectiveObservation {
  return {
    observationId: 'observation-1',
    projectHash: 'project-1',
    observerActorId: 'actor:assistant:hermes',
    observedActorId: 'actor:subagent:coder',
    sessionId: 'session-1',
    level: 'explicit',
    content: 'Coder is blocked on stale vector outbox recovery and needs a focused test.',
    confidence: 0.91,
    sourceEventIds: ['event-observation-1'],
    sourceObservationIds: [],
    createdBy: 'manual',
    createdAt: new Date('2026-05-24T00:00:00.000Z'),
    updatedAt: new Date('2026-05-24T00:00:00.000Z'),
    ...overrides
  };
}

function rawEvent(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: 'event-raw-1',
    eventType: 'agent_response',
    sessionId: 'session-1',
    timestamp: new Date('2026-05-24T00:02:00.000Z'),
    content: 'The blocker was recovered by processing the vector outbox and rerunning the dashboard smoke.',
    canonicalKey: 'canonical:event-raw-1',
    dedupeKey: 'dedupe:event-raw-1',
    metadata: { source: 'test' },
    ...overrides
  };
}

function tools(overrides: Partial<PerspectiveQueryAgentTools> = {}): PerspectiveQueryAgentTools {
  return {
    searchPerspectiveObservations: vi.fn(async () => [observation()]),
    searchRawEvents: vi.fn(async () => [{ event: rawEvent(), score: 0.78 }]),
    expandSourceRefs: vi.fn(async () => []),
    readActorCard: vi.fn(async (): Promise<ActorCard | null> => null),
    listSessionActors: vi.fn(async (): Promise<SessionActor[]> => []),
    ...overrides
  };
}

describe('PerspectiveQueryAgent', () => {
  it('keeps minimal reasoning search-only and avoids expansion/card/session tools', async () => {
    const agentTools = tools();
    const agent = createPerspectiveQueryAgent({ tools: agentTools });

    const result = await agent.answer({
      projectHash: 'project-1',
      observerActorId: 'actor:assistant:hermes',
      observedActorId: 'actor:subagent:coder',
      question: 'What does Hermes know about coder blocker?',
      reasoningLevel: 'minimal'
    });

    expect(agentTools.searchPerspectiveObservations).toHaveBeenCalledWith(expect.objectContaining({
      projectHash: 'project-1',
      observerActorId: 'actor:assistant:hermes',
      observedActorId: 'actor:subagent:coder',
      query: 'What does Hermes know about coder blocker?'
    }));
    expect(agentTools.searchRawEvents).toHaveBeenCalledWith(expect.objectContaining({
      projectHash: 'project-1',
      query: 'What does Hermes know about coder blocker?'
    }));
    expect(agentTools.expandSourceRefs).not.toHaveBeenCalled();
    expect(agentTools.readActorCard).not.toHaveBeenCalled();
    expect(agentTools.listSessionActors).not.toHaveBeenCalled();
    expect(result.toolCalls.map((call) => call.name)).toEqual([
      'search_perspective_observations',
      'search_raw_events'
    ]);
  });

  it('requires source refs in the final response when evidence is found', async () => {
    const agent = createPerspectiveQueryAgent({ tools: tools() });

    const result = await agent.answer({
      projectHash: 'project-1',
      observerActorId: 'actor:assistant:hermes',
      observedActorId: 'actor:subagent:coder',
      question: 'Summarize the coder blocker.',
      reasoningLevel: 'minimal'
    });

    const observationRef = `mem:${generateCitationId('event-observation-1')}`;
    const rawEventRef = `mem:${generateCitationId('event-raw-1')}`;
    expect(result.sourceRefs).toEqual(expect.arrayContaining([observationRef, rawEventRef]));
    expect(result.answer).toContain('Sources:');
    expect(result.answer).toContain(`[${observationRef}]`);
    expect(result.answer).toContain(`[${rawEventRef}]`);
  });

  it('enforces the reasoning-level tool iteration cap before calling another tool', async () => {
    const agentTools = tools();
    const agent = createPerspectiveQueryAgent({
      tools: agentTools,
      maxToolIterationsByReasoningLevel: { minimal: 1, low: 3, high: 5 }
    });

    const result = await agent.answer({
      projectHash: 'project-1',
      observerActorId: 'actor:assistant:hermes',
      observedActorId: 'actor:subagent:coder',
      question: 'What is the blocker?',
      reasoningLevel: 'minimal'
    });

    expect(agentTools.searchPerspectiveObservations).toHaveBeenCalledTimes(1);
    expect(agentTools.searchRawEvents).not.toHaveBeenCalled();
    expect(agentTools.expandSourceRefs).not.toHaveBeenCalled();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.hitToolIterationCap).toBe(true);
  });

  it('redacts private-tagged and credential-shaped evidence before rendering answers', async () => {
    const hidden = 'private peer note';
    const secretValue = ['abcd', '1234', 'efgh'].join('');
    const agent = createPerspectiveQueryAgent({
      tools: tools({
        searchPerspectiveObservations: vi.fn(async () => [
          observation({ content: `<private>${hidden}</private> token: ${secretValue}` })
        ]),
        searchRawEvents: vi.fn(async () => [])
      })
    });

    const result = await agent.answer({
      projectHash: 'project-1',
      observerActorId: 'actor:assistant:hermes',
      observedActorId: 'actor:subagent:coder',
      question: 'What private evidence exists?',
      reasoningLevel: 'minimal'
    });

    expect(result.answer).not.toContain(hidden);
    expect(result.answer).not.toContain(secretValue);
    expect(result.answer).toContain('[PRIVATE]');
    expect(result.answer).toContain('[REDACTED]');
  });

  it('keeps source refs for low/high evidence that lacks source event IDs', async () => {
    const agent = createPerspectiveQueryAgent({
      tools: tools({
        searchPerspectiveObservations: vi.fn(async () => []),
        searchRawEvents: vi.fn(async () => []),
        readActorCard: vi.fn(async (): Promise<ActorCard> => ({
          cardId: 'card-1',
          projectHash: 'project-1',
          observerActorId: 'actor:assistant:hermes',
          observedActorId: 'actor:subagent:coder',
          entries: ['Coder prefers compact review briefs'],
          sourceEventIds: [],
          updatedBy: 'tester',
          createdAt: new Date('2026-05-24T00:00:00.000Z'),
          updatedAt: new Date('2026-05-24T00:00:00.000Z')
        }))
      })
    });

    const result = await agent.answer({
      projectHash: 'project-1',
      observerActorId: 'actor:assistant:hermes',
      observedActorId: 'actor:subagent:coder',
      question: 'What should reviewer know about coder?',
      reasoningLevel: 'low'
    });

    expect(result.answer).not.toContain('Sources: none');
    expect(result.sourceRefs).toEqual(expect.arrayContaining(['actor-card:card-1']));
    expect(result.answer).toContain('[actor-card:card-1]');
  });

  it('keeps source refs for high session-actor evidence', async () => {
    const agent = createPerspectiveQueryAgent({
      tools: tools({
        searchPerspectiveObservations: vi.fn(async () => []),
        searchRawEvents: vi.fn(async () => []),
        readActorCard: vi.fn(async () => null),
        listSessionActors: vi.fn(async (): Promise<SessionActor[]> => [{
          projectHash: 'project-1',
          sessionId: 'session-1',
          actorId: 'actor:subagent:coder',
          roleInSession: 'assistant',
          observeSelf: false,
          observeOthers: true,
          joinedAt: new Date('2026-05-24T00:00:00.000Z')
        }]),
        expandSourceRefs: vi.fn(async () => [])
      })
    });

    const result = await agent.answer({
      projectHash: 'project-1',
      observerActorId: 'actor:assistant:hermes',
      observedActorId: 'actor:subagent:coder',
      sessionId: 'session-1',
      question: 'Who is in the session?',
      reasoningLevel: 'high'
    });

    expect(result.answer).not.toContain('Sources: none');
    expect(result.sourceRefs).toEqual(expect.arrayContaining(['session-actor:session-1:actor:subagent:coder']));
    expect(result.answer).toContain('[session-actor:session-1:actor:subagent:coder]');
  });
});
