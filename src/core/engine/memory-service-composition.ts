/**
 * Memory Service Composition
 *
 * Owns constructor-time service graph wiring for MemoryService so the public
 * facade can stay focused on state assignment and method delegation.
 */

import * as os from 'os';
import * as path from 'path';

import type { EventStore } from '../event-store.js';
import type { Embedder } from '../embedder.js';
import type { GraduationPipeline } from '../graduation.js';
import { createToolObservationEmbedding as defaultCreateToolObservationEmbedding } from '../metadata-extractor.js';
import type { Retriever } from '../retriever.js';
import type { SQLiteEventStore } from '../sqlite-event-store.js';
import type { ToolObservationPayload, SharedStoreConfig } from '../types.js';
import type { VectorStore } from '../vector-store.js';
import {
  createEmbeddingMaintenanceService as defaultCreateEmbeddingMaintenanceService,
  type EmbeddingMaintenanceService,
  type EmbeddingMaintenanceServiceOptions
} from './embedding-maintenance-service.js';
import {
  createEndlessMemoryServices as defaultCreateEndlessMemoryServices,
  type EndlessMemoryServices,
  type EndlessMemoryServicesOptions
} from './endless-memory-services.js';
import {
  createMemoryEngineServices as defaultCreateMemoryEngineServices,
  type MemoryEngineServices,
  type MemoryEngineServicesOptions
} from './memory-engine-services.js';
import {
  createMemoryRuntimeService as defaultCreateMemoryRuntimeService,
  type MemoryRuntimeService,
  type MemoryRuntimeServicesDeps
} from './memory-runtime-service.js';
import type {
  MemoryIngestService
} from './memory-ingest-service.js';
import type {
  MemoryQueryService
} from './memory-query-service.js';
import {
  createSharedMemoryServices as defaultCreateSharedMemoryServices,
  type SharedMemoryServices,
  type SharedMemoryServicesOptions
} from './shared-memory-services.js';
import type {
  RetrievalAnalyticsService,
  RetrievalDisclosureService,
  RetrievalOrchestrator
} from './retrieval-services.js';

export interface MemoryServiceCompositionConfig {
  storagePath: string;
  embeddingModel?: string;
  readOnly?: boolean;
  lightweightMode?: boolean;
  embeddingOnly?: boolean;
  projectHash?: string;
  projectPath?: string;
  sharedStoreConfig?: SharedStoreConfig;
}

export interface MemoryServiceCompositionFactories {
  expandPath?: (targetPath: string) => string;
  createToolObservationEmbedding?: (
    toolName: string,
    metadata: Record<string, unknown>,
    success: boolean
  ) => string;
  createMemoryEngineServices?: (options: MemoryEngineServicesOptions) => MemoryEngineServices;
  createEndlessMemoryServices?: (options: EndlessMemoryServicesOptions) => EndlessMemoryServices;
  createSharedMemoryServices?: (options: SharedMemoryServicesOptions) => SharedMemoryServices;
  createMemoryRuntimeService?: (deps: MemoryRuntimeServicesDeps) => MemoryRuntimeService;
  createEmbeddingMaintenanceService?: (
    options: EmbeddingMaintenanceServiceOptions
  ) => EmbeddingMaintenanceService;
}

export interface MemoryServiceCompositionOptions {
  config: MemoryServiceCompositionConfig;
  defaultSharedStoragePath: string;
  defaultSharedStoreConfig?: SharedStoreConfig;
  initialize: () => Promise<void>;
  getProjectHash: () => string | null;
  getProjectPath?: () => string | null;
  factories?: MemoryServiceCompositionFactories;
}

export interface MemoryServiceComposition {
  storagePath: string;
  readOnly: boolean;
  lightweightMode: boolean;
  embeddingOnly: boolean;
  sqliteStore: SQLiteEventStore;
  vectorStore: VectorStore;
  embedder: Embedder;
  retriever: Retriever;
  retrievalOrchestrator: RetrievalOrchestrator;
  retrievalDisclosureService: RetrievalDisclosureService;
  retrievalAnalyticsService: RetrievalAnalyticsService;
  embeddingMaintenanceService: EmbeddingMaintenanceService;
  runtimeService: MemoryRuntimeService;
  graduation: GraduationPipeline;
  endlessMemoryServices: EndlessMemoryServices;
  sharedMemoryServices: SharedMemoryServices;
  ingestService: MemoryIngestService;
  queryService: MemoryQueryService;
}

export function createMemoryServiceComposition(
  options: MemoryServiceCompositionOptions
): MemoryServiceComposition {
  const factories = options.factories ?? {};
  const expandPath = factories.expandPath ?? defaultExpandPath;
  const createToolEmbedding = factories.createToolObservationEmbedding ?? defaultCreateToolObservationEmbedding;

  const storagePath = expandPath(options.config.storagePath);
  const readOnly = options.config.readOnly ?? false;
  const lightweightMode = options.config.lightweightMode ?? false;
  const embeddingOnly = options.config.embeddingOnly ?? false;
  const sharedStoreConfig = options.config.sharedStoreConfig ?? options.defaultSharedStoreConfig ?? {
    enabled: true,
    autoPromote: true,
    searchShared: true,
    minConfidenceForPromotion: 0.8,
    sharedStoragePath: options.defaultSharedStoragePath
  };

  let sharedMemoryServices: SharedMemoryServices | null = null;

  const engineServices = (factories.createMemoryEngineServices ?? defaultCreateMemoryEngineServices)({
    storagePath,
    readOnly,
    embeddingModel: options.config.embeddingModel,
    cwd: process.cwd(),
    initialize: options.initialize,
    getProjectHash: options.getProjectHash,
    getProjectPath: options.getProjectPath,
    hasSharedStore: () => sharedMemoryServices?.isEnabled() ?? false,
    sharedStore: {
      get: (entryId: string) => sharedMemoryServices?.getEntryForDisclosure(entryId) ?? Promise.resolve(null)
    },
    createToolObservationEmbedding: (payload: ToolObservationPayload) => createToolEmbedding(
      payload.toolName,
      payload.metadata || {},
      payload.success
    )
  });

  const endlessMemoryServices = (factories.createEndlessMemoryServices ?? defaultCreateEndlessMemoryServices)({
    eventStore: engineServices.sqliteStore as unknown as EventStore,
    configStore: engineServices.sqliteStore,
    initialize: options.initialize
  });

  sharedMemoryServices = (factories.createSharedMemoryServices ?? defaultCreateSharedMemoryServices)({
    config: sharedStoreConfig,
    defaultSharedStoragePath: options.defaultSharedStoragePath,
    readOnly,
    expandPath,
    embedder: engineServices.embedder,
    retriever: engineServices.retriever
  });

  const runtimeService = (factories.createMemoryRuntimeService ?? defaultCreateMemoryRuntimeService)({
    sqliteStore: engineServices.sqliteStore,
    eventStore: engineServices.sqliteStore as unknown as EventStore,
    vectorStore: engineServices.vectorStore,
    embedder: engineServices.embedder,
    retriever: engineServices.retriever,
    graduation: engineServices.graduation,
    endlessMemoryServices,
    sharedMemoryServices,
    readOnly,
    lightweightMode,
    embeddingOnly
  });

  const embeddingMaintenanceService = (
    factories.createEmbeddingMaintenanceService ?? defaultCreateEmbeddingMaintenanceService
  )({
    storagePath,
    initialize: options.initialize,
    getEmbeddingModelName: () => engineServices.embedder.getModelName(),
    vectorStore: engineServices.vectorStore,
    eventStore: {
      clearEmbeddingOutbox: () => engineServices.sqliteStore.clearEmbeddingOutbox(),
      getEventsPage: async (limit, offset) => {
        const events = await engineServices.sqliteStore.getEventsPage(limit, offset);
        return events.map((event) => ({ id: event.id, content: event.content }));
      },
      enqueueForEmbedding: async (eventId, content) => {
        await engineServices.sqliteStore.enqueueForEmbedding(eventId, content);
      }
    },
    getVectorWorker: () => runtimeService.getVectorWorker()
  });

  return {
    storagePath,
    readOnly,
    lightweightMode,
    embeddingOnly,
    sqliteStore: engineServices.sqliteStore,
    vectorStore: engineServices.vectorStore,
    embedder: engineServices.embedder,
    retriever: engineServices.retriever,
    retrievalOrchestrator: engineServices.retrievalOrchestrator,
    retrievalDisclosureService: engineServices.retrievalDisclosureService,
    retrievalAnalyticsService: engineServices.retrievalAnalyticsService,
    embeddingMaintenanceService,
    runtimeService,
    graduation: engineServices.graduation,
    endlessMemoryServices,
    sharedMemoryServices,
    ingestService: engineServices.ingestService,
    queryService: engineServices.queryService
  };
}

function defaultExpandPath(targetPath: string): string {
  if (targetPath.startsWith('~')) {
    return path.join(os.homedir(), targetPath.slice(1));
  }
  return targetPath;
}
