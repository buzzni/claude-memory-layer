import * as path from 'node:path';

import {
  getProjectStoragePath as defaultGetProjectStoragePath,
  hashProjectPath as defaultHashProjectPath
} from '../../core/registry/project-path.js';
import { WorkerLock, type WorkerLockAcquireResult } from '../../core/worker-lock.js';
import { createMemoryService as defaultCreateMemoryService } from '../../services/memory-service.js';
import { DISABLED_SHARED_STORE_CONFIG } from '../../services/memory-service-config.js';
import type { MemoryServiceRegistryConfig } from '../../services/memory-service-registry.js';

export interface RawMongoSyncProcessOptions {
  project?: string;
  processAfterSync?: boolean;
  processInterval?: string;
  processLockPath?: string;
}

export interface MongoSyncProcessOptions {
  projectPath: string;
  processAfterSync: boolean;
  processIntervalMs: number;
  lockPath: string;
}

export interface MongoSyncProcessOptionsDeps {
  getProjectStoragePath?: (projectPath: string) => string;
}

export interface MongoSyncResultSummary {
  pushed: number;
  pulled: number;
}

export interface MongoSyncProcessOnceInput {
  projectPath: string;
  lockPath: string;
}

export interface MongoSyncProcessOnceResult {
  skipped: boolean;
  processed: number;
  holderPid?: number | null;
}

export interface MongoSyncPostProcessor {
  afterSync(result: MongoSyncResultSummary): Promise<void>;
}

export interface MongoSyncPostProcessorDeps {
  now?: () => number;
  processOnce?: (input: MongoSyncProcessOnceInput) => Promise<MongoSyncProcessOnceResult>;
  log?: (message: string) => void;
}

export interface MongoSyncProcessService {
  initialize(): Promise<void>;
  recoverStuckOutboxItems(): Promise<unknown>;
  processPendingEmbeddings(): Promise<number>;
  shutdown(): Promise<void>;
}

export interface MongoSyncProcessWorkerLock {
  acquire(): WorkerLockAcquireResult;
  release(): boolean;
}

export interface ProcessProjectEmbeddingsDeps {
  createMemoryService?: (config: MemoryServiceRegistryConfig) => MongoSyncProcessService;
  getProjectStoragePath?: (projectPath: string) => string;
  hashProjectPath?: (projectPath: string) => string;
  createWorkerLock?: (lockPath: string) => MongoSyncProcessWorkerLock;
}

const DEFAULT_PROCESS_INTERVAL_MS = 120_000;

export function resolveMongoSyncProcessOptions(
  options: RawMongoSyncProcessOptions,
  cwd: string = process.cwd(),
  deps: MongoSyncProcessOptionsDeps = {}
): MongoSyncProcessOptions {
  const explicitProject = options.project;
  if (explicitProject !== undefined && explicitProject.trim().length === 0) {
    throw new Error('--project must not be empty');
  }

  const explicitLockPath = options.processLockPath;
  if (explicitLockPath !== undefined && explicitLockPath.trim().length === 0) {
    throw new Error('--process-lock-path must not be empty');
  }

  const projectPath = explicitProject ?? cwd;
  const processIntervalMs = parsePositiveIntegerOption(
    options.processInterval ?? String(DEFAULT_PROCESS_INTERVAL_MS),
    '--process-interval'
  );
  const getProjectStoragePath = deps.getProjectStoragePath ?? defaultGetProjectStoragePath;

  return {
    projectPath,
    processAfterSync: options.processAfterSync === true,
    processIntervalMs,
    lockPath: explicitLockPath ?? path.join(getProjectStoragePath(projectPath), 'vector-worker.lock')
  };
}

export function createMongoSyncPostProcessor(
  options: MongoSyncProcessOptions,
  deps: MongoSyncPostProcessorDeps = {}
): MongoSyncPostProcessor {
  const now = deps.now ?? (() => Date.now());
  const processOnce = deps.processOnce ?? processProjectEmbeddingsOnce;
  const log = deps.log ?? (() => undefined);
  let lastProcessAtMs: number | null = null;

  return {
    async afterSync(result: MongoSyncResultSummary): Promise<void> {
      if (!options.processAfterSync) return;
      if (result.pulled <= 0) return;

      const currentTimeMs = now();
      if (lastProcessAtMs !== null && currentTimeMs - lastProcessAtMs < options.processIntervalMs) {
        return;
      }

      lastProcessAtMs = currentTimeMs;
      log(`[mongo-sync] Processing pending embeddings after pulling ${result.pulled} events...`);
      let outcome: MongoSyncProcessOnceResult;
      try {
        outcome = await processOnce({
          projectPath: options.projectPath,
          lockPath: options.lockPath
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`[mongo-sync] Process-after-sync failed: ${message}`);
        return;
      }

      if (outcome.skipped) {
        const holder = outcome.holderPid === undefined || outcome.holderPid === null ? 'unknown' : String(outcome.holderPid);
        log(`[mongo-sync] Skipped embedding processing because another vector worker is running (holderPid=${holder})`);
        return;
      }

      log(`[mongo-sync] Processed ${outcome.processed} embeddings after sync`);
    }
  };
}

export async function processProjectEmbeddingsOnce(
  input: MongoSyncProcessOnceInput,
  deps: ProcessProjectEmbeddingsDeps = {}
): Promise<MongoSyncProcessOnceResult> {
  const createWorkerLock = deps.createWorkerLock ?? ((lockPath: string) => new WorkerLock(lockPath));
  const createService = deps.createMemoryService ?? defaultCreateMemoryService;
  const getProjectStoragePath = deps.getProjectStoragePath ?? defaultGetProjectStoragePath;
  const hashProjectPath = deps.hashProjectPath ?? defaultHashProjectPath;
  const workerLock = createWorkerLock(input.lockPath);
  const lockResult = workerLock.acquire();

  if (!lockResult.acquired) {
    return {
      skipped: true,
      processed: 0,
      holderPid: 'holderPid' in lockResult ? lockResult.holderPid : null
    };
  }

  let service: MongoSyncProcessService | undefined;
  try {
    service = createService({
      storagePath: getProjectStoragePath(input.projectPath),
      projectHash: hashProjectPath(input.projectPath),
      projectPath: input.projectPath,
      sharedStoreConfig: DISABLED_SHARED_STORE_CONFIG,
      analyticsEnabled: false
    });
    await service.initialize();
    await service.recoverStuckOutboxItems();
    const processed = await service.processPendingEmbeddings();
    return { skipped: false, processed };
  } finally {
    workerLock.release();
    await service?.shutdown().catch(() => undefined);
  }
}

function parsePositiveIntegerOption(raw: string, flagName: string): number {
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    throw new Error(`${flagName} must be a positive integer number of milliseconds`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer number of milliseconds`);
  }
  return parsed;
}
