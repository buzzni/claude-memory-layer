import { describe, expect, it, vi } from 'vitest';

import { MemoryIngestService } from '../src/core/engine/memory-ingest-service.js';
import type { AppendResult, MemoryEvent, MemoryEventInput, ToolObservationPayload } from '../src/core/types.js';

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

function createService(eventsBySession: Record<string, MemoryEvent[]> = {}) {
  const appended: Array<{ operation: string; input: MemoryEventInput; embeddingContent?: string }> = [];
  const initialize = vi.fn(async () => {});
  const store = {
    upsertSession: vi.fn(async () => {}),
    getSessionEvents: vi.fn(async (sessionId: string) => eventsBySession[sessionId] ?? []),
    getSessionsWithoutSummary: vi.fn(async () => Object.keys(eventsBySession))
  };
  const ingestEvent = vi.fn(async (options: { operation: string; input: MemoryEventInput; embeddingContent?: string }): Promise<AppendResult> => {
    appended.push(options);
    return { success: true, eventId: `event-${appended.length}`, isDuplicate: false };
  });
  const createToolEmbedding = vi.fn((payload: ToolObservationPayload) => `${payload.toolName}:${payload.success}`);

  return {
    service: new MemoryIngestService(initialize, store, ingestEvent as any, createToolEmbedding),
    initialize,
    store,
    ingestEvent,
    appended
  };
}

describe('MemoryIngestService session summary generation', () => {
  it('generates the legacy rule-based summary and stores it through the ingest pipeline', async () => {
    const { service, initialize, store, appended } = createService({
      'session-1': [
        event({ id: '11111111-1111-4111-8111-111111111111', eventType: 'user_prompt', content: '첫 번째 작업 요청\n자세한 설명', timestamp: new Date('2026-04-30T01:00:00.000Z') }),
        event({ id: '22222222-2222-4222-8222-222222222222', eventType: 'agent_response', content: '응답', timestamp: new Date('2026-04-30T01:01:00.000Z') }),
        event({ id: '33333333-3333-4333-8333-333333333333', eventType: 'tool_observation', content: '{}', timestamp: new Date('2026-04-30T01:02:00.000Z'), metadata: { toolName: 'terminal', exitCode: 1 } }),
        event({ id: '44444444-4444-4444-8444-444444444444', eventType: 'tool_observation', content: '{}', timestamp: new Date('2026-04-30T01:03:00.000Z'), metadata: { toolName: 'terminal', exitCode: 0 } }),
        event({ id: '55555555-5555-4555-8555-555555555555', eventType: 'user_prompt', content: '두 번째 요청', timestamp: new Date('2026-04-30T01:04:00.000Z') })
      ]
    });

    await service.generateSessionSummary('session-1');

    expect(initialize).toHaveBeenCalledOnce();
    expect(store.getSessionEvents).toHaveBeenCalledWith('session-1');
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      operation: 'session_summary',
      embeddingContent: '[2026-04-30] 2턴 세션. 주요 작업: 첫 번째 작업 요청 자세한 설명. 사용 툴: terminal. 오류 1건 발생'
    });
    expect(appended[0].input).toMatchObject({
      eventType: 'session_summary',
      sessionId: 'session-1',
      content: '[2026-04-30] 2턴 세션. 주요 작업: 첫 번째 작업 요청 자세한 설명. 사용 툴: terminal. 오류 1건 발생',
      metadata: { generated: 'rule-based', eventCount: 5 }
    });
  });

  it('does not create another summary for too-short or already summarized sessions', async () => {
    const { service, appended } = createService({
      short: [
        event({ id: '11111111-1111-4111-8111-111111111111', sessionId: 'short' }),
        event({ id: '22222222-2222-4222-8222-222222222222', sessionId: 'short', eventType: 'agent_response' })
      ],
      summarized: [
        event({ id: '33333333-3333-4333-8333-333333333333', sessionId: 'summarized' }),
        event({ id: '44444444-4444-4444-8444-444444444444', sessionId: 'summarized', eventType: 'agent_response' }),
        event({ id: '55555555-5555-4555-8555-555555555555', sessionId: 'summarized', eventType: 'session_summary', content: 'already summarized' })
      ]
    });

    await service.generateSessionSummary('short');
    await service.generateSessionSummary('summarized');

    expect(appended).toEqual([]);
  });

  it('backfills only missing summary candidates and keeps failures non-critical', async () => {
    const { service, store, appended } = createService({
      candidate: [
        event({ id: '11111111-1111-4111-8111-111111111111', sessionId: 'candidate', eventType: 'user_prompt', content: '분석 작업' }),
        event({ id: '22222222-2222-4222-8222-222222222222', sessionId: 'candidate', eventType: 'agent_response', content: '응답' }),
        event({ id: '33333333-3333-4333-8333-333333333333', sessionId: 'candidate', eventType: 'tool_observation', content: '{}', metadata: { toolName: 'read_file' } })
      ],
      tooShort: [
        event({ id: '44444444-4444-4444-8444-444444444444', sessionId: 'tooShort', eventType: 'user_prompt' })
      ],
      broken: [
        event({ id: '55555555-5555-4555-8555-555555555555', sessionId: 'broken', eventType: 'user_prompt' }),
        event({ id: '66666666-6666-4666-8666-666666666666', sessionId: 'broken', eventType: 'agent_response' }),
        event({ id: '77777777-7777-4777-8777-777777777777', sessionId: 'broken', eventType: 'tool_observation' })
      ]
    });
    store.getSessionsWithoutSummary.mockResolvedValueOnce(['candidate', 'tooShort', 'broken']);
    store.getSessionEvents.mockImplementation(async (sessionId: string) => {
      if (sessionId === 'broken') throw new Error('corrupt session');
      return (store as any).__eventsBySession?.[sessionId] ?? [];
    });
    (store as any).__eventsBySession = {
      candidate: [
        event({ id: '11111111-1111-4111-8111-111111111111', sessionId: 'candidate', eventType: 'user_prompt', content: '분석 작업' }),
        event({ id: '22222222-2222-4222-8222-222222222222', sessionId: 'candidate', eventType: 'agent_response', content: '응답' }),
        event({ id: '33333333-3333-4333-8333-333333333333', sessionId: 'candidate', eventType: 'tool_observation', content: '{}', metadata: { toolName: 'read_file' } })
      ],
      tooShort: [
        event({ id: '44444444-4444-4444-8444-444444444444', sessionId: 'tooShort', eventType: 'user_prompt' })
      ]
    };

    await expect(service.backfillMissingSummaries('current-session', 7)).resolves.toBeUndefined();

    expect(store.getSessionsWithoutSummary).toHaveBeenCalledWith('current-session', 7);
    expect(store.getSessionEvents).toHaveBeenCalledWith('candidate');
    expect(store.getSessionEvents).toHaveBeenCalledWith('tooShort');
    expect(store.getSessionEvents).toHaveBeenCalledWith('broken');
    expect(appended).toHaveLength(1);
    expect(appended[0].input.sessionId).toBe('candidate');
  });
});
