import { describe, expect, it } from 'vitest';

import { SummaryDeriver } from '../../src/core/derive/summary-deriver.js';
import type { MemoryEvent } from '../../src/core/types.js';

function event(overrides: Partial<MemoryEvent>): MemoryEvent {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    eventType: 'user_prompt',
    sessionId: 'session-1',
    timestamp: new Date('2026-04-30T00:00:00.000Z'),
    content: 'default content',
    canonicalKey: 'default-content',
    dedupeKey: 'session-1:default-content',
    metadata: {},
    ...overrides
  };
}

describe('SummaryDeriver', () => {
  it('derives the legacy rule-based session summary from events', () => {
    const deriver = new SummaryDeriver();

    const result = deriver.deriveSessionSummary([
      event({ id: '11111111-1111-4111-8111-111111111111', eventType: 'user_prompt', content: '첫 번째 작업 요청\n자세한 설명', timestamp: new Date('2026-04-30T01:00:00.000Z') }),
      event({ id: '22222222-2222-4222-8222-222222222222', eventType: 'agent_response', content: '응답', timestamp: new Date('2026-04-30T01:01:00.000Z') }),
      event({ id: '33333333-3333-4333-8333-333333333333', eventType: 'tool_observation', content: '{}', timestamp: new Date('2026-04-30T01:02:00.000Z'), metadata: { toolName: 'terminal', exitCode: 1 } }),
      event({ id: '44444444-4444-4444-8444-444444444444', eventType: 'tool_observation', content: '{}', timestamp: new Date('2026-04-30T01:03:00.000Z'), metadata: { toolName: 'terminal', exitCode: 0 } }),
      event({ id: '55555555-5555-4555-8555-555555555555', eventType: 'tool_observation', content: '{}', timestamp: new Date('2026-04-30T01:04:00.000Z'), metadata: { toolName: 'read_file', success: false } }),
      event({ id: '66666666-6666-4666-8666-666666666666', eventType: 'user_prompt', content: '두 번째 요청', timestamp: new Date('2026-04-30T01:05:00.000Z') })
    ]);

    expect(result).toEqual({
      text: '[2026-04-30] 2턴 세션. 주요 작업: 첫 번째 작업 요청 자세한 설명. 사용 툴: terminal, read_file. 오류 2건 발생',
      metadata: { generated: 'rule-based', eventCount: 6 }
    });
  });

  it('returns null for too-short sessions and sessions that already have summaries', () => {
    const deriver = new SummaryDeriver();

    expect(deriver.deriveSessionSummary([
      event({ id: '11111111-1111-4111-8111-111111111111' }),
      event({ id: '22222222-2222-4222-8222-222222222222', eventType: 'agent_response' })
    ])).toBeNull();

    expect(deriver.deriveSessionSummary([
      event({ id: '33333333-3333-4333-8333-333333333333' }),
      event({ id: '44444444-4444-4444-8444-444444444444', eventType: 'agent_response' }),
      event({ id: '55555555-5555-4555-8555-555555555555', eventType: 'session_summary', content: 'already summarized' })
    ])).toBeNull();
  });

  it('limits the first prompt preview to keep summaries compact', () => {
    const deriver = new SummaryDeriver();
    const longPrompt = `${'a'.repeat(140)}\nextra`;

    const result = deriver.deriveSessionSummary([
      event({ id: '11111111-1111-4111-8111-111111111111', content: longPrompt }),
      event({ id: '22222222-2222-4222-8222-222222222222', eventType: 'agent_response', content: '응답' }),
      event({ id: '33333333-3333-4333-8333-333333333333', eventType: 'tool_observation', content: '{}', metadata: { toolName: 'terminal' } })
    ]);

    expect(result?.text).toBe(`[2026-04-30] 1턴 세션. 주요 작업: ${'a'.repeat(120)}. 사용 툴: terminal`);
  });
});
