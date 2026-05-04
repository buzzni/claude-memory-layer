import * as fs from 'fs';
import * as path from 'path';
import type { Embedder } from '../../core/embedder.js';
import { createSharedEventStore, type SharedEventStore } from '../../core/shared-event-store.js';
import { createSharedPromoter, type PromotionResult, type SharedPromoter } from '../../core/shared-promoter.js';
import { createSharedStore, type SharedStore } from '../../core/shared-store.js';
import { createSharedVectorStore, type SharedVectorStore } from '../../core/shared-vector-store.js';
import type { Entry, SharedStoreConfig, SharedTroubleshootingEntry } from '../../core/types.js';

export interface SharedMemoryRetriever {
  setSharedStores(sharedStore: SharedStore, sharedVectorStore: SharedVectorStore): void;
}

export interface SharedMemoryServicesFactories {
  existsSync?: (targetPath: string) => boolean;
  mkdirSync?: (targetPath: string) => void;
  createSharedEventStore?: (dbPath: string) => SharedEventStore;
  createSharedStore?: (sharedEventStore: SharedEventStore) => SharedStore;
  createSharedVectorStore?: (dbPath: string) => SharedVectorStore;
  createSharedPromoter?: (
    sharedStore: SharedStore,
    sharedVectorStore: SharedVectorStore,
    embedder: Embedder,
    config?: SharedStoreConfig
  ) => SharedPromoter;
}

export interface SharedMemoryServicesOptions {
  config: SharedStoreConfig | null;
  defaultSharedStoragePath: string;
  readOnly: boolean;
  expandPath: (targetPath: string) => string;
  embedder: Embedder;
  retriever: SharedMemoryRetriever;
  factories?: SharedMemoryServicesFactories;
}

export type SharedStoreStats = {
  total: number;
  averageConfidence: number;
  topTopics: Array<{ topic: string; count: number }>;
  totalUsageCount: number;
};

export class SharedMemoryServices {
  private sharedEventStore: SharedEventStore | null = null;
  private sharedStore: SharedStore | null = null;
  private sharedVectorStore: SharedVectorStore | null = null;
  private sharedPromoter: SharedPromoter | null = null;
  private openStorePromise: Promise<SharedStore> | null = null;

  constructor(private readonly options: SharedMemoryServicesOptions) {}

  get eventStore(): SharedEventStore | null {
    return this.sharedEventStore;
  }

  get store(): SharedStore | null {
    return this.sharedStore;
  }

  get vectorStore(): SharedVectorStore | null {
    return this.sharedVectorStore;
  }

  get promoter(): SharedPromoter | null {
    return this.sharedPromoter;
  }

  isEnabled(): boolean {
    return this.sharedStore !== null;
  }

  getSharedStoragePath(): string {
    return this.options.config?.sharedStoragePath
      ? this.options.expandPath(this.options.config.sharedStoragePath)
      : this.options.defaultSharedStoragePath;
  }

  async initialize(): Promise<void> {
    if (this.options.config?.enabled === false || this.options.readOnly) return;

    const sharedPath = this.getSharedStoragePath();
    this.ensureDirectory(sharedPath, { allowCreate: true });

    const store = await this.openStore(sharedPath);

    this.sharedVectorStore = this.factories.createSharedVectorStore(
      path.join(sharedPath, 'vectors')
    );
    await this.sharedVectorStore.initialize();

    this.sharedPromoter = this.factories.createSharedPromoter(
      store,
      this.sharedVectorStore,
      this.options.embedder,
      this.options.config || undefined
    );

    this.options.retriever.setSharedStores(store, this.sharedVectorStore);
  }

  async ensureStoreForRead(): Promise<SharedStore | null> {
    if (this.options.config?.enabled === false) return null;
    if (this.sharedStore) return this.sharedStore;

    const sharedPath = this.getSharedStoragePath();
    const directoryReady = this.ensureDirectory(sharedPath, { allowCreate: !this.options.readOnly });
    if (!directoryReady) return null;

    return this.openStore(sharedPath);
  }

  async getEntryForDisclosure(entryId: string): Promise<SharedTroubleshootingEntry | null> {
    const store = await this.ensureStoreForRead();
    return store?.get(entryId) ?? null;
  }

  async promoteToShared(entry: Entry, projectHash: string | null): Promise<PromotionResult> {
    if (!this.sharedPromoter || !projectHash) {
      return {
        success: false,
        error: 'Shared store not initialized or project hash not set'
      };
    }

    return this.sharedPromoter.promoteEntry(entry, projectHash);
  }

  async getStats(): Promise<SharedStoreStats | null> {
    if (!this.sharedStore) return null;
    return this.sharedStore.getStats();
  }

  async search(
    query: string,
    options?: { topK?: number; minConfidence?: number }
  ): Promise<SharedTroubleshootingEntry[]> {
    if (!this.sharedStore) return [];
    return this.sharedStore.search(query, options);
  }

  async close(): Promise<void> {
    if (this.openStorePromise) {
      await this.openStorePromise.catch(() => null);
    }

    if (this.sharedEventStore) {
      await this.sharedEventStore.close();
    }
    this.sharedEventStore = null;
    this.sharedStore = null;
    this.sharedVectorStore = null;
    this.sharedPromoter = null;
    this.openStorePromise = null;
  }

  private async openStore(sharedPath: string): Promise<SharedStore> {
    if (this.sharedStore) return this.sharedStore;

    if (!this.openStorePromise) {
      this.openStorePromise = this.createOpenStorePromise(sharedPath);
    }

    try {
      return await this.openStorePromise;
    } finally {
      this.openStorePromise = null;
    }
  }

  private async createOpenStorePromise(sharedPath: string): Promise<SharedStore> {
    if (!this.sharedEventStore) {
      const sharedEventStore = this.factories.createSharedEventStore(
        path.join(sharedPath, 'shared.duckdb')
      );
      await sharedEventStore.initialize();
      this.sharedEventStore = sharedEventStore;
    }

    if (!this.sharedStore) {
      this.sharedStore = this.factories.createSharedStore(this.sharedEventStore);
    }

    return this.sharedStore;
  }

  private ensureDirectory(sharedPath: string, options: { allowCreate: boolean }): boolean {
    if (this.factories.existsSync(sharedPath)) return true;
    if (!options.allowCreate) return false;
    this.factories.mkdirSync(sharedPath);
    return true;
  }

  private get factories(): Required<SharedMemoryServicesFactories> {
    return {
      existsSync: this.options.factories?.existsSync ?? fs.existsSync,
      mkdirSync: this.options.factories?.mkdirSync ?? ((targetPath: string) => {
        fs.mkdirSync(targetPath, { recursive: true });
      }),
      createSharedEventStore: this.options.factories?.createSharedEventStore ?? createSharedEventStore,
      createSharedStore: this.options.factories?.createSharedStore ?? createSharedStore,
      createSharedVectorStore: this.options.factories?.createSharedVectorStore ?? createSharedVectorStore,
      createSharedPromoter: this.options.factories?.createSharedPromoter ?? createSharedPromoter
    };
  }
}

export function createSharedMemoryServices(options: SharedMemoryServicesOptions): SharedMemoryServices {
  return new SharedMemoryServices(options);
}
