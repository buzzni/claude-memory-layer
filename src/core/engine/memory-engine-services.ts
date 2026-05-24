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
import type { MemoryOperationsConfig, ToolObservationPayload } from '../types.js';
import {
  ActorRepository,
  PerspectiveObservationRepository,
  SessionActorRepository,
  createPerspectiveDeriver
} from '../operations/index.js';
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

export interface MemoryEngineServicesOptions {
  storagePath: string;
  readOnly: boolean;
  embeddingModel?: string;
  cwd?: string;
  initialize: () => Promise<void>;
  getProjectHash: () => string | null;
  getProjectPath?: () => string | null;
  hasSharedStore: () => boolean;
  memoryOperationsConfig?: MemoryOperationsConfig;
  sharedStore?: RetrievalDisclosureSharedStore;
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
  const perspectiveDeriver = shouldEnablePerspectiveDeriver(options)
    ? createPerspectiveDeriver({
        actors: new ActorRepository(sqliteStore.getDatabase()),
        sessions: new SessionActorRepository(sqliteStore.getDatabase()),
        observations: new PerspectiveObservationRepository(sqliteStore.getDatabase()),
        config: options.memoryOperationsConfig?.perspectiveMemory
      })
    : undefined;

  const retrievalServices = (factories.createRetrievalServices ?? createRetrievalServices)({
    initialize: options.initialize,
    eventStore: sqliteStore as unknown as RetrievalEventStore,
    vectorStore,
    embedder,
    matcher,
    getProjectHash: options.getProjectHash,
    hasSharedStore: options.hasSharedStore,
    memoryOperationsConfig: options.memoryOperationsConfig,
    sharedStore: options.sharedStore
  });

  const ingestService = new MemoryIngestService({
    initialize: options.initialize,
    eventStore: sqliteStore,
    markdownMirror: mdMirror,
    createToolEmbedding: options.createToolObservationEmbedding,
    getProjectHash: options.getProjectHash,
    getProjectPath: options.getProjectPath,
    perspectiveDeriver
  });
  const queryService = new MemoryQueryService(
    () => sqliteStore.initialize(),
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

function shouldEnablePerspectiveDeriver(options: MemoryEngineServicesOptions): boolean {
  if (options.readOnly) return false;
  const perspectiveMemory = options.memoryOperationsConfig?.perspectiveMemory;
  return perspectiveMemory?.enabled === true && perspectiveMemory.deriver?.enabled === true;
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
