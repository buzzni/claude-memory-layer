import * as fs from 'fs';
import * as path from 'path';

export interface EmbeddingMaintenanceEvent {
  id: string;
  content: string;
}

export interface EmbeddingMaintenanceEventStore {
  clearEmbeddingOutbox(): Promise<void>;
  getEventsPage(limit: number, offset: number): Promise<EmbeddingMaintenanceEvent[]>;
  enqueueForEmbedding(eventId: string, content: string): Promise<void>;
}

export interface EmbeddingMaintenanceVectorStore {
  count(): Promise<number>;
  clearAll(): Promise<void>;
}

export interface EmbeddingMaintenanceVectorWorker {
  isRunning(): boolean;
  stop(): void;
  start(): void;
}

export interface EmbeddingMaintenanceFileSystem {
  existsSync(targetPath: string): boolean;
  readFileSync(targetPath: string, encoding: BufferEncoding): string;
  writeFileSync(targetPath: string, content: string): void;
}

export interface EmbeddingModelMaintenanceOptions {
  autoMigrate?: boolean;
}

export interface EmbeddingModelMaintenanceResult {
  changed: boolean;
  previousModel: string | null;
  currentModel: string;
  enqueued: number;
  reason?: string;
}

export interface EmbeddingMaintenanceServiceOptions {
  storagePath: string;
  initialize: () => Promise<void>;
  getEmbeddingModelName: () => string;
  vectorStore: EmbeddingMaintenanceVectorStore;
  eventStore: EmbeddingMaintenanceEventStore;
  getVectorWorker: () => EmbeddingMaintenanceVectorWorker | null;
  fileSystem?: EmbeddingMaintenanceFileSystem;
}

export interface EmbeddingMaintenanceService {
  getEmbeddingModelName(): string;
  ensureEmbeddingModelForImport(options?: EmbeddingModelMaintenanceOptions): Promise<EmbeddingModelMaintenanceResult>;
}

const DEFAULT_PAGE_SIZE = 1000;

const defaultFileSystem: EmbeddingMaintenanceFileSystem = {
  existsSync: fs.existsSync,
  readFileSync: (targetPath, encoding) => fs.readFileSync(targetPath, encoding),
  writeFileSync: (targetPath, content) => fs.writeFileSync(targetPath, content)
};

class DefaultEmbeddingMaintenanceService implements EmbeddingMaintenanceService {
  private readonly fileSystem: EmbeddingMaintenanceFileSystem;

  constructor(private readonly options: EmbeddingMaintenanceServiceOptions) {
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
  }

  getEmbeddingModelName(): string {
    return this.options.getEmbeddingModelName();
  }

  async ensureEmbeddingModelForImport(
    options?: EmbeddingModelMaintenanceOptions
  ): Promise<EmbeddingModelMaintenanceResult> {
    await this.options.initialize();

    const currentModel = this.getEmbeddingModelName();
    const metaPath = path.join(this.options.storagePath, 'embedding-meta.json');
    const previousModel = this.readPreviousModel(metaPath);
    const vectorCount = await this.options.vectorStore.count();
    const hasExistingVectors = vectorCount > 0;

    // First-time metadata write (no migration needed unless legacy vectors exist)
    if (!previousModel && !hasExistingVectors) {
      this.fileSystem.writeFileSync(
        metaPath,
        JSON.stringify({ model: currentModel, updatedAt: new Date().toISOString() }, null, 2)
      );
      return { changed: false, previousModel: null, currentModel, enqueued: 0, reason: 'initialized-meta' };
    }

    const modelChanged = previousModel !== currentModel;
    const legacyUnknownButVectorsExist = !previousModel && hasExistingVectors;

    if (!modelChanged && !legacyUnknownButVectorsExist) {
      return { changed: false, previousModel, currentModel, enqueued: 0 };
    }

    if (options?.autoMigrate === false) {
      return {
        changed: true,
        previousModel,
        currentModel,
        enqueued: 0,
        reason: legacyUnknownButVectorsExist ? 'legacy-vectors-without-meta' : 'model-mismatch'
      };
    }

    const worker = this.options.getVectorWorker();
    const wasRunning = worker?.isRunning() || false;
    if (wasRunning) worker?.stop();

    await this.options.vectorStore.clearAll();
    await this.options.eventStore.clearEmbeddingOutbox();

    const enqueued = await this.reenqueueAllEvents();

    this.fileSystem.writeFileSync(
      metaPath,
      JSON.stringify(
        {
          model: currentModel,
          previousModel,
          migratedAt: new Date().toISOString(),
          enqueued
        },
        null,
        2
      )
    );

    if (wasRunning) worker?.start();

    return {
      changed: true,
      previousModel,
      currentModel,
      enqueued,
      reason: legacyUnknownButVectorsExist ? 'legacy-vectors-without-meta' : 'model-mismatch'
    };
  }

  private readPreviousModel(metaPath: string): string | null {
    try {
      if (this.fileSystem.existsSync(metaPath)) {
        const parsed = JSON.parse(this.fileSystem.readFileSync(metaPath, 'utf-8')) as { model?: string };
        return parsed?.model || null;
      }
    } catch {
      return null;
    }

    return null;
  }

  private async reenqueueAllEvents(): Promise<number> {
    let offset = 0;
    let enqueued = 0;

    while (true) {
      const page = await this.options.eventStore.getEventsPage(DEFAULT_PAGE_SIZE, offset);
      if (page.length === 0) break;

      for (const event of page) {
        await this.options.eventStore.enqueueForEmbedding(event.id, event.content);
        enqueued += 1;
      }

      offset += page.length;
      if (page.length < DEFAULT_PAGE_SIZE) break;
    }

    return enqueued;
  }
}

export function createEmbeddingMaintenanceService(
  options: EmbeddingMaintenanceServiceOptions
): EmbeddingMaintenanceService {
  return new DefaultEmbeddingMaintenanceService(options);
}
