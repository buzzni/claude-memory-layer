import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { Matcher } from '../../src/core/matcher.js';
import { createRetrievalOrchestrator } from '../../src/core/engine/retrieval-orchestrator.js';
import { Retriever, type UnifiedRetrievalResult } from '../../src/core/retriever.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteRun } from '../../src/core/sqlite-wrapper.js';
import type { MemoryEvent, MemoryOperationsConfig } from '../../src/core/types.js';
import { DISABLED_MEMORY_OPERATIONS_CONFIG } from '../../src/services/memory-service-config.js';

const tempDirs: string[] = [];
const FIXED_TIME = new Date('2026-05-20T00:00:00.000Z');

async function createStore(): Promise<SQLiteEventStore> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-retriever-graph-path-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  return store;
}

async function appendEvent(store: SQLiteEventStore, input: {
  content: string;
  eventType?: MemoryEvent['eventType'];
  sessionId?: string;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const result = await store.append({
    eventType: input.eventType ?? 'agent_response',
    sessionId: input.sessionId ?? 's1',
    timestamp: FIXED_TIME,
    content: input.content,
    metadata: input.metadata ?? {}
  });
  if (!result.success) {
    throw new Error('error' in result ? result.error : 'append failed');
  }
  return result.eventId;
}

function insertEntity(store: SQLiteEventStore, input: {
  entityId: string;
  canonicalKey: string;
  title: string;
}): void {
  sqliteRun(
    store.getDatabase(),
    `INSERT INTO entities (
      entity_id, entity_type, canonical_key, title, stage, status,
      current_json, title_norm, search_text, created_at, updated_at
    ) VALUES (?, 'task', ?, ?, 'verified', 'active', ?, ?, ?, ?, ?)`,
    [
      input.entityId,
      input.canonicalKey,
      input.title,
      JSON.stringify({ fixture: true }),
      input.title.toLowerCase(),
      input.title,
      FIXED_TIME.toISOString(),
      FIXED_TIME.toISOString()
    ]
  );
  sqliteRun(
    store.getDatabase(),
    `INSERT INTO entity_aliases (entity_type, canonical_key, entity_id, is_primary, created_at)
     VALUES ('task', ?, ?, 1, ?)`,
    [input.canonicalKey, input.entityId, FIXED_TIME.toISOString()]
  );
}

function insertEvidenceEdge(store: SQLiteEventStore, input: {
  edgeId: string;
  eventId: string;
  entityId: string;
  weight?: number;
}): void {
  sqliteRun(
    store.getDatabase(),
    `INSERT INTO edges (edge_id, src_type, src_id, rel_type, dst_type, dst_id, meta_json, created_at)
     VALUES (?, 'event', ?, 'evidence_of', 'entity', ?, ?, ?)`,
    [
      input.edgeId,
      input.eventId,
      input.entityId,
      JSON.stringify({ weight: input.weight ?? 0.9 }),
      FIXED_TIME.toISOString()
    ]
  );
}

function createRetriever(store: SQLiteEventStore, queryGraphExpansionEnabled = false): Retriever {
  const fakeVectorStore = { async search() { return []; } };
  const fakeEmbedder = { async embed() { return { vector: [0.1, 0.2] }; } };
  return new Retriever(store as any, fakeVectorStore as any, fakeEmbedder as any, new Matcher(), { queryGraphExpansionEnabled });
}

function emptyResult(): UnifiedRetrievalResult {
  return {
    memories: [],
    matchResult: { match: null, confidence: 'none' },
    totalTokens: 0,
    context: '',
    fallbackTrace: ['stage:primary:fast'],
    selectedDebug: [],
    candidateDebug: []
  };
}

function operationsConfig(graphExpansion: MemoryOperationsConfig['graphExpansion']): MemoryOperationsConfig {
  return {
    ...DISABLED_MEMORY_OPERATIONS_CONFIG,
    enabled: true,
    graphExpansion
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Retriever graph path expansion', () => {
  it('only changes retrieval ranking when graph expansion is explicitly enabled', async () => {
    const store = await createStore();
    try {
      const targetEventId = await appendEvent(store, {
        content: 'Bounded traversal evidence explains an otherwise undiscoverable retrieval result.'
      });
      insertEntity(store, {
        entityId: 'entity-graph-path-service',
        canonicalKey: 'task:default:graph_expansion',
        title: 'Graph Expansion'
      });
      insertEvidenceEdge(store, {
        edgeId: 'edge-target-graph-path',
        eventId: targetEventId,
        entityId: 'entity-graph-path-service',
        weight: 0.9
      });

      const disabled = await createRetriever(store).retrieve('Graph Expansion', {
        strategy: 'fast',
        topK: 5,
        includeSessionContext: false,
        graphHop: { enabled: true, maxHops: 1, hopPenalty: 0.1 }
      });
      expect(disabled.memories.map((memory) => memory.event.id)).not.toContain(targetEventId);

      const enabled = await createRetriever(store, true).retrieve('Graph Expansion', {
        strategy: 'fast',
        topK: 5,
        includeSessionContext: false,
        graphHop: { enabled: true, maxHops: 1, hopPenalty: 0.1 }
      });

      expect(enabled.memories.map((memory) => memory.event.id)).toContain(targetEventId);
      expect(enabled.selectedDebug?.find((detail) => detail.eventId === targetEventId)).toMatchObject({
        graphPaths: [
          expect.objectContaining({
            startEntityId: 'entity-graph-path-service',
            startEntityTitle: 'Graph Expansion',
            targetId: targetEventId,
            targetType: 'event',
            hops: 1,
            relationPath: ['evidence_of']
          })
        ]
      });
    } finally {
      await store.close();
    }
  });

  it('uses operations.graphExpansion.enabled as the orchestrator feature flag for default retrieval calls', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeRetriever = {
      setQueryRewriter() {},
      retrieve: async (_query: string, options: Record<string, unknown>) => {
        calls.push(options);
        return emptyResult();
      },
      retrieveUnified: async (_query: string, options: Record<string, unknown>) => {
        calls.push(options);
        return emptyResult();
      }
    };
    const commonDeps = {
      initialize: async () => {},
      retriever: fakeRetriever as unknown as Retriever,
      traceStore: {
        getHelpfulnessStats: async () => ({ avgScore: 0, totalEvaluated: 0, totalRetrievals: 0, helpful: 0, neutral: 0, unhelpful: 0 }),
        recordRetrievalTrace: async () => {}
      },
      accessStore: {
        incrementAccessCount: async () => {},
        recordRetrieval: async () => {}
      },
      getProjectHash: () => null,
      hasSharedStore: () => false
    };

    const disabledOrchestrator = createRetrievalOrchestrator({
      ...commonDeps,
      memoryOperationsConfig: operationsConfig({ enabled: false, maxHops: 2 })
    } as any);
    await disabledOrchestrator.retrieveMemories('GraphPathService', { strategy: 'fast', recordTrace: false });
    expect(calls.at(-1)?.graphHop).toBeUndefined();

    await disabledOrchestrator.retrieveMemories('GraphPathService', {
      strategy: 'fast',
      recordTrace: false,
      graphHop: { enabled: true, maxHops: 2 }
    });
    expect(calls.at(-1)?.graphHop).toMatchObject({ enabled: false, maxHops: 2 });

    const enabledOrchestrator = createRetrievalOrchestrator({
      ...commonDeps,
      memoryOperationsConfig: operationsConfig({ enabled: true, maxHops: 2 })
    } as any);
    await enabledOrchestrator.retrieveMemories('GraphPathService', { strategy: 'fast', recordTrace: false });
    expect(calls.at(-1)?.graphHop).toMatchObject({ enabled: true, maxHops: 2 });
  });
});
