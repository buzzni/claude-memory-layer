import * as path from 'path';
import * as os from 'os';
import { mkdtemp, rm, stat } from 'fs/promises';
import { describe, expect, it, vi } from 'vitest';

import {
  createMemoryEngineServices,
  type MemoryEngineServicesFactories
} from '../src/core/engine/memory-engine-services.js';
import type { AppendResult, MemoryEvent, MemoryEventInput, ToolObservationPayload } from '../src/core/types.js';
import type { RetrievalServicesDeps } from '../src/core/engine/retrieval-services.js';

function event(id = 'e1'): MemoryEvent {
  return {
    id,
    sessionId: 's1',
    eventType: 'user_prompt',
    content: 'thin core factory event',
    canonicalKey: `test/${id}`,
    dedupeKey: `s1:${id}`,
    timestamp: new Date('2026-05-02T00:00:00.000Z'),
    metadata: {}
  };
}

describe('createMemoryEngineServices', () => {
  it('creates the storage directory and wires storage-backed engine services', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'memory-engine-services-'));
    const storagePath = path.join(root, 'memory');
    const initialize = vi.fn(async () => {});
    const ingestEvent = vi.fn(async (options: {
      operation: string;
      input: MemoryEventInput;
      embeddingContent?: string;
    }): Promise<AppendResult> => ({
      success: true,
      eventId: `event:${options.operation}`,
      isDuplicate: false
    }));
    const createToolEmbedding = vi.fn((payload: ToolObservationPayload) => `${payload.toolName}:${payload.success}`);
    const enqueueForEmbedding = vi.fn(async (_eventId: string, _content: string) => {});
    const sqliteStore = {
      enqueueForEmbedding,
      keywordSearch: vi.fn(async (_query: string, _topK: number) => [{ event: event('keyword'), rank: -0.1 }]),
      getSessionEvents: vi.fn(async (_sessionId: string) => [event('session')]),
      getRecentEvents: vi.fn(async (_limit?: number) => [event('recent')]),
      getEvent: vi.fn(async (id: string) => event(id)),
      recordRetrievalTrace: vi.fn(async (_input: Record<string, unknown>) => {}),
      incrementAccessCount: vi.fn(async (_eventIds: string[]) => {}),
      recordRetrieval: vi.fn(async (_eventId: string, _sessionId: string, _score: number, _query: string) => {}),
      getRetrievalTraceStats: vi.fn(async () => ({
        totalQueries: 0,
        avgCandidateCount: 0,
        avgSelectedCount: 0,
        selectionRate: 0
      })),
      getRecentRetrievalTraces: vi.fn(async () => []),
      getMostAccessed: vi.fn(async () => []),
      evaluateSessionHelpfulness: vi.fn(async (_sessionId: string) => {}),
      getUnevaluatedSessions: vi.fn(async () => []),
      getHelpfulMemories: vi.fn(async () => []),
      getHelpfulnessStats: vi.fn(async () => ({
        avgScore: 0,
        totalEvaluated: 0,
        totalRetrievals: 0,
        helpful: 0,
        neutral: 0,
        unhelpful: 0
      }))
    };
    const vectorStore = { marker: 'vector' };
    const embedder = { marker: 'embedder' };
    const matcher = { marker: 'matcher' };
    const graduation = { marker: 'graduation' };
    const mdMirror = { marker: 'mirror' };
    const retrievalBundle = {
      retriever: { marker: 'retriever' },
      retrievalOrchestrator: { marker: 'orchestrator' },
      retrievalDisclosureService: { marker: 'disclosure' },
      retrievalAnalyticsService: { marker: 'analytics' }
    };
    let retrievalDeps: RetrievalServicesDeps | null = null;

    const factories: MemoryEngineServicesFactories = {
      createSQLiteEventStore: vi.fn((dbPath, options) => {
        expect(dbPath).toBe(path.join(storagePath, 'events.sqlite'));
        expect(options).toEqual({ readonly: false, markdownMirrorRoot: storagePath });
        return sqliteStore as any;
      }),
      createVectorStore: vi.fn((vectorsPath) => {
        expect(vectorsPath).toBe(path.join(storagePath, 'vectors'));
        return vectorStore as any;
      }),
      createEmbedder: vi.fn((model: string) => {
        expect(model).toBe('custom-embedding-model');
        return embedder as any;
      }),
      getDefaultEmbedder: vi.fn(() => {
        throw new Error('custom model should use createEmbedder');
      }),
      getDefaultMatcher: vi.fn(() => matcher as any),
      createMarkdownMirror: vi.fn((cwd: string) => {
        expect(cwd).toBe('/workspace/project');
        return mdMirror as any;
      }),
      createGraduationPipeline: vi.fn((store) => {
        expect(store).toBe(sqliteStore);
        return graduation as any;
      }),
      createRetrievalServices: vi.fn((deps) => {
        retrievalDeps = deps;
        return retrievalBundle as any;
      })
    };

    try {
      const services = createMemoryEngineServices({
        storagePath,
        readOnly: false,
        embeddingModel: 'custom-embedding-model',
        cwd: '/workspace/project',
        initialize,
        getProjectHash: () => 'project-1',
        hasSharedStore: () => false,
        sharedStore: { get: async () => null },
        ingestEvent,
        createToolObservationEmbedding: createToolEmbedding,
        factories
      });

      await expect(stat(storagePath)).resolves.toMatchObject({});
      expect(services).toMatchObject({
        storagePath,
        sqliteStore,
        vectorStore,
        embedder,
        matcher,
        graduation,
        mdMirror,
        retriever: retrievalBundle.retriever,
        retrievalOrchestrator: retrievalBundle.retrievalOrchestrator,
        retrievalDisclosureService: retrievalBundle.retrievalDisclosureService,
        retrievalAnalyticsService: retrievalBundle.retrievalAnalyticsService
      });
      expect(retrievalDeps).toMatchObject({
        initialize,
        eventStore: sqliteStore,
        vectorStore,
        embedder,
        matcher,
        sharedStore: { get: expect.any(Function) }
      });
      expect(retrievalDeps?.getProjectHash()).toBe('project-1');
      expect(retrievalDeps?.hasSharedStore()).toBe(false);

      await services.ingestService.storeUserPrompt('s1', 'remember factory wiring', { source: 'test' });
      expect(initialize).not.toHaveBeenCalled();
      expect(ingestEvent).toHaveBeenCalledWith(expect.objectContaining({
        operation: 'user_prompt',
        embeddingContent: 'remember factory wiring',
        input: expect.objectContaining({
          eventType: 'user_prompt',
          sessionId: 's1',
          content: 'remember factory wiring',
          metadata: { source: 'test' }
        })
      }));

      await services.queryService.getRecentEvents(3);
      expect(sqliteStore.getRecentEvents).toHaveBeenCalledWith(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not create the storage directory before sqlite store construction in read-only mode', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'memory-engine-services-readonly-'));
    const storagePath = path.join(root, 'readonly-memory');
    const factories: MemoryEngineServicesFactories = {
      createSQLiteEventStore: vi.fn(() => ({}) as any),
      createVectorStore: vi.fn(() => ({}) as any),
      getDefaultEmbedder: vi.fn(() => ({}) as any),
      getDefaultMatcher: vi.fn(() => ({}) as any),
      createMarkdownMirror: vi.fn(() => ({}) as any),
      createGraduationPipeline: vi.fn(() => ({}) as any),
      createRetrievalServices: vi.fn(() => ({
        retriever: {},
        retrievalOrchestrator: {},
        retrievalDisclosureService: {},
        retrievalAnalyticsService: {}
      }) as any)
    };

    try {
      createMemoryEngineServices({
        storagePath,
        readOnly: true,
        cwd: '/workspace/project',
        initialize: async () => {},
        getProjectHash: () => null,
        hasSharedStore: () => false,
        ingestEvent: async () => ({ success: true, eventId: 'e1', isDuplicate: false }),
        createToolObservationEmbedding: () => 'embedding',
        factories
      });

      // This asserts the extracted factory does not eagerly mkdir in read-only mode
      // before delegating to the sqlite-store constructor. The production sqlite
      // layer may still require/open an existing read-only database.
      await expect(stat(storagePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(factories.createSQLiteEventStore).toHaveBeenCalledWith(
        path.join(storagePath, 'events.sqlite'),
        { readonly: true, markdownMirrorRoot: storagePath }
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
