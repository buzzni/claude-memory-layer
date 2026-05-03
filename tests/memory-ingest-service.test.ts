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

interface CreateServiceOptions {
  eventsBySession?: Record<string, MemoryEvent[]>;
  projectHash?: string | null;
  projectPath?: string | null;
  appendResult?: AppendResult;
}

function createService(options: CreateServiceOptions = {}) {
  const eventsBySession = options.eventsBySession ?? {};
  const appended: MemoryEventInput[] = [];
  const initialize = vi.fn(async () => {});
  const store = {
    upsertSession: vi.fn(async () => {}),
    getSessionEvents: vi.fn(async (sessionId: string) => eventsBySession[sessionId] ?? []),
    getSessionsWithoutSummary: vi.fn(async () => Object.keys(eventsBySession)),
    append: vi.fn(async (input: MemoryEventInput): Promise<AppendResult> => {
      appended.push(input);
      return options.appendResult ?? { success: true, eventId: `event-${appended.length}`, isDuplicate: false };
    }),
    enqueueForEmbedding: vi.fn(async (_eventId: string, _content: string) => {})
  };
  const markdownMirror = {
    append: vi.fn(async (_input: MemoryEventInput, _eventId?: string) => {})
  };
  const createToolEmbedding = vi.fn((payload: ToolObservationPayload) => `${payload.toolName}:${payload.success}`);

  return {
    service: new MemoryIngestService({
      initialize,
      eventStore: store,
      markdownMirror,
      createToolEmbedding,
      getProjectHash: () => options.projectHash ?? null,
      getProjectPath: () => options.projectPath ?? null
    }),
    initialize,
    store,
    markdownMirror,
    createToolEmbedding,
    appended
  };
}

describe('MemoryIngestService ingest pipeline', () => {
  it('normalizes metadata, runs interceptors, appends, enqueues embeddings, and mirrors successful events', async () => {
    const { service, store, markdownMirror, appended } = createService({
      projectHash: 'project-hash-1',
      projectPath: '/workspace/project'
    });
    const stages: string[] = [];

    service.registerIngestBefore((context) => {
      stages.push(`${context.stage}:${context.operation}`);
      expect(context.sessionId).toBe('session-1');
      expect(context.event.metadata).toMatchObject({
        ingest: { operation: 'user_prompt', pipeline: 'default' },
        scope: {
          project: { hash: 'project-hash-1', path: '/workspace/project' },
          turn: { id: 'turn-1' }
        },
        tags: ['user:alice', 'legacy', 'proj:project-hash-1']
      });
    });
    service.registerIngestAfter((context) => {
      stages.push(`${context.stage}:${context.operation}`);
      expect(context.event).toBe(appended[0]);
    });

    const result = await service.storeUserPrompt('session-1', 'remember this', {
      scope: { turn: { id: 'turn-1' } },
      tags: [' user:alice ', 'bad:tag', 'legacy']
    });

    expect(result).toEqual({ success: true, eventId: 'event-1', isDuplicate: false });
    expect(store.append).toHaveBeenCalledOnce();
    expect(appended[0]).toMatchObject({
      eventType: 'user_prompt',
      sessionId: 'session-1',
      content: 'remember this',
      metadata: {
        ingest: { operation: 'user_prompt', pipeline: 'default' },
        scope: {
          project: { hash: 'project-hash-1', path: '/workspace/project' },
          turn: { id: 'turn-1' }
        },
        tags: ['user:alice', 'legacy', 'proj:project-hash-1']
      }
    });
    expect((appended[0].metadata as Record<string, unknown>).ingest).toMatchObject({
      ts: expect.any(String)
    });
    expect(store.enqueueForEmbedding).toHaveBeenCalledWith('event-1', 'remember this');
    expect(markdownMirror.append).toHaveBeenCalledWith(appended[0], 'event-1');
    expect(stages).toEqual(['before:user_prompt', 'after:user_prompt']);
  });

  it('does not enqueue embeddings or mirror duplicate append results', async () => {
    const { service, store, markdownMirror } = createService({
      appendResult: { success: true, eventId: 'duplicate-event', isDuplicate: true }
    });

    await expect(service.storeAgentResponse('session-1', 'duplicate response')).resolves.toEqual({
      success: true,
      eventId: 'duplicate-event',
      isDuplicate: true
    });

    expect(store.enqueueForEmbedding).not.toHaveBeenCalled();
    expect(markdownMirror.append).not.toHaveBeenCalled();
  });

  it('keeps markdown mirror failures non-breaking after a successful append', async () => {
    const { service, store, markdownMirror } = createService();
    markdownMirror.append.mockRejectedValueOnce(new Error('mirror is read-only'));

    await expect(service.storeSessionSummary('session-1', 'summary')).resolves.toEqual({
      success: true,
      eventId: 'event-1',
      isDuplicate: false
    });

    expect(store.enqueueForEmbedding).toHaveBeenCalledWith('event-1', 'summary');
    expect(markdownMirror.append).toHaveBeenCalledOnce();
  });

  it('runs error interceptors and skips side effects when append returns a failure result', async () => {
    const { service, store, markdownMirror } = createService({
      appendResult: { success: false, error: 'sqlite append failed' }
    });
    const stages: string[] = [];
    const errors: Error[] = [];
    service.registerIngestAfter((context) => {
      stages.push(context.stage);
    });
    service.registerIngestOnError((context) => {
      stages.push(context.stage);
      errors.push(context.error!);
      expect(context.operation).toBe('agent_response');
      expect(context.event.eventType).toBe('agent_response');
    });

    await expect(service.storeAgentResponse('session-1', 'failed append')).resolves.toEqual({
      success: false,
      error: 'sqlite append failed'
    });

    expect(errors.map((error) => error.message)).toEqual(['sqlite append failed']);
    expect(stages).toEqual(['error']);
    expect(store.enqueueForEmbedding).not.toHaveBeenCalled();
    expect(markdownMirror.append).not.toHaveBeenCalled();
  });

  it('runs error interceptors and skips side effects when append throws', async () => {
    const { service, store, markdownMirror } = createService();
    const error = new Error('sqlite unavailable');
    store.append.mockRejectedValueOnce(error);
    const errors: Error[] = [];
    service.registerIngestOnError((context) => {
      errors.push(context.error!);
      expect(context.stage).toBe('error');
      expect(context.operation).toBe('tool_observation');
      expect(context.event.eventType).toBe('tool_observation');
    });

    await expect(service.storeToolObservation('session-1', {
      toolName: 'terminal',
      success: false,
      metadata: { turnId: 'turn-2' },
      output: 'failed'
    })).rejects.toThrow('sqlite unavailable');

    expect(errors).toEqual([error]);
    expect(store.enqueueForEmbedding).not.toHaveBeenCalled();
    expect(markdownMirror.append).not.toHaveBeenCalled();
  });
});

describe('MemoryIngestService session summary generation', () => {
  it('generates the legacy rule-based summary and stores it through the ingest pipeline', async () => {
    const { service, initialize, store, appended } = createService({
      eventsBySession: {
        'session-1': [
          event({ id: '11111111-1111-4111-8111-111111111111', eventType: 'user_prompt', content: '첫 번째 작업 요청\n자세한 설명', timestamp: new Date('2026-04-30T01:00:00.000Z') }),
          event({ id: '22222222-2222-4222-8222-222222222222', eventType: 'agent_response', content: '응답', timestamp: new Date('2026-04-30T01:01:00.000Z') }),
          event({ id: '33333333-3333-4333-8333-333333333333', eventType: 'tool_observation', content: '{}', timestamp: new Date('2026-04-30T01:02:00.000Z'), metadata: { toolName: 'terminal', exitCode: 1 } }),
          event({ id: '44444444-4444-4444-8444-444444444444', eventType: 'tool_observation', content: '{}', timestamp: new Date('2026-04-30T01:03:00.000Z'), metadata: { toolName: 'terminal', exitCode: 0 } }),
          event({ id: '55555555-5555-4555-8555-555555555555', eventType: 'user_prompt', content: '두 번째 요청', timestamp: new Date('2026-04-30T01:04:00.000Z') })
        ]
      }
    });

    await service.generateSessionSummary('session-1');

    expect(initialize).toHaveBeenCalledOnce();
    expect(store.getSessionEvents).toHaveBeenCalledWith('session-1');
    expect(appended).toHaveLength(1);
    expect(store.enqueueForEmbedding).toHaveBeenCalledWith(
      'event-1',
      '[2026-04-30] 2턴 세션. 주요 작업: 첫 번째 작업 요청 자세한 설명. 사용 툴: terminal. 오류 1건 발생'
    );
    expect(appended[0]).toMatchObject({
      eventType: 'session_summary',
      sessionId: 'session-1',
      content: '[2026-04-30] 2턴 세션. 주요 작업: 첫 번째 작업 요청 자세한 설명. 사용 툴: terminal. 오류 1건 발생',
      metadata: {
        ingest: { operation: 'session_summary', pipeline: 'default' },
        generated: 'rule-based',
        eventCount: 5
      }
    });
  });

  it('does not create another summary for too-short or already summarized sessions', async () => {
    const { service, appended } = createService({
      eventsBySession: {
        short: [
          event({ id: '11111111-1111-4111-8111-111111111111', sessionId: 'short' }),
          event({ id: '22222222-2222-4222-8222-222222222222', sessionId: 'short', eventType: 'agent_response' })
        ],
        summarized: [
          event({ id: '33333333-3333-4333-8333-333333333333', sessionId: 'summarized' }),
          event({ id: '44444444-4444-4444-8444-444444444444', sessionId: 'summarized', eventType: 'agent_response' }),
          event({ id: '55555555-5555-4555-8555-555555555555', sessionId: 'summarized', eventType: 'session_summary', content: 'already summarized' })
        ]
      }
    });

    await service.generateSessionSummary('short');
    await service.generateSessionSummary('summarized');

    expect(appended).toEqual([]);
  });

  it('backfills only missing summary candidates and keeps failures non-critical', async () => {
    const { service, store, appended } = createService({
      eventsBySession: {
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
      }
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
    expect(appended[0].sessionId).toBe('candidate');
  });
});
