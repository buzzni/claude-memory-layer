/**
 * Memory Runtime Service
 * Owns MemoryService lifecycle concerns: initialization, background workers,
 * lightweight/read-only modes, and orderly shutdown.
 */

import type { EventStore } from '../event-store.js';
import type { Embedder } from '../embedder.js';
import type { GraduationPipeline } from '../graduation.js';
import {
  createGraduationWorker as defaultCreateGraduationWorker,
  type GraduationRunResult,
  type GraduationWorker
} from '../graduation-worker.js';
import type { Retriever } from '../retriever.js';
import type { VectorStore } from '../vector-store.js';
import {
  createVectorWorker as defaultCreateVectorWorker,
  createVectorWorkerV2 as defaultCreateVectorWorkerV2,
  type VectorWorker,
  type VectorWorkerV2
} from '../vector-worker.js';
import type { Database } from '../db-wrapper.js';

export interface RuntimeSQLiteStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
  getDatabase?(): Database;
}

export interface RuntimeEndlessMemoryServices {
  initializeFromSavedMode(): Promise<void>;
  shutdown(): void;
}

export interface RuntimeSharedMemoryServices {
  initialize(): Promise<void>;
  close(): Promise<void>;
}

export interface MemoryRuntimeServicesFactories {
  createVectorWorker?: typeof defaultCreateVectorWorker;
  createVectorWorkerV2?: typeof defaultCreateVectorWorkerV2;
  createGraduationWorker?: typeof defaultCreateGraduationWorker;
}

export interface MemoryRuntimeServicesDeps {
  sqliteStore: RuntimeSQLiteStore;
  eventStore: EventStore;
  vectorStore: VectorStore;
  embedder: Embedder;
  retriever: Retriever;
  graduation: GraduationPipeline;
  endlessMemoryServices: RuntimeEndlessMemoryServices;
  sharedMemoryServices: RuntimeSharedMemoryServices;
  readOnly: boolean;
  lightweightMode: boolean;
  embeddingOnly: boolean;
  factories?: MemoryRuntimeServicesFactories;
}

export interface MemoryRuntimeService {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  processPendingEmbeddings(): Promise<number>;
  forceGraduation(): Promise<GraduationRunResult>;
  recordMemoryAccess(eventId: string, sessionId: string, confidence?: number): void;
  getVectorWorker(): VectorWorker | null;
  getVectorWorkerV2(): VectorWorkerV2 | null;
  isInitialized(): boolean;
}

function createEmptyGraduationResult(): GraduationRunResult {
  return { evaluated: 0, graduated: 0, byLevel: {} };
}

export function createMemoryRuntimeService(deps: MemoryRuntimeServicesDeps): MemoryRuntimeService {
  const createVectorWorker = deps.factories?.createVectorWorker ?? defaultCreateVectorWorker;
  const createVectorWorkerV2 = deps.factories?.createVectorWorkerV2 ?? defaultCreateVectorWorkerV2;
  const createGraduationWorker = deps.factories?.createGraduationWorker ?? defaultCreateGraduationWorker;

  let initialized = false;
  let vectorWorker: VectorWorker | null = null;
  let vectorWorkerV2: VectorWorkerV2 | null = null;
  let graduationWorker: GraduationWorker | null = null;

  return {
    async initialize(): Promise<void> {
      if (initialized) return;

      // Initialize PRIMARY store: SQLite (always)
      await deps.sqliteStore.initialize();

      // Lightweight mode: only SQLite, no embedder/vector/workers.
      // Used for hooks that just need to store data quickly.
      if (deps.lightweightMode) {
        initialized = true;
        return;
      }

      await deps.vectorStore.initialize();
      await deps.embedder.initialize();

      // Skip write-related workers in read-only mode.
      if (!deps.readOnly) {
        vectorWorker = createVectorWorker(
          deps.eventStore,
          deps.vectorStore,
          deps.embedder
        );
        vectorWorker.start();

        const sqliteDb = deps.sqliteStore.getDatabase?.();
        if (sqliteDb) {
          vectorWorkerV2 = createVectorWorkerV2(
            sqliteDb,
            deps.vectorStore,
            deps.embedder
          );
          vectorWorkerV2.start();
        }

        if (!deps.embeddingOnly) {
          deps.retriever.setGraduationPipeline(deps.graduation);
          graduationWorker = createGraduationWorker(
            deps.eventStore,
            deps.graduation
          );
          graduationWorker.start();
        }

        await deps.endlessMemoryServices.initializeFromSavedMode();
        await deps.sharedMemoryServices.initialize();
      }

      initialized = true;
    },

    async shutdown(): Promise<void> {
      if (graduationWorker) {
        graduationWorker.stop();
      }

      deps.endlessMemoryServices.shutdown();

      if (vectorWorker) {
        vectorWorker.stop();
      }
      if (vectorWorkerV2) {
        vectorWorkerV2.stop();
      }

      await deps.sharedMemoryServices.close();
      await deps.sqliteStore.close();
    },

    async processPendingEmbeddings(): Promise<number> {
      let processed = 0;
      if (vectorWorker) {
        processed += await vectorWorker.processAll();
      }
      if (vectorWorkerV2) {
        processed += await vectorWorkerV2.processAll();
      }
      return processed;
    },

    async forceGraduation(): Promise<GraduationRunResult> {
      if (!graduationWorker) {
        return createEmptyGraduationResult();
      }
      return graduationWorker.forceRun();
    },

    recordMemoryAccess(eventId: string, sessionId: string, confidence: number = 1.0): void {
      deps.graduation.recordAccess(eventId, sessionId, confidence);
    },

    getVectorWorker(): VectorWorker | null {
      return vectorWorker;
    },

    getVectorWorkerV2(): VectorWorkerV2 | null {
      return vectorWorkerV2;
    },

    isInitialized(): boolean {
      return initialized;
    }
  };
}
