import { randomUUID } from 'crypto';

import type { EventStore } from '../../core/event-store.js';
import {
  createWorkingSetStore,
  type WorkingSetStore
} from '../../core/working-set-store.js';
import {
  createConsolidatedStore,
  type ConsolidatedStore
} from '../../core/consolidated-store.js';
import {
  createConsolidationWorker,
  type ConsolidationWorker
} from '../../core/consolidation-worker.js';
import {
  createContinuityManager,
  type ContinuityManager
} from '../../core/continuity-manager.js';
import type {
  ConsolidatedMemory,
  ContinuityScore,
  EndlessModeConfig,
  EndlessModeStatus,
  MemoryMode,
  WorkingSet
} from '../../core/types.js';

export interface EndlessConfigStore {
  getEndlessConfig(key: string): Promise<unknown>;
  setEndlessConfig(key: string, value: unknown): Promise<void>;
}

export interface WorkingSetStorePort {
  add(eventId: string, relevanceScore?: number): Promise<void>;
  get(): Promise<WorkingSet>;
  count(): Promise<number>;
}

export interface ConsolidatedStorePort {
  search(query: string, options?: { topK?: number }): Promise<ConsolidatedMemory[]>;
  getAll(options?: { limit?: number }): Promise<ConsolidatedMemory[]>;
  markAccessed(memoryId: string): Promise<void>;
  count(): Promise<number>;
  getLastConsolidationTime(): Promise<Date | null>;
}

export interface ConsolidationWorkerPort {
  start(): void;
  stop(): void;
  recordActivity(): void;
  forceRun(): Promise<number>;
}

export interface ContinuityManagerPort {
  createSnapshot(
    id: string,
    content: string,
    metadata?: { files?: string[]; entities?: string[] }
  ): unknown;
  calculateScore(snapshot: unknown): Promise<ContinuityScore>;
}

export interface EndlessMemoryServicesFactories {
  createWorkingSetStore: (eventStore: EventStore, config: EndlessModeConfig) => WorkingSetStorePort;
  createConsolidatedStore: (eventStore: EventStore) => ConsolidatedStorePort;
  createConsolidationWorker: (
    workingSetStore: WorkingSetStorePort,
    consolidatedStore: ConsolidatedStorePort,
    config: EndlessModeConfig
  ) => ConsolidationWorkerPort;
  createContinuityManager: (eventStore: EventStore, config: EndlessModeConfig) => ContinuityManagerPort;
  randomUUID?: () => string;
}

export interface EndlessMemoryServicesOptions {
  eventStore: EventStore;
  configStore: EndlessConfigStore;
  initialize: () => Promise<void>;
  factories?: EndlessMemoryServicesFactories;
}

export interface EndlessMemoryServices {
  initializeFromSavedMode(): Promise<void>;
  initializeEndlessMode(): Promise<void>;
  getEndlessConfig(): Promise<EndlessModeConfig>;
  setEndlessConfig(config: Partial<EndlessModeConfig>): Promise<void>;
  setMode(mode: MemoryMode): Promise<void>;
  getMode(): MemoryMode;
  isEndlessModeActive(): boolean;
  addToWorkingSet(eventId: string, relevanceScore?: number): Promise<void>;
  getWorkingSet(): Promise<WorkingSet | null>;
  searchConsolidated(query: string, options?: { topK?: number }): Promise<ConsolidatedMemory[]>;
  getConsolidatedMemories(limit?: number): Promise<ConsolidatedMemory[]>;
  markMemoryAccessed(memoryId: string): Promise<void>;
  calculateContinuity(
    content: string,
    metadata?: { files?: string[]; entities?: string[] }
  ): Promise<ContinuityScore | null>;
  recordActivity(): void;
  forceConsolidation(): Promise<number>;
  getEndlessModeStatus(): Promise<EndlessModeStatus>;
  formatEndlessContext(query: string): Promise<string>;
  shutdown(): void;
}

function getDefaultEndlessConfig(): EndlessModeConfig {
  return {
    enabled: true,
    workingSet: {
      maxEvents: 100,
      timeWindowHours: 24,
      minRelevanceScore: 0.5
    },
    consolidation: {
      triggerIntervalMs: 3600000,
      triggerEventCount: 100,
      triggerIdleMs: 1800000,
      useLLMSummarization: false
    },
    continuity: {
      minScoreForSeamless: 0.7,
      topicDecayHours: 48
    }
  };
}

const defaultFactories: Required<EndlessMemoryServicesFactories> = {
  createWorkingSetStore: (eventStore, config) => createWorkingSetStore(eventStore, config) as WorkingSetStore,
  createConsolidatedStore: (eventStore) => createConsolidatedStore(eventStore) as ConsolidatedStore,
  createConsolidationWorker: (workingSetStore, consolidatedStore, config) => createConsolidationWorker(
    workingSetStore as WorkingSetStore,
    consolidatedStore as ConsolidatedStore,
    config
  ) as ConsolidationWorker,
  createContinuityManager: (eventStore, config) => createContinuityManager(eventStore, config) as ContinuityManager,
  randomUUID
};

class DefaultEndlessMemoryServices implements EndlessMemoryServices {
  private readonly factories: Required<EndlessMemoryServicesFactories>;
  private workingSetStore: WorkingSetStorePort | null = null;
  private consolidatedStore: ConsolidatedStorePort | null = null;
  private consolidationWorker: ConsolidationWorkerPort | null = null;
  private continuityManager: ContinuityManagerPort | null = null;
  private mode: MemoryMode = 'session';

  constructor(private readonly options: EndlessMemoryServicesOptions) {
    this.factories = options.factories
      ? { ...options.factories, randomUUID: options.factories.randomUUID ?? randomUUID }
      : defaultFactories;
  }

  async initializeFromSavedMode(): Promise<void> {
    const savedMode = await this.options.configStore.getEndlessConfig('mode') as MemoryMode | null;
    if (savedMode === 'endless') {
      this.mode = 'endless';
      await this.initializeEndlessMode();
    }
  }

  async initializeEndlessMode(): Promise<void> {
    if (this.consolidationWorker) return;

    const config = await this.getEndlessConfig();
    const workingSetStore = this.factories.createWorkingSetStore(this.options.eventStore, config);
    const consolidatedStore = this.factories.createConsolidatedStore(this.options.eventStore);
    const consolidationWorker = this.factories.createConsolidationWorker(
      workingSetStore,
      consolidatedStore,
      config
    );
    const continuityManager = this.factories.createContinuityManager(this.options.eventStore, config);

    try {
      consolidationWorker.start();
    } catch (error) {
      consolidationWorker.stop();
      throw error;
    }

    this.workingSetStore = workingSetStore;
    this.consolidatedStore = consolidatedStore;
    this.consolidationWorker = consolidationWorker;
    this.continuityManager = continuityManager;
  }

  async getEndlessConfig(): Promise<EndlessModeConfig> {
    const savedConfig = await this.options.configStore.getEndlessConfig('config') as EndlessModeConfig | null;
    return savedConfig || getDefaultEndlessConfig();
  }

  async setEndlessConfig(config: Partial<EndlessModeConfig>): Promise<void> {
    const current = await this.getEndlessConfig();
    const merged = { ...current, ...config };
    await this.options.configStore.setEndlessConfig('config', merged);
  }

  async setMode(mode: MemoryMode): Promise<void> {
    await this.options.initialize();
    if (mode === this.mode) return;

    this.mode = mode;
    await this.options.configStore.setEndlessConfig('mode', mode);

    if (mode === 'endless') {
      await this.initializeEndlessMode();
    } else {
      this.stopEndlessMode();
    }
  }

  getMode(): MemoryMode {
    return this.mode;
  }

  isEndlessModeActive(): boolean {
    return this.mode === 'endless';
  }

  async addToWorkingSet(eventId: string, relevanceScore?: number): Promise<void> {
    if (!this.workingSetStore) return;
    await this.workingSetStore.add(eventId, relevanceScore);
  }

  async getWorkingSet(): Promise<WorkingSet | null> {
    if (!this.workingSetStore) return null;
    return this.workingSetStore.get();
  }

  async searchConsolidated(query: string, options?: { topK?: number }): Promise<ConsolidatedMemory[]> {
    if (!this.consolidatedStore) return [];
    return this.consolidatedStore.search(query, options);
  }

  async getConsolidatedMemories(limit?: number): Promise<ConsolidatedMemory[]> {
    if (!this.consolidatedStore) return [];
    return this.consolidatedStore.getAll({ limit });
  }

  async markMemoryAccessed(memoryId: string): Promise<void> {
    if (!this.consolidatedStore) return;
    await this.consolidatedStore.markAccessed(memoryId);
  }

  async calculateContinuity(
    content: string,
    metadata?: { files?: string[]; entities?: string[] }
  ): Promise<ContinuityScore | null> {
    if (!this.continuityManager) return null;
    const snapshot = this.continuityManager.createSnapshot(
      this.factories.randomUUID(),
      content,
      metadata
    );
    return this.continuityManager.calculateScore(snapshot);
  }

  recordActivity(): void {
    this.consolidationWorker?.recordActivity();
  }

  async forceConsolidation(): Promise<number> {
    if (!this.consolidationWorker) return 0;
    return this.consolidationWorker.forceRun();
  }

  async getEndlessModeStatus(): Promise<EndlessModeStatus> {
    await this.options.initialize();

    let workingSetSize = 0;
    let continuityScore = 0.5;
    let consolidatedCount = 0;
    let lastConsolidation: Date | null = null;

    if (this.workingSetStore) {
      workingSetSize = await this.workingSetStore.count();
      const workingSet = await this.workingSetStore.get();
      continuityScore = workingSet.continuityScore;
    }

    if (this.consolidatedStore) {
      consolidatedCount = await this.consolidatedStore.count();
      lastConsolidation = await this.consolidatedStore.getLastConsolidationTime();
    }

    return {
      mode: this.mode,
      workingSetSize,
      continuityScore,
      consolidatedCount,
      lastConsolidation
    };
  }

  async formatEndlessContext(query: string): Promise<string> {
    if (!this.isEndlessModeActive()) {
      return '';
    }

    const workingSet = await this.getWorkingSet();
    const consolidated = await this.searchConsolidated(query, { topK: 3 });
    const continuity = await this.calculateContinuity(query);

    const parts: string[] = [];

    if (continuity) {
      const statusEmoji = continuity.transitionType === 'seamless' ? '🔗' :
                          continuity.transitionType === 'topic_shift' ? '↪️' : '🆕';
      parts.push(`${statusEmoji} Context: ${continuity.transitionType} (score: ${continuity.score.toFixed(2)})`);
    }

    if (workingSet && workingSet.recentEvents.length > 0) {
      parts.push('\n## Recent Context (Working Set)');
      const recent = workingSet.recentEvents.slice(0, 5);
      for (const event of recent) {
        const preview = event.content.slice(0, 80) + (event.content.length > 80 ? '...' : '');
        const time = event.timestamp.toLocaleTimeString();
        parts.push(`- ${time} [${event.eventType}] ${preview}`);
      }
    }

    if (consolidated.length > 0) {
      parts.push('\n## Related Knowledge (Consolidated)');
      for (const memory of consolidated) {
        parts.push(`- ${memory.topics.slice(0, 3).join(', ')}: ${memory.summary.slice(0, 100)}...`);
      }
    }

    return parts.join('\n');
  }

  shutdown(): void {
    this.stopEndlessMode();
  }

  private stopEndlessMode(): void {
    if (this.consolidationWorker) {
      this.consolidationWorker.stop();
    }
    this.workingSetStore = null;
    this.consolidatedStore = null;
    this.consolidationWorker = null;
    this.continuityManager = null;
  }
}

export function createEndlessMemoryServices(options: EndlessMemoryServicesOptions): EndlessMemoryServices {
  return new DefaultEndlessMemoryServices(options);
}
