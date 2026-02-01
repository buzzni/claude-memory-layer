/**
 * Sync Worker - SQLite to DuckDB synchronization
 * Runs periodically to sync primary store (SQLite) to analytics store (DuckDB)
 */

import { SQLiteEventStore } from './sqlite-event-store.js';
import { EventStore } from './event-store.js';
import { MemoryEvent } from './types.js';

export interface SyncWorkerConfig {
  intervalMs: number;      // Sync interval (default: 30000 = 30 seconds)
  batchSize: number;       // Events per batch (default: 500)
  maxRetries: number;      // Max retries on failure (default: 3)
  retryDelayMs: number;    // Delay between retries (default: 5000)
}

const DEFAULT_CONFIG: SyncWorkerConfig = {
  intervalMs: 30000,
  batchSize: 500,
  maxRetries: 3,
  retryDelayMs: 5000
};

export interface SyncStats {
  lastSyncAt: Date | null;
  eventsSynced: number;
  sessionsSynced: number;
  errors: number;
  status: 'idle' | 'syncing' | 'error' | 'stopped';
}

export class SyncWorker {
  private config: SyncWorkerConfig;
  private intervalHandle: NodeJS.Timeout | null = null;
  private running = false;
  private stats: SyncStats = {
    lastSyncAt: null,
    eventsSynced: 0,
    sessionsSynced: 0,
    errors: 0,
    status: 'idle'
  };

  constructor(
    private sqliteStore: SQLiteEventStore,
    private duckdbStore: EventStore,
    config?: Partial<SyncWorkerConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the sync worker
   */
  start(): void {
    if (this.running) return;

    this.running = true;
    this.stats.status = 'idle';

    // Run initial sync
    this.syncNow().catch(err => {
      console.error('[SyncWorker] Initial sync failed:', err);
    });

    // Schedule periodic sync
    this.intervalHandle = setInterval(() => {
      this.syncNow().catch(err => {
        console.error('[SyncWorker] Periodic sync failed:', err);
      });
    }, this.config.intervalMs);
  }

  /**
   * Stop the sync worker
   */
  stop(): void {
    this.running = false;
    this.stats.status = 'stopped';

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Trigger immediate sync
   */
  async syncNow(): Promise<void> {
    if (this.stats.status === 'syncing') {
      return; // Already syncing
    }

    this.stats.status = 'syncing';

    try {
      await this.syncEvents();
      await this.syncSessions();
      this.stats.lastSyncAt = new Date();
      this.stats.status = 'idle';
    } catch (error) {
      this.stats.errors++;
      this.stats.status = 'error';
      throw error;
    }
  }

  /**
   * Sync events from SQLite to DuckDB
   */
  private async syncEvents(): Promise<void> {
    const targetName = 'duckdb_analytics';

    // Get last sync position from SQLite
    const position = await this.sqliteStore.getSyncPosition(targetName);
    const lastTimestamp = position.lastTimestamp || '1970-01-01T00:00:00.000Z';

    let hasMore = true;
    let totalSynced = 0;

    while (hasMore) {
      // Get batch of events since last sync
      const events = await this.sqliteStore.getEventsSince(lastTimestamp, this.config.batchSize);

      if (events.length === 0) {
        hasMore = false;
        break;
      }

      // Insert into DuckDB with retry
      await this.retryWithBackoff(async () => {
        for (const event of events) {
          await this.insertEventToDuckDB(event);
        }
      });

      totalSynced += events.length;

      // Update sync position
      const lastEvent = events[events.length - 1];
      await this.sqliteStore.updateSyncPosition(
        targetName,
        lastEvent.id,
        lastEvent.timestamp.toISOString()
      );

      // Check if we got a full batch (more to sync)
      hasMore = events.length === this.config.batchSize;
    }

    this.stats.eventsSynced += totalSynced;
  }

  /**
   * Sync sessions from SQLite to DuckDB
   */
  private async syncSessions(): Promise<void> {
    // Get all sessions from SQLite
    const sessions = await this.sqliteStore.getAllSessions();

    // Upsert each session to DuckDB
    for (const session of sessions) {
      await this.retryWithBackoff(async () => {
        await this.duckdbStore.upsertSession(session);
      });
    }

    this.stats.sessionsSynced = sessions.length;
  }

  /**
   * Insert a single event into DuckDB
   */
  private async insertEventToDuckDB(event: MemoryEvent): Promise<void> {
    // Use append which handles deduplication
    await this.duckdbStore.append({
      eventType: event.eventType,
      sessionId: event.sessionId,
      timestamp: event.timestamp,
      content: event.content,
      metadata: event.metadata
    });
  }

  /**
   * Retry operation with exponential backoff
   */
  private async retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.config.maxRetries - 1) {
          const delay = this.config.retryDelayMs * Math.pow(2, attempt);
          await this.sleep(delay);
        }
      }
    }

    throw lastError;
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get sync statistics
   */
  getStats(): SyncStats {
    return { ...this.stats };
  }

  /**
   * Check if worker is running
   */
  isRunning(): boolean {
    return this.running;
  }
}
