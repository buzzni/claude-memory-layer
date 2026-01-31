/**
 * Vector Worker - Single-Writer Pattern Implementation
 * AXIOMMIND Principle 6: DuckDB → outbox → LanceDB unidirectional flow
 */

import { EventStore } from './event-store.js';
import { VectorStore } from './vector-store.js';
import { Embedder } from './embedder.js';
import type { OutboxItem, VectorRecord } from './types.js';

export interface WorkerConfig {
  batchSize: number;
  pollIntervalMs: number;
  maxRetries: number;
}

const DEFAULT_CONFIG: WorkerConfig = {
  batchSize: 32,
  pollIntervalMs: 1000,
  maxRetries: 3
};

export class VectorWorker {
  private readonly eventStore: EventStore;
  private readonly vectorStore: VectorStore;
  private readonly embedder: Embedder;
  private readonly config: WorkerConfig;
  private running = false;
  private pollTimeout: NodeJS.Timeout | null = null;

  constructor(
    eventStore: EventStore,
    vectorStore: VectorStore,
    embedder: Embedder,
    config: Partial<WorkerConfig> = {}
  ) {
    this.eventStore = eventStore;
    this.vectorStore = vectorStore;
    this.embedder = embedder;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the worker polling loop
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.poll();
  }

  /**
   * Stop the worker
   */
  stop(): void {
    this.running = false;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
  }

  /**
   * Process a single batch of outbox items
   */
  async processBatch(): Promise<number> {
    const items = await this.eventStore.getPendingOutboxItems(this.config.batchSize);

    if (items.length === 0) {
      return 0;
    }

    const successful: string[] = [];
    const failed: string[] = [];

    try {
      // Generate embeddings for all items
      const embeddings = await this.embedder.embedBatch(items.map(i => i.content));

      // Prepare vector records
      const records: VectorRecord[] = [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const embedding = embeddings[i];

        // Get event details
        const event = await this.eventStore.getEvent(item.eventId);
        if (!event) {
          failed.push(item.id);
          continue;
        }

        records.push({
          id: `vec_${item.id}`,
          eventId: item.eventId,
          sessionId: event.sessionId,
          eventType: event.eventType,
          content: item.content,
          vector: embedding.vector,
          timestamp: event.timestamp.toISOString(),
          metadata: event.metadata
        });

        successful.push(item.id);
      }

      // Batch insert to vector store
      if (records.length > 0) {
        await this.vectorStore.upsertBatch(records);
      }

      // Mark successful items as done
      if (successful.length > 0) {
        await this.eventStore.completeOutboxItems(successful);
      }

      // Mark failed items
      if (failed.length > 0) {
        await this.eventStore.failOutboxItems(failed, 'Event not found');
      }

      return successful.length;
    } catch (error) {
      // Mark all items as failed
      const allIds = items.map(i => i.id);
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.eventStore.failOutboxItems(allIds, errorMessage);
      throw error;
    }
  }

  /**
   * Poll for new items
   */
  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      await this.processBatch();
    } catch (error) {
      console.error('Vector worker error:', error);
    }

    // Schedule next poll
    this.pollTimeout = setTimeout(() => this.poll(), this.config.pollIntervalMs);
  }

  /**
   * Process all pending items (blocking)
   */
  async processAll(): Promise<number> {
    let totalProcessed = 0;
    let processed: number;

    do {
      processed = await this.processBatch();
      totalProcessed += processed;
    } while (processed > 0);

    return totalProcessed;
  }

  /**
   * Check if worker is running
   */
  isRunning(): boolean {
    return this.running;
  }
}

/**
 * Create and start a vector worker
 */
export function createVectorWorker(
  eventStore: EventStore,
  vectorStore: VectorStore,
  embedder: Embedder,
  config?: Partial<WorkerConfig>
): VectorWorker {
  const worker = new VectorWorker(eventStore, vectorStore, embedder, config);
  return worker;
}
