/**
 * Memory Engine Services Bundle
 *
 * Owns construction and wiring for storage-backed engine services so
 * MemoryService can stay focused on public facade/lifecycle behavior.
 */

import * as fs from 'fs';
import * as path from 'path';

import { Embedder, getDefaultEmbedder } from '../embedder.js';
import type { EventStore } from '../event-store.js';
import { createGraduationPipeline, type GraduationPipeline } from '../graduation.js';
import { getDefaultMatcher, type Matcher } from '../matcher.js';
import { MarkdownMirror } from '../md-mirror.js';
import type { Retriever } from '../retriever.js';
import { SQLiteEventStore } from '../sqlite-event-store.js';
import type { AppendResult, MemoryEventInput, ToolObservationPayload } from '../types.js';
import { VectorStore } from '../vector-store.js';
import { MemoryIngestService } from './memory-ingest-service.js';
import { MemoryQueryService } from './memory-query-service.js';
import {
  createRetrievalServices,
  type RetrievalAnalyticsService,
  type RetrievalDisclosureService,
  type RetrievalDisclosureSharedStore,
  type RetrievalEventStore,
  type RetrievalOrchestrator,
  type RetrievalServices,
  type RetrievalServicesDeps
} from './retrieval-services.js';

export type MemoryIngestOperation =
  | 'user_prompt'
  | 'agent_response'
  | 'session_summary'
  | 'tool_observation';

export interface MemoryEngineIngestInput {
  operation: MemoryIngestOperation;
  input: MemoryEventInput;
  embeddingContent?: string;
}

export interface MemoryEngineServicesOptions {
  storagePath: string;
  readOnly: boolean;
  embeddingModel?: string;
  cwd?: string;
  initialize: () => Promise<void>;
  getProjectHash: () => string | null;
  hasSharedStore: () => boolean;
  sharedStore?: RetrievalDisclosureSharedStore;
  ingestEvent: (input: MemoryEngineIngestInput) => Promise<AppendResult>;
  createToolObservationEmbedding: (payload: ToolObservationPayload) => string;
  factories?: MemoryEngineServicesFactories;
}

export interface MemoryEngineServicesFactories {
  createSQLiteEventStore?: (
    dbPath: string,
    options: { readonly: boolean; markdownMirrorRoot: string }
  ) => SQLiteEventStore;
  createVectorStore?: (vectorsPath: string) => VectorStore;
  createEmbedder?: (model: string) => Embedder;
  getDefaultEmbedder?: () => Embedder;
  getDefaultMatcher?: () => Matcher;
  createMarkdownMirror?: (cwd: string) => MarkdownMirror;
  createGraduationPipeline?: (eventStore: EventStore) => GraduationPipeline;
  createRetrievalServices?: (deps: RetrievalServicesDeps) => RetrievalServices;
}

export interface MemoryEngineServices {
  storagePath: string;
  sqliteStore: SQLiteEventStore;
  vectorStore: VectorStore;
  embedder: Embedder;
  matcher: Matcher;
  retriever: Retriever;
  retrievalOrchestrator: RetrievalOrchestrator;
  retrievalDisclosureService: RetrievalDisclosureService;
  retrievalAnalyticsService: RetrievalAnalyticsService;
  graduation: GraduationPipeline;
  mdMirror: MarkdownMirror;
  ingestService: MemoryIngestService;
  queryService: MemoryQueryService;
}

export function createMemoryEngineServices(options: MemoryEngineServicesOptions): MemoryEngineServices {
  const factories = options.factories ?? {};
  const storagePath = options.storagePath;

  if (!options.readOnly && !fs.existsSync(storagePath)) {
    fs.mkdirSync(storagePath, { recursive: true });
  }

  const sqliteStore = (factories.createSQLiteEventStore ?? defaultCreateSQLiteEventStore)(
    path.join(storagePath, 'events.sqlite'),
    {
      readonly: options.readOnly,
      markdownMirrorRoot: storagePath
    }
  );
  const vectorStore = (factories.createVectorStore ?? defaultCreateVectorStore)(
    path.join(storagePath, 'vectors')
  );
  const embeddingModel = options.embeddingModel || process.env.CLAUDE_MEMORY_EMBEDDING_MODEL;
  const embedder = embeddingModel
    ? (factories.createEmbedder ?? defaultCreateEmbedder)(embeddingModel)
    : (factories.getDefaultEmbedder ?? getDefaultEmbedder)();
  const matcher = (factories.getDefaultMatcher ?? getDefaultMatcher)();
  const mdMirror = (factories.createMarkdownMirror ?? defaultCreateMarkdownMirror)(
    options.cwd ?? process.cwd()
  );
  const graduation = (factories.createGraduationPipeline ?? defaultCreateGraduationPipeline)(
    sqliteStore as unknown as EventStore
  );

  const retrievalServices = (factories.createRetrievalServices ?? createRetrievalServices)({
    initialize: options.initialize,
    eventStore: sqliteStore as unknown as RetrievalEventStore,
    vectorStore,
    embedder,
    matcher,
    getProjectHash: options.getProjectHash,
    hasSharedStore: options.hasSharedStore,
    sharedStore: options.sharedStore
  });

  const ingestService = new MemoryIngestService(
    options.initialize,
    sqliteStore,
    options.ingestEvent,
    options.createToolObservationEmbedding
  );
  const queryService = new MemoryQueryService(
    options.initialize,
    sqliteStore,
    { vectorStore, graduation }
  );

  return {
    storagePath,
    sqliteStore,
    vectorStore,
    embedder,
    matcher,
    retriever: retrievalServices.retriever,
    retrievalOrchestrator: retrievalServices.retrievalOrchestrator,
    retrievalDisclosureService: retrievalServices.retrievalDisclosureService,
    retrievalAnalyticsService: retrievalServices.retrievalAnalyticsService,
    graduation,
    mdMirror,
    ingestService,
    queryService
  };
}

function defaultCreateSQLiteEventStore(
  dbPath: string,
  options: { readonly: boolean; markdownMirrorRoot: string }
): SQLiteEventStore {
  return new SQLiteEventStore(dbPath, options);
}

function defaultCreateVectorStore(vectorsPath: string): VectorStore {
  return new VectorStore(vectorsPath);
}

function defaultCreateEmbedder(model: string): Embedder {
  return new Embedder(model);
}

function defaultCreateMarkdownMirror(cwd: string): MarkdownMirror {
  return new MarkdownMirror(cwd);
}

function defaultCreateGraduationPipeline(eventStore: EventStore): GraduationPipeline {
  return createGraduationPipeline(eventStore);
}
