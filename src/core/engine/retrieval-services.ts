/**
 * Retrieval Services Bundle
 *
 * Owns construction and wiring for retrieval-facing engine services so
 * MemoryService can hold a thin facade boundary instead of directly
 * instantiating each retrieval collaborator.
 */

import type { Embedder } from '../embedder.js';
import type { EventStore } from '../event-store.js';
import type { Matcher } from '../matcher.js';
import type { MemoryEvent } from '../types.js';
import {
  createRetriever as createCoreRetriever,
  type Retriever
} from '../retriever.js';
import type { VectorStore } from '../vector-store.js';
import {
  createRetrievalAnalyticsService,
  type RetrievalAnalyticsService,
  type RetrievalAnalyticsStore
} from './retrieval-analytics-service.js';
import {
  createRetrievalDisclosureService,
  type RetrievalDisclosureEventStore,
  type RetrievalDisclosureService
} from './retrieval-disclosure-service.js';
import {
  createRetrievalOrchestrator,
  type RetrievalAccessStore,
  type RetrievalOrchestrator,
  type RetrievalTraceStore
} from './retrieval-orchestrator.js';

export interface RetrievalSourceStore {
  getRecentEvents(limit?: number): Promise<MemoryEvent[]>;
}

export type RetrievalEventStore = RetrievalTraceStore
  & RetrievalAccessStore
  & RetrievalDisclosureEventStore
  & RetrievalAnalyticsStore
  & RetrievalSourceStore;

export type CreateRetrieverFn = (
  eventStore: RetrievalEventStore,
  vectorStore: VectorStore,
  embedder: Embedder,
  matcher: Matcher
) => Retriever;

export interface RetrievalServicesDeps {
  initialize: () => Promise<void>;
  eventStore: RetrievalEventStore;
  vectorStore: VectorStore;
  embedder: Embedder;
  matcher: Matcher;
  getProjectHash: () => string | null;
  hasSharedStore: () => boolean;
  createRetriever?: CreateRetrieverFn;
}

export interface RetrievalServices {
  retriever: Retriever;
  retrievalOrchestrator: RetrievalOrchestrator;
  retrievalDisclosureService: RetrievalDisclosureService;
  retrievalAnalyticsService: RetrievalAnalyticsService;
}

export function createRetrievalServices(deps: RetrievalServicesDeps): RetrievalServices {
  const retrieverFactory = deps.createRetriever ?? defaultCreateRetriever;
  const retriever = retrieverFactory(
    deps.eventStore,
    deps.vectorStore,
    deps.embedder,
    deps.matcher
  );
  const retrievalOrchestrator = createRetrievalOrchestrator({
    initialize: deps.initialize,
    retriever,
    traceStore: deps.eventStore,
    accessStore: deps.eventStore,
    getProjectHash: deps.getProjectHash,
    hasSharedStore: deps.hasSharedStore
  });
  const retrievalDisclosureService = createRetrievalDisclosureService({
    initialize: deps.initialize,
    retrievalOrchestrator,
    eventStore: deps.eventStore
  });
  const retrievalAnalyticsService = createRetrievalAnalyticsService({
    initialize: deps.initialize,
    retrievalStore: deps.eventStore
  });

  return {
    retriever,
    retrievalOrchestrator,
    retrievalDisclosureService,
    retrievalAnalyticsService
  };
}

function defaultCreateRetriever(
  eventStore: RetrievalEventStore,
  vectorStore: VectorStore,
  embedder: Embedder,
  matcher: Matcher
): Retriever {
  assertDefaultRetrieverStore(eventStore);
  return createCoreRetriever(
    eventStore as unknown as EventStore,
    vectorStore,
    embedder,
    matcher
  );
}

function assertDefaultRetrieverStore(eventStore: RetrievalEventStore): void {
  const store = eventStore as unknown as Record<string, unknown>;
  for (const method of ['getEvent', 'getSessionEvents', 'getRecentEvents']) {
    if (typeof store[method] !== 'function') {
      throw new TypeError(`Default retrieval service eventStore requires ${method}()`);
    }
  }
}

export {
  RetrievalAnalyticsService,
  createRetrievalAnalyticsService
} from './retrieval-analytics-service.js';
export type {
  AccessedMemory,
  HelpfulMemory,
  HelpfulnessStats,
  RetrievalAnalyticsServiceDeps,
  RetrievalAnalyticsStore,
  RetrievalTrace,
  RetrievalTraceStats
} from './retrieval-analytics-service.js';
export {
  RetrievalDisclosureService,
  createRetrievalDisclosureService,
  parseDisclosureResultId,
  toDisclosureResultId
} from './retrieval-disclosure-service.js';
export type {
  RetrievalDisclosureEnvelope,
  RetrievalDisclosureEventStore,
  RetrievalDisclosureExpansion,
  RetrievalDisclosureExpandOptions,
  RetrievalDisclosureOrchestrator,
  RetrievalDisclosureReason,
  RetrievalDisclosureSearchOptions,
  RetrievalDisclosureSearchResponse,
  RetrievalDisclosureServiceDeps,
  RetrievalDisclosureSource,
  RetrievalDisclosureSourceReference,
  RetrievalDisclosureSourceType
} from './retrieval-disclosure-service.js';
export {
  RetrievalOrchestrator,
  createRetrievalOrchestrator
} from './retrieval-orchestrator.js';
export type {
  RecordQueryTraceInput,
  RetrievalAccessStore,
  RetrievalOrchestratorDeps,
  RetrievalTraceStore,
  RetrieveMemoriesOptions
} from './retrieval-orchestrator.js';
