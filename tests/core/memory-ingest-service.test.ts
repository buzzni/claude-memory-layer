import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SESSION_SUMMARY_REFRESH,
  isLlmSessionSummaryDue,
  MemoryIngestService,
  SUMMARY_REFRESH_BACKFILL_WINDOW_MS,
  type SessionSummaryRefreshPolicy
} from '../../src/core/engine/memory-ingest-service.js';
import type { AppendOptions, SessionSummaryCandidate } from '../../src/core/sqlite-event-store.js';
import type { AppendResult, MemoryEvent, MemoryEventInput, ToolObservationPayload } from '../../src/core/types.js';

const SUMMARY_REFRESH_MIN_NEW_EXCHANGES = DEFAULT_SESSION_SUMMARY_REFRESH.minNewExchanges;

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
  perspectiveDeriver?: {
    deriveFromEvent: (event: MemoryEvent, options?: { projectHash?: string | null; projectPath?: string | null }) => Promise<unknown>;
  };
  llmSummaryGenerator?: (
    events: Array<{ eventType: string; content: string }>
  ) => Promise<{ text: string; metadata: Record<string, unknown> } | null>;
  summaryRefresh?: SessionSummaryRefreshPolicy;
  now?: () => Date;
}

function createService(options: CreateServiceOptions = {}) {
  const eventsBySession = options.eventsBySession ?? {};
  const appended: MemoryEventInput[] = [];
  const initialize = vi.fn(async () => {});
  const store = {
    upsertSession: vi.fn(async () => {}),
    getSessionEvents: vi.fn(async (sessionId: string) => eventsBySession[sessionId] ?? []),
    getSessionsWithoutSummary: vi.fn(async () => Object.keys(eventsBySession)),
    getLlmSummaryCandidates: vi.fn(async (
      _currentSessionId: string,
      _options: { limit: number; refreshSince?: Date }
    ): Promise<SessionSummaryCandidate[]> => []),
    append: vi.fn(async (input: MemoryEventInput, _options?: AppendOptions): Promise<AppendResult> => {
      appended.push(input);
      return options.appendResult ?? { success: true, eventId: `event-${appended.length}`, isDuplicate: false };
    }),
    enqueueForEmbedding: vi.fn(async (_eventId: string, _content: string) => {}),
    mergeEventMetadata: vi.fn(async (_eventId: string, _patch: Record<string, unknown>) => true)
  };
  const createToolEmbedding = vi.fn((payload: ToolObservationPayload) => `${payload.toolName}:${payload.success}`);

  return {
    service: new MemoryIngestService({
      initialize,
      eventStore: store,
      createToolEmbedding,
      getProjectHash: () => options.projectHash ?? null,
      getProjectPath: () => options.projectPath ?? null,
      perspectiveDeriver: options.perspectiveDeriver,
      llmSummaryGenerator: options.llmSummaryGenerator,
      summaryRefresh: options.summaryRefresh,
      now: options.now
    }),
    initialize,
    store,
    createToolEmbedding,
    appended
  };
}

describe('MemoryIngestService ingest pipeline', () => {
  it('normalizes metadata, runs interceptors, appends, and enqueues embeddings for successful events', async () => {
    const { service, store, appended } = createService({
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
    expect(stages).toEqual(['before:user_prompt', 'after:user_prompt']);
  });

  it('does not enqueue embeddings for duplicate append results', async () => {
    const { service, store } = createService({
      appendResult: { success: true, eventId: 'duplicate-event', isDuplicate: true }
    });

    await expect(service.storeAgentResponse('session-1', 'duplicate response')).resolves.toEqual({
      success: true,
      eventId: 'duplicate-event',
      isDuplicate: true
    });

    expect(store.enqueueForEmbedding).not.toHaveBeenCalled();
  });

  it('keeps perspective derivation failures non-blocking after a successful append', async () => {
    const perspectiveDeriver = {
      deriveFromEvent: vi.fn(async () => {
        throw new Error('optional perspective deriver unavailable');
      })
    };
    const { service, store } = createService({
      projectHash: 'project-1',
      projectPath: '/workspace/project',
      perspectiveDeriver
    });

    await expect(service.storeUserPrompt('session-1', 'derive this safely')).resolves.toEqual({
      success: true,
      eventId: 'event-1',
      isDuplicate: false
    });

    expect(store.append).toHaveBeenCalledOnce();
    expect(store.enqueueForEmbedding).toHaveBeenCalledWith('event-1', 'derive this safely');
    expect(perspectiveDeriver.deriveFromEvent).toHaveBeenCalledWith(expect.objectContaining({
      id: 'event-1',
      eventType: 'user_prompt',
      sessionId: 'session-1',
      content: 'derive this safely'
    }), { projectHash: 'project-1', projectPath: '/workspace/project' });
  });

  it('runs error interceptors and skips side effects when append returns a failure result', async () => {
    const { service, store } = createService({
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
  });

  it('runs error interceptors and skips side effects when append throws', async () => {
    const { service, store } = createService();
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
  });

  it('never enqueues tool_observation for embedding on a successful append, even though the legacy outbox path would otherwise embed every operation', async () => {
    // SQLiteEventStore.append() already skips tool_observation for the V2
    // vector_outbox (see the fix in append()/importEvents()); this is the
    // parallel legacy embedding_outbox path storeToolObservation used to
    // reach unconditionally via `embeddingContent`, which kept re-polluting
    // semantic search with raw tool output (including full Agent/Task
    // subagent responses) after every "fix".
    const { service, store, createToolEmbedding } = createService();

    const result = await service.storeToolObservation('session-1', {
      toolName: 'Agent',
      success: true,
      metadata: { turnId: 'turn-3' },
      output: 'subagent review output'
    } as ToolObservationPayload);

    expect(result).toEqual({ success: true, eventId: 'event-1', isDuplicate: false });
    expect(createToolEmbedding).toHaveBeenCalledOnce();
    expect(store.enqueueForEmbedding).not.toHaveBeenCalled();
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

describe('MemoryIngestService LLM session summary', () => {
  const sessionEvents = [
    event({ id: '11111111-1111-4111-8111-111111111111', sessionId: 's', eventType: 'user_prompt', content: '자동 업데이트가 왜 안 보이지' }),
    event({ id: '22222222-2222-4222-8222-222222222222', sessionId: 's', eventType: 'agent_response', content: 'publish 설정 누락이 원인' }),
    event({ id: '33333333-3333-4333-8333-333333333333', sessionId: 's', eventType: 'tool_observation', content: '{}', metadata: { toolName: 'Bash' } })
  ];

  it('stores the generated outcome summary', async () => {
    const { service, appended } = createService({
      eventsBySession: { s: sessionEvents },
      llmSummaryGenerator: async () => ({ text: '- 결정: publish 설정 추가', metadata: { generated: 'llm' } })
    });

    await expect(service.generateLlmSessionSummary('s')).resolves.toBe(true);
    expect(appended).toHaveLength(1);
    expect(appended[0].eventType).toBe('session_summary');
    expect(appended[0].content).toBe('- 결정: publish 설정 추가');
  });

  it('fails instead of reporting success when the summary could not be stored', async () => {
    // The store reports write failures (disk full, locked) as a result, not
    // an exception; a caller that took `true` here dropped the retry.
    const { service } = createService({
      eventsBySession: { s: sessionEvents },
      appendResult: { success: false, error: 'SQLITE_FULL' },
      llmSummaryGenerator: async () => ({ text: '- 결정: x', metadata: { generated: 'llm' } })
    });

    await expect(service.generateLlmSessionSummary('s')).rejects.toThrow(/could not be stored: SQLITE_FULL/);
  });

  it('counts an already-stored duplicate summary as stored', async () => {
    const { service } = createService({
      eventsBySession: { s: sessionEvents },
      appendResult: { success: true, eventId: 'existing', isDuplicate: true },
      llmSummaryGenerator: async () => ({ text: '- 결정: x', metadata: { generated: 'llm' } })
    });

    await expect(service.generateLlmSessionSummary('s')).resolves.toBe(true);
  });

  it('stores nothing when the session holds no durable content', async () => {
    const { service, appended } = createService({
      eventsBySession: { s: sessionEvents },
      llmSummaryGenerator: async () => null
    });

    await expect(service.generateLlmSessionSummary('s')).resolves.toBe(false);
    expect(appended).toHaveLength(0);
  });

  it('does not fall back to the rule-based summary when the generator throws', async () => {
    const { service, appended } = createService({
      eventsBySession: { s: sessionEvents },
      llmSummaryGenerator: async () => { throw new Error('provider timed out'); }
    });

    await expect(service.generateLlmSessionSummary('s')).rejects.toThrow('provider timed out');
    // Nothing stored: the session stays eligible for a later backfill retry
    // instead of being permanently filled with table-of-contents text.
    expect(appended).toHaveLength(0);
  });

  it('skips sessions whose summary already covers the conversation', async () => {
    const generator = vi.fn(async () => ({ text: '- x', metadata: {} }));
    const { service, appended } = createService({
      eventsBySession: {
        s: [...sessionEvents, event({ id: '44444444-4444-4444-8444-444444444444', sessionId: 's', eventType: 'session_summary', content: 'old' })]
      },
      llmSummaryGenerator: generator
    });

    await expect(service.generateLlmSessionSummary('s')).resolves.toBe(false);
    expect(generator).not.toHaveBeenCalled();
    expect(appended).toHaveLength(0);
  });

  function grownSession(previousSummary: Partial<MemoryEvent>, laterExchanges: number): MemoryEvent[] {
    const later = Array.from({ length: laterExchanges }, (_, i) => event({
      id: `later-${i}`,
      sessionId: 's',
      eventType: i % 2 === 0 ? 'user_prompt' : 'agent_response',
      content: `후속 ${i}`
    }));
    return [
      ...sessionEvents,
      event({ id: 'old-summary', sessionId: 's', eventType: 'session_summary', content: '- 결정: 첫 요약', ...previousSummary }),
      ...later
    ];
  }

  it('records how many prompt/answer events the summary was built from', async () => {
    const { service, appended } = createService({
      eventsBySession: { s: sessionEvents },
      llmSummaryGenerator: async () => ({ text: '- 결정: x', metadata: { generated: 'llm' } })
    });

    await service.generateLlmSessionSummary('s');
    expect(appended[0].metadata).toMatchObject({ generated: 'llm', summarizedExchangeCount: 2 });
  });

  it('refreshes a summary once the session has gained enough conversation, and supersedes the old one', async () => {
    const generator = vi.fn(async (_events: Array<{ eventType: string; content: string }>) => ({
      text: '- 결정: 새 요약',
      metadata: { generated: 'llm' }
    }));
    const { service, appended, store } = createService({
      eventsBySession: { s: grownSession({}, SUMMARY_REFRESH_MIN_NEW_EXCHANGES) },
      llmSummaryGenerator: generator
    });

    await expect(service.generateLlmSessionSummary('s')).resolves.toBe(true);
    // The old summary goes to the generator as prior findings.
    expect(generator.mock.calls[0][0]).toContainEqual({ eventType: 'session_summary', content: '- 결정: 첫 요약' });
    expect(appended).toHaveLength(1);
    expect(appended[0].metadata).toMatchObject({
      summarizedExchangeCount: 2 + SUMMARY_REFRESH_MIN_NEW_EXCHANGES,
      summaryRefreshes: 1
    });
    // Replaced in the transaction that stores the new one.
    expect(store.append.mock.calls[0][1]).toEqual({
      replaces: {
        eventIds: ['old-summary'],
        metadataOnDuplicate: { summarizedExchangeCount: 2 + SUMMARY_REFRESH_MIN_NEW_EXCHANGES, summaryRefreshes: 1 }
      }
    });
  });

  it('waits for the full refresh bound before calling the provider again', async () => {
    const generator = vi.fn(async () => ({ text: '- x', metadata: {} }));
    const { service, appended, store } = createService({
      eventsBySession: { s: grownSession({}, SUMMARY_REFRESH_MIN_NEW_EXCHANGES - 1) },
      llmSummaryGenerator: generator
    });

    await expect(service.generateLlmSessionSummary('s')).resolves.toBe(false);
    expect(generator).not.toHaveBeenCalled();
    expect(appended).toHaveLength(0);
  });

  it('measures growth from the recorded count, not from where the summary row sorts', async () => {
    // Recorded at 2 exchanges, but every later event sorts before the summary
    // row (e.g. imported with its original timestamps).
    const events = grownSession({}, SUMMARY_REFRESH_MIN_NEW_EXCHANGES);
    const summary = events.find((e) => e.id === 'old-summary')!;
    summary.metadata = { summarizedExchangeCount: 2 };
    const reordered = [...events.filter((e) => e !== summary), summary];
    const generator = vi.fn(async () => ({ text: '- x', metadata: {} }));
    const { service } = createService({ eventsBySession: { s: reordered }, llmSummaryGenerator: generator });

    await expect(service.generateLlmSessionSummary('s')).resolves.toBe(true);
    expect(generator).toHaveBeenCalledOnce();
  });

  it('leaves a repeated summary to the store, which keeps it in one transaction', async () => {
    const { service, store } = createService({
      eventsBySession: { s: grownSession({}, SUMMARY_REFRESH_MIN_NEW_EXCHANGES) },
      appendResult: { success: true, eventId: 'old-summary', isDuplicate: true },
      llmSummaryGenerator: async () => ({ text: '- 결정: 첫 요약', metadata: {} })
    });

    await expect(service.generateLlmSessionSummary('s')).resolves.toBe(true);
    expect(store.append.mock.calls[0][1]?.replaces?.metadataOnDuplicate).toEqual({
      summarizedExchangeCount: 2 + SUMMARY_REFRESH_MIN_NEW_EXCHANGES,
      summaryRefreshes: 1
    });
    expect(store.mergeEventMetadata).not.toHaveBeenCalled();
  });

  it('keeps the old summary, counted as covered, when the refresh finds nothing durable', async () => {
    const { service, store } = createService({
      eventsBySession: { s: grownSession({}, SUMMARY_REFRESH_MIN_NEW_EXCHANGES) },
      llmSummaryGenerator: async () => null
    });

    await expect(service.generateLlmSessionSummary('s')).resolves.toBe(false);
    expect(store.append).not.toHaveBeenCalled();
    expect(store.mergeEventMetadata).toHaveBeenCalledWith('old-summary', {
      summarizedExchangeCount: 2 + SUMMARY_REFRESH_MIN_NEW_EXCHANGES,
      summaryRefreshes: 1
    });
  });

  it('stops refreshing at the per-session cap', async () => {
    const generator = vi.fn(async () => ({ text: '- x', metadata: {} }));
    const { service, appended, store } = createService({
      eventsBySession: {
        s: grownSession({ metadata: { summarizedExchangeCount: 2, summaryRefreshes: DEFAULT_SESSION_SUMMARY_REFRESH.maxRefreshesPerSession } }, 4 * SUMMARY_REFRESH_MIN_NEW_EXCHANGES)
      },
      llmSummaryGenerator: generator
    });

    await expect(service.generateLlmSessionSummary('s')).resolves.toBe(false);
    expect(generator).not.toHaveBeenCalled();
    expect(appended).toHaveLength(0);
  });

  it('counts each refresh toward the cap, the empty ones included', async () => {
    const { service, store } = createService({
      eventsBySession: { s: grownSession({ metadata: { summarizedExchangeCount: 2, summaryRefreshes: 1 } }, SUMMARY_REFRESH_MIN_NEW_EXCHANGES) },
      llmSummaryGenerator: async () => null
    });

    await service.generateLlmSessionSummary('s');
    expect(store.mergeEventMetadata).toHaveBeenCalledWith('old-summary', {
      summarizedExchangeCount: 2 + SUMMARY_REFRESH_MIN_NEW_EXCHANGES,
      summaryRefreshes: 2
    });
  });

  it('follows the configured policy', async () => {
    const generator = vi.fn(async () => ({ text: '- x', metadata: {} }));
    const fourLater = grownSession({}, 4);
    const tuned = createService({
      eventsBySession: { s: fourLater },
      llmSummaryGenerator: generator,
      summaryRefresh: { enabled: true, minNewExchanges: 4, maxRefreshesPerSession: 1 }
    });
    await expect(tuned.service.generateLlmSessionSummary('s')).resolves.toBe(true);

    const off = createService({
      eventsBySession: { s: grownSession({}, 4 * SUMMARY_REFRESH_MIN_NEW_EXCHANGES) },
      llmSummaryGenerator: generator,
      summaryRefresh: { ...DEFAULT_SESSION_SUMMARY_REFRESH, enabled: false }
    });
    await expect(off.service.generateLlmSessionSummary('s')).resolves.toBe(false);
    expect(generator).toHaveBeenCalledOnce();
  });

  it('changes nothing when the provider call fails, so the old summary stays and the session stays due', async () => {
    const circuitOpen = Object.assign(new Error('skipped'), { code: 'provider-circuit-open' });
    const { service, appended, store } = createService({
      eventsBySession: { s: grownSession({}, SUMMARY_REFRESH_MIN_NEW_EXCHANGES) },
      llmSummaryGenerator: async () => { throw circuitOpen; }
    });

    await expect(service.generateLlmSessionSummary('s')).rejects.toBe(circuitOpen);
    expect(appended).toHaveLength(0);
    expect(store.mergeEventMetadata).not.toHaveBeenCalled();
  });

  it('throws when the store could not replace the summary, so the session stays due', async () => {
    const { service } = createService({
      eventsBySession: { s: grownSession({}, SUMMARY_REFRESH_MIN_NEW_EXCHANGES) },
      appendResult: { success: false, error: 'SQLITE_BUSY' },
      llmSummaryGenerator: async () => ({ text: '- 결정: 새 요약', metadata: {} })
    });

    await expect(service.generateLlmSessionSummary('s')).rejects.toThrow('SQLITE_BUSY');
  });

  it('records an empty first summary on the newest prompt/answer the provider was shown (#206)', async () => {
    const { service, store } = createService({
      eventsBySession: { s: sessionEvents },
      llmSummaryGenerator: async () => null,
      now: () => new Date('2026-11-21T00:00:00.000Z')
    });

    await expect(service.generateLlmSessionSummary('s')).resolves.toBe(false);
    expect(store.mergeEventMetadata).toHaveBeenCalledExactlyOnceWith('22222222-2222-4222-8222-222222222222', {
      emptySummaryVerdict: { judgedAt: '2026-11-21T00:00:00.000Z', exchangeCount: 2 }
    });
  });

  it('does not ask again while nothing was said after an empty verdict, and does once something was', async () => {
    const generator = vi.fn(async () => null);
    const judged = sessionEvents.map((e) => e.eventType === 'agent_response'
      ? { ...e, metadata: { emptySummaryVerdict: { judgedAt: '2026-11-20T00:00:00.000Z', exchangeCount: 2 } } }
      : e);
    const resumed = [...judged, event({ id: '44444444-4444-4444-8444-444444444444', sessionId: 's', content: '이어서 하자' })];
    const { service, store } = createService({
      eventsBySession: { judged, resumed },
      llmSummaryGenerator: generator
    });

    await expect(service.generateLlmSessionSummary('judged')).resolves.toBe(false);
    expect(generator).not.toHaveBeenCalled();
    expect(store.mergeEventMetadata).not.toHaveBeenCalled();

    await service.generateLlmSessionSummary('resumed');
    expect(generator).toHaveBeenCalledOnce();
    expect(store.mergeEventMetadata).toHaveBeenCalledExactlyOnceWith('44444444-4444-4444-8444-444444444444', {
      emptySummaryVerdict: expect.objectContaining({ exchangeCount: 3 })
    });
  });

  it('records no empty verdict when the provider call fails', async () => {
    const circuitOpen = Object.assign(new Error('skipped'), { code: 'provider-circuit-open' });
    const { service, store } = createService({
      eventsBySession: { s: sessionEvents },
      llmSummaryGenerator: async () => { throw circuitOpen; }
    });

    await expect(service.generateLlmSessionSummary('s')).rejects.toBe(circuitOpen);
    expect(store.mergeEventMetadata).not.toHaveBeenCalled();
  });

  it('is inert when no generator is configured', async () => {
    const { service, appended } = createService({ eventsBySession: { s: sessionEvents } });
    await expect(service.generateLlmSessionSummary('s')).resolves.toBe(false);
    expect(appended).toHaveLength(0);
  });
});

describe('isLlmSessionSummaryDue', () => {
  const policy = DEFAULT_SESSION_SUMMARY_REFRESH;
  const summarized = (exchangeCount: number, coveredExchanges: number, refreshes = 0) =>
    ({ exchangeCount, summary: { coveredExchanges, refreshes } });

  it('is due for a session without a summary, whatever the refresh policy', () => {
    expect(isLlmSessionSummaryDue({ exchangeCount: 2 }, policy)).toBe(true);
    expect(isLlmSessionSummaryDue({ exchangeCount: 2 }, { ...policy, enabled: false })).toBe(true);
  });

  it('holds an empty verdict until the session gains a prompt or answer, whatever the refresh policy', () => {
    for (const p of [policy, { ...policy, enabled: false }]) {
      expect(isLlmSessionSummaryDue({ exchangeCount: 2, emptyVerdict: { coveredExchanges: 2 } }, p)).toBe(false);
      expect(isLlmSessionSummaryDue({ exchangeCount: 3, emptyVerdict: { coveredExchanges: 2 } }, p)).toBe(true);
    }
  });

  it('is due once the session has gained minNewExchanges since its summary, not one before', () => {
    expect(isLlmSessionSummaryDue(summarized(2 + policy.minNewExchanges - 1, 2), policy)).toBe(false);
    expect(isLlmSessionSummaryDue(summarized(2 + policy.minNewExchanges, 2), policy)).toBe(true);
  });

  it('stops at maxRefreshesPerSession, and never refreshes when turned off', () => {
    const grown = 2 + 10 * policy.minNewExchanges;
    expect(isLlmSessionSummaryDue(summarized(grown, 2, policy.maxRefreshesPerSession - 1), policy)).toBe(true);
    expect(isLlmSessionSummaryDue(summarized(grown, 2, policy.maxRefreshesPerSession), policy)).toBe(false);
    expect(isLlmSessionSummaryDue(summarized(grown, 2), { ...policy, enabled: false })).toBe(false);
    expect(isLlmSessionSummaryDue(summarized(grown, 2), { ...policy, maxRefreshesPerSession: 0 })).toBe(false);
  });
});

describe('MemoryIngestService.getSessionsDueForLlmSummary', () => {
  const now = new Date('2026-11-18T00:00:00.000Z');
  const candidates: SessionSummaryCandidate[] = [
    { sessionId: 'unsummarized', lastEventAt: '2026-11-17T05:00:00.000Z' },
    {
      sessionId: 'grown',
      lastEventAt: '2026-11-17T04:00:00.000Z',
      summary: { exchangeCount: 12, exchangesBeforeSummary: 2, metadata: { summarizedExchangeCount: 2 } }
    },
    {
      sessionId: 'not-grown-enough',
      lastEventAt: '2026-11-17T03:00:00.000Z',
      summary: { exchangeCount: 11, exchangesBeforeSummary: 2, metadata: { summarizedExchangeCount: 2 } }
    },
    {
      sessionId: 'capped',
      lastEventAt: '2026-11-17T02:00:00.000Z',
      summary: { exchangeCount: 60, exchangesBeforeSummary: 2, metadata: { summarizedExchangeCount: 2, summaryRefreshes: 3 } }
    },
    {
      // Written before refreshes existed: coverage is what was stored before it.
      sessionId: 'legacy-grown',
      lastEventAt: '2026-11-17T01:00:00.000Z',
      summary: { exchangeCount: 12, exchangesBeforeSummary: 2, metadata: { generated: 'llm' } }
    }
  ];

  it('lists sessions without a summary and summaries due for a refresh, most recent first, up to the limit', async () => {
    const { service, store } = createService({ now: () => now });
    store.getLlmSummaryCandidates.mockResolvedValue(candidates);

    await expect(service.getSessionsDueForLlmSummary('current', 5)).resolves.toEqual(['unsummarized', 'grown', 'legacy-grown']);
    await expect(service.getSessionsDueForLlmSummary('current', 2)).resolves.toEqual(['unsummarized', 'grown']);
    expect(store.getLlmSummaryCandidates).toHaveBeenCalledWith('current', {
      limit: 5,
      refreshSince: new Date(now.getTime() - SUMMARY_REFRESH_BACKFILL_WINDOW_MS)
    });
  });

  it('asks only for unsummarized sessions when refreshes are off', async () => {
    const { service, store } = createService({
      now: () => now,
      summaryRefresh: { ...DEFAULT_SESSION_SUMMARY_REFRESH, enabled: false }
    });
    store.getLlmSummaryCandidates.mockResolvedValue(candidates);

    await expect(service.getSessionsDueForLlmSummary('current', 5)).resolves.toEqual(['unsummarized']);
    expect(store.getLlmSummaryCandidates).toHaveBeenCalledWith('current', { limit: 5, refreshSince: undefined });
  });

  it('never generates a summary itself', async () => {
    const generator = vi.fn(async () => ({ text: '- x', metadata: {} }));
    const { service, store, appended } = createService({ llmSummaryGenerator: generator });
    store.getLlmSummaryCandidates.mockResolvedValue(candidates);

    await service.getSessionsDueForLlmSummary('current', 5);
    expect(generator).not.toHaveBeenCalled();
    expect(appended).toHaveLength(0);
  });
});
