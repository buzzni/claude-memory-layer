/**
 * Vector Worker - Single-Writer Pattern Implementation
 * AXIOMMIND Principle 6: DuckDB → outbox → LanceDB unidirectional flow
 */

import { EventStore } from './event-store.js';
import { VectorStore } from './vector-store.js';
import { Embedder } from './embedder.js';
import type { VectorRecord } from './types.js';

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

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isMissingPerspectiveObservationTable(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return message.includes('no such table: perspective_observations');
}

export class VectorWorker {
  private readonly eventStore: EventStore;
  private readonly vectorStore: VectorStore;
  private readonly embedder: Embedder;
  private readonly config: WorkerConfig;
  private running = false;
  private stopping = false;
  private pollTimeout: NodeJS.Timeout | null = null;
  private activeBatch: Promise<number> | null = null;

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
    this.stopping = false;
    this.poll();
  }

  /**
   * Stop the worker
   */
  stop(): void {
    this.running = false;
    this.stopping = true;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
  }

  /**
   * Process a single batch of outbox items
   */
  async processBatch(): Promise<number> {
    if (this.activeBatch) {
      return this.activeBatch;
    }

    const batch = this.processBatchExclusive();
    this.activeBatch = batch;
    try {
      return await batch;
    } finally {
      if (this.activeBatch === batch) {
        this.activeBatch = null;
      }
    }
  }

  private async processBatchExclusive(): Promise<number> {
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
      // Mark all items as failed, but only if not stopping (DB might be closed)
      if (!this.stopping) {
        try {
          const allIds = items.map(i => i.id);
          const errorMessage = error instanceof Error ? error.message : String(error);
          await this.eventStore.failOutboxItems(allIds, errorMessage);
        } catch (failError) {
          // Database might be closed during shutdown, ignore
          console.warn('Could not mark outbox items as failed (database may be closed)');
        }
      }
      throw error;
    }
  }

  /**
   * Poll for new items
   */
  private async poll(): Promise<void> {
    if (!this.running || this.stopping) return;

    try {
      await this.processBatch();
    } catch (error) {
      // Only log if not stopping (error during shutdown is expected)
      if (!this.stopping) {
        console.error('Vector worker error:', error);
      }
    }

    // Schedule next poll only if still running
    if (this.running && !this.stopping) {
      this.pollTimeout = setTimeout(() => this.poll(), this.config.pollIntervalMs);
    }
  }

  /**
   * Process all pending items (blocking)
   */
  async processAll(): Promise<number> {
    let totalProcessed = 0;
    let processed: number;

    do {
      if (this.stopping) {
        break;
      }
      processed = await this.processBatch();
      totalProcessed += processed;
    } while (processed > 0 && !this.stopping);

    return totalProcessed;
  }

  /**
   * Check if worker is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /** Wait for an in-flight batch before closing native/database resources. */
  async waitForIdle(): Promise<void> {
    while (this.activeBatch) {
      const batch = this.activeBatch;
      try {
        await batch;
      } catch {
        // The caller that started the batch owns error reporting.
      }
    }
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

// ============================================================
// Vector Worker V2 - Extended for Task Entity System
// ============================================================

import { dbAll, type Database } from './db-wrapper.js';
import { VectorOutbox } from './vector-outbox.js';
import type { OutboxJob, OutboxItemKind } from './types.js';

export interface WorkerConfigV2 {
  batchSize: number;
  pollIntervalMs: number;
  maxRetries: number;
  embeddingVersion: string;
}

const DEFAULT_CONFIG_V2: WorkerConfigV2 = {
  batchSize: 32,
  pollIntervalMs: 1000,
  maxRetries: 3,
  embeddingVersion: 'v1'
};

/**
 * Content provider interface for different item kinds
 */
export interface ContentProvider {
  getContent(itemKind: OutboxItemKind, itemId: string): Promise<{
    content: string;
    metadata: Record<string, unknown>;
  } | null>;
}

/**
 * Default content provider using database
 */
export class DefaultContentProvider implements ContentProvider {
  constructor(private db: Database) {}

  async getContent(itemKind: OutboxItemKind, itemId: string): Promise<{
    content: string;
    metadata: Record<string, unknown>;
  } | null> {
    switch (itemKind) {
      case 'entry':
        return this.getEntryContent(itemId);
      case 'task_title':
        return this.getTaskTitleContent(itemId);
      case 'event':
        return this.getEventContent(itemId);
      case 'perspective_observation':
        return this.getPerspectiveObservationContent(itemId);
      default:
        return null;
    }
  }

  private async getEntryContent(entryId: string): Promise<{
    content: string;
    metadata: Record<string, unknown>;
  } | null> {
    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT title, content_json, entry_type FROM entries WHERE entry_id = ?`,
      [entryId]
    );

    if (rows.length === 0) return null;

    const row = rows[0];
    const contentJson = typeof row.content_json === 'string'
      ? JSON.parse(row.content_json)
      : row.content_json;

    return {
      content: `${row.title}\n${JSON.stringify(contentJson)}`,
      metadata: {
        itemKind: 'entry',
        entryType: row.entry_type
      }
    };
  }

  private async getTaskTitleContent(taskId: string): Promise<{
    content: string;
    metadata: Record<string, unknown>;
  } | null> {
    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT title, search_text, current_json FROM entities
       WHERE entity_id = ? AND entity_type = 'task'`,
      [taskId]
    );

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      content: row.search_text as string || row.title as string,
      metadata: {
        itemKind: 'task_title',
        entityType: 'task'
      }
    };
  }

  private async getEventContent(eventId: string): Promise<{
    content: string;
    metadata: Record<string, unknown>;
  } | null> {
    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT content, event_type, session_id FROM events WHERE id = ?`,
      [eventId]
    );

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      content: row.content as string,
      metadata: {
        itemKind: 'event',
        eventType: row.event_type,
        sessionId: row.session_id
      }
    };
  }

  private async getPerspectiveObservationContent(observationId: string): Promise<{
    content: string;
    metadata: Record<string, unknown>;
  } | null> {
    let rows: Record<string, unknown>[];
    try {
      rows = await dbAll<Record<string, unknown>>(
        this.db,
        `SELECT project_hash, observer_actor_id, observed_actor_id, session_id, level, content,
                source_event_ids_json, source_observation_ids_json
         FROM perspective_observations
         WHERE observation_id = ? AND deleted_at IS NULL`,
        [observationId]
      );
    } catch (error) {
      if (isMissingPerspectiveObservationTable(error)) {
        return null;
      }
      throw error;
    }

    if (rows.length === 0) return null;

    const row = rows[0];
    const sourceEventIds = parseJsonArray(row.source_event_ids_json);
    const sourceObservationIds = parseJsonArray(row.source_observation_ids_json);

    return {
      content: row.content as string,
      metadata: {
        itemKind: 'perspective_observation',
        level: row.level,
        projectHash: row.project_hash,
        observerActorId: row.observer_actor_id,
        observedActorId: row.observed_actor_id,
        sessionId: row.session_id,
        sourceEventCount: sourceEventIds.length,
        sourceObservationCount: sourceObservationIds.length
      }
    };
  }
}

/**
 * Vector Worker V2 - Supports multiple item kinds
 */
export class VectorWorkerV2 {
  private readonly outbox: VectorOutbox;
  private readonly vectorStore: VectorStore;
  private readonly embedder: Embedder;
  private readonly contentProvider: ContentProvider;
  private readonly config: WorkerConfigV2;
  private running = false;
  private stopping = false;
  private pollTimeout: NodeJS.Timeout | null = null;
  private activeBatch: Promise<number> | null = null;

  constructor(
    db: Database,
    vectorStore: VectorStore,
    embedder: Embedder,
    config: Partial<WorkerConfigV2> = {},
    contentProvider?: ContentProvider
  ) {
    this.outbox = new VectorOutbox(db, {
      embeddingVersion: config.embeddingVersion ?? DEFAULT_CONFIG_V2.embeddingVersion,
      maxRetries: config.maxRetries ?? DEFAULT_CONFIG_V2.maxRetries
    });
    this.vectorStore = vectorStore;
    this.embedder = embedder;
    this.config = { ...DEFAULT_CONFIG_V2, ...config };
    this.contentProvider = contentProvider ?? new DefaultContentProvider(db);
  }

  /**
   * Start the worker polling loop
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.poll();
  }

  /**
   * Stop the worker
   */
  stop(): void {
    this.running = false;
    this.stopping = true;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
  }

  /**
   * Process a single batch of outbox jobs
   */
  async processBatch(): Promise<number> {
    if (this.activeBatch) {
      return this.activeBatch;
    }

    const batch = this.processBatchExclusive();
    this.activeBatch = batch;
    try {
      return await batch;
    } finally {
      if (this.activeBatch === batch) {
        this.activeBatch = null;
      }
    }
  }

  private async processBatchExclusive(): Promise<number> {
    const jobs = await this.outbox.claimJobs(this.config.batchSize);

    if (jobs.length === 0) {
      return 0;
    }

    let successCount = 0;

    for (const job of jobs) {
      try {
        await this.processJob(job);
        await this.outbox.markDone(job.jobId);
        successCount++;
      } catch (error) {
        // Only try to mark as failed if not stopping (DB might be closed)
        if (!this.stopping) {
          try {
            const errorMessage = error instanceof Error ? error.message : String(error);
            await this.outbox.markFailed(job.jobId, errorMessage);
          } catch {
            // Database might be closed during shutdown, ignore
          }
        }
      }
    }

    return successCount;
  }

  /**
   * Process a single job
   */
  private async processJob(job: OutboxJob): Promise<void> {
    // Get content
    const contentData = await this.contentProvider.getContent(job.itemKind, job.itemId);

    if (!contentData) {
      // Item not found, mark as done (skip)
      return;
    }

    // Generate embedding
    const embedding = await this.embedder.embed(contentData.content);

    // Upsert to vector store
    const record: VectorRecord = {
      id: `${job.itemKind}_${job.itemId}_${job.embeddingVersion}`,
      eventId: job.itemKind === 'event' ? job.itemId : '',
      sessionId: (contentData.metadata.sessionId as string) ?? '',
      eventType: (contentData.metadata.eventType as string) ?? job.itemKind,
      content: contentData.content,
      vector: embedding.vector,
      timestamp: new Date().toISOString(),
      metadata: {
        ...contentData.metadata,
        embeddingVersion: job.embeddingVersion
      }
    };

    // Use idempotent upsert (delete + add)
    await this.vectorStore.upsertBatch([record]);
  }

  /**
   * Poll for new jobs
   */
  private async poll(): Promise<void> {
    if (!this.running || this.stopping) return;

    try {
      await this.processBatch();
    } catch (error) {
      // Only log if not stopping (error during shutdown is expected)
      if (!this.stopping) {
        console.error('Vector worker V2 error:', error);
      }
    }

    // Schedule next poll only if still running
    if (this.running && !this.stopping) {
      this.pollTimeout = setTimeout(() => this.poll(), this.config.pollIntervalMs);
    }
  }

  /**
   * Process all pending jobs (blocking)
   */
  async processAll(): Promise<number> {
    let totalProcessed = 0;
    let processed: number;

    do {
      if (this.stopping) {
        break;
      }
      processed = await this.processBatch();
      totalProcessed += processed;
    } while (processed > 0 && !this.stopping);

    return totalProcessed;
  }

  /**
   * Run reconciliation
   */
  async reconcile(): Promise<{ recovered: number; retried: number }> {
    return this.outbox.reconcile();
  }

  /**
   * Get metrics
   */
  async getMetrics() {
    return this.outbox.getMetrics();
  }

  /**
   * Check if worker is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /** Wait for an in-flight batch before closing native/database resources. */
  async waitForIdle(): Promise<void> {
    while (this.activeBatch) {
      const batch = this.activeBatch;
      try {
        await batch;
      } catch {
        // The caller that started the batch owns error reporting.
      }
    }
  }

  /**
   * Get the outbox instance for direct access
   */
  getOutbox(): VectorOutbox {
    return this.outbox;
  }
}

/**
 * Create a Vector Worker V2 instance
 */
export function createVectorWorkerV2(
  db: Database,
  vectorStore: VectorStore,
  embedder: Embedder,
  config?: Partial<WorkerConfigV2>
): VectorWorkerV2 {
  return new VectorWorkerV2(db, vectorStore, embedder, config);
}
