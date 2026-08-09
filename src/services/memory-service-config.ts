import * as os from 'os';
import * as path from 'path';

import type { MemoryOperationsConfig, SharedStoreConfig } from '../core/types.js';
import type { LlmSummaryGenerator } from '../core/engine/memory-ingest-service.js';

export interface MemoryServiceConfig {
  storagePath: string;
  embeddingModel?: string;
  readOnly?: boolean;
  /** Enable DuckDB analytics store (default: true for server, false for hooks) */
  analyticsEnabled?: boolean;
  /** Lightweight mode for hooks - skip heavy initialization (default: false) */
  lightweightMode?: boolean;
  /** Start only VectorWorker, skip GraduationWorker and SyncWorker (default: false) */
  embeddingOnly?: boolean;
  /** AgentMemory-inspired operations feature config (default: disabled). */
  operations?: MemoryOperationsConfig;
  /**
   * Outcome-focused session summary generator. Injected by the adapter layer
   * (it shells out to a local CLI) so core and services stay platform-agnostic.
   */
  llmSummaryGenerator?: LlmSummaryGenerator;
}

const SHARED_STORAGE_PATH = path.join(os.homedir(), '.claude-code', 'memory', 'shared');

export const DISABLED_SHARED_STORE_CONFIG: SharedStoreConfig = {
  enabled: false,
  autoPromote: false,
  searchShared: false,
  minConfidenceForPromotion: 0.8,
  sharedStoragePath: SHARED_STORAGE_PATH
};

export const DEFAULT_ENABLED_SHARED_STORE_CONFIG: SharedStoreConfig = {
  enabled: true,
  autoPromote: true,
  searchShared: true,
  minConfidenceForPromotion: 0.8,
  sharedStoragePath: SHARED_STORAGE_PATH
};

export const DEFAULT_SHARED_STORAGE_PATH = SHARED_STORAGE_PATH;
export const SHARED_MEMORY_STORAGE_PATH_ENV = 'CLAUDE_MEMORY_SHARED_STORAGE_PATH';

/**
 * MCP shared-actor tools open the global shared store outside a project
 * MemoryService instance. Keep that path configurable without allowing a
 * relative path to silently create a second store under the server cwd.
 */
export function resolveSharedMemoryStoragePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[SHARED_MEMORY_STORAGE_PATH_ENV]?.trim();
  if (!configured) return DEFAULT_SHARED_STORAGE_PATH;
  if (!path.isAbsolute(configured)) {
    throw new Error(`${SHARED_MEMORY_STORAGE_PATH_ENV} must be an absolute path`);
  }
  return configured;
}

export const DISABLED_MEMORY_OPERATIONS_CONFIG: MemoryOperationsConfig = {
  enabled: false,
  facets: { enabled: true },
  actions: { enabled: true },
  retention: { enabled: false, policyVersion: 'v1' },
  graphExpansion: { enabled: false, maxHops: 1 },
  codifyLite: { enabled: false },
  lessons: { enabled: false },
  perspectiveMemory: {
    enabled: false,
    deriver: { enabled: false, maxEventsPerBatch: 20, maxObserversPerSession: 5 },
    specialists: {
      enabled: false,
      enabledProjectHashes: [],
      enabledKinds: ['deduction', 'induction', 'contradiction', 'actor_card_maintenance'],
      maxSourceObservations: 20,
      maxDerivedObservations: 5,
      maxCardUpdates: 3
    }
  }
};

export const DEFAULT_ENABLED_MEMORY_OPERATIONS_CONFIG: MemoryOperationsConfig = {
  ...DISABLED_MEMORY_OPERATIONS_CONFIG,
  enabled: true
};
