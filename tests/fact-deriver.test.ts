import { describe, expect, it } from 'vitest';

import { FactDeriver, makeEventDerivedFactId } from '../src/core/derive/fact-deriver.js';
import type { MemoryEvent } from '../src/core/types.js';

function makeEvent(overrides: Partial<MemoryEvent>): MemoryEvent {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    eventType: 'user_prompt',
    sessionId: 'session-1',
    timestamp: new Date('2026-04-30T00:00:00.000Z'),
    content: 'default content',
    canonicalKey: 'default-content',
    dedupeKey: 'session-1:default-content',
    ...overrides
  };
}

describe('FactDeriver', () => {
  it('derives a deterministic fact from a user prompt', () => {
    const deriver = new FactDeriver();
    const event = makeEvent({
      content: 'We decided to keep SQLite as the canonical store.',
      metadata: {
        scope: { project: { hash: 'proj123' } },
        tags: ['proj:proj123', 'architecture']
      }
    });

    const facts = deriver.deriveFromEvent(event, { now: new Date('2026-04-30T01:02:03.000Z') });

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      factId: makeEventDerivedFactId(event.id, 'decision'),
      projectHash: 'proj123',
      factType: 'decision',
      text: 'User asked: We decided to keep SQLite as the canonical store.',
      derivedFromEventIds: [event.id],
      sourceKind: 'prompt',
      confidence: 0.65,
      importance: 0.5,
      tags: ['proj:proj123', 'architecture'],
      createdAt: '2026-04-30T01:02:03.000Z',
      updatedAt: '2026-04-30T01:02:03.000Z'
    });
  });

  it('derives tool observation facts with tool metadata', () => {
    const deriver = new FactDeriver();
    const event = makeEvent({
      eventType: 'tool_observation',
      content: '{"toolName":"terminal","success":false}',
      metadata: {
        toolName: 'terminal',
        success: false,
        fileRefs: ['src/services/memory-service.ts']
      }
    });

    const [fact] = deriver.deriveFromEvent(event, {
      projectHash: 'fallback-project',
      now: new Date('2026-04-30T01:02:03.000Z')
    });

    expect(fact).toMatchObject({
      factType: 'tool_observation',
      projectHash: 'fallback-project',
      sourceKind: 'tool',
      text: 'Tool terminal failed: {"toolName":"terminal","success":false}',
      fileRefs: ['src/services/memory-service.ts']
    });
  });

  it('skips empty event content', () => {
    const deriver = new FactDeriver();
    const facts = deriver.deriveFromEvent(makeEvent({ content: '   ' }));
    expect(facts).toEqual([]);
  });
});
