import * as os from 'os';
import * as path from 'path';

import type { MemoryOperationsConfig, SharedStoreConfig } from '../core/types.js';

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

export const DISABLED_MEMORY_OPERATIONS_CONFIG: MemoryOperationsConfig = {
  enabled: false,
  facets: { enabled: true },
  actions: { enabled: true },
  retention: { enabled: false, policyVersion: 'v1' },
  graphExpansion: { enabled: false, maxHops: 1 },
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
