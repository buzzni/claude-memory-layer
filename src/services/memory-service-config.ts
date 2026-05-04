import * as os from 'os';
import * as path from 'path';

import type { SharedStoreConfig } from '../core/types.js';

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
