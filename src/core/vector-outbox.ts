/**
 * Vector Outbox V2 - Transactional Outbox Pattern
 * AXIOMMIND Principle 6: DuckDB → outbox → LanceDB unidirectional flow
 */

import { dbRun, dbAll, toDate, type Database } from './db-wrapper.js';
import { randomUUID } from 'crypto';
import type {
  OutboxJob,
  OutboxStatus,
  OutboxItemKind
} from './types.js';

export interface OutboxConfig {
  embeddingVersion: string;
  maxRetries: number;
  stuckThresholdMs: number;
  cleanupDays: number;
}

const DEFAULT_CONFIG: OutboxConfig = {
  embeddingVersion: 'v1',
  maxRetries: 3,
  stuckThresholdMs: 5 * 60 * 1000,  // 5 minutes
  cleanupDays: 7
};

export interface OutboxMetrics {
  pendingCount: number;
  processingCount: number;
  doneCount: number;
  failedCount: number;
  oldestPendingAge: number | null;
}

export interface OutboxEnqueueInput {
  itemKind: OutboxItemKind;
  itemId: string;
  embeddingVersion?: string;
}

export type EnqueueResult =
  | { success: true; jobId: string; isNew: boolean }
  | { success: false; error: string };

export class VectorOutbox {
  private config: OutboxConfig;

  constructor(
    private db: Database,
    config?: Partial<OutboxConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Enqueue item for vectorization (idempotent).
   * Returns the already-existing job id when the same item/version has been enqueued before.
   */
  async enqueue(
    itemKind: OutboxItemKind,
    itemId: string,
    embeddingVersion?: string
  ): Promise<string> {
    const result = await this.enqueueWithResult({ itemKind, itemId, embeddingVersion });
    if (result.success === false) {
      throw new Error(result.error);
    }
    return result.jobId;
  }

  async enqueueBatch(inputs: OutboxEnqueueInput[]): Promise<EnqueueResult[]> {
    const results: EnqueueResult[] = [];
    for (const input of inputs) {
      results.push(await this.enqueueWithResult(input));
    }
    return results;
  }

  async enqueueWithResult(input: OutboxEnqueueInput): Promise<EnqueueResult> {
    const version = input.embeddingVersion ?? this.config.embeddingVersion;
    const jobId = randomUUID();
    const now = new Date().toISOString();

    try {
      const result = this.db.prepare(`INSERT INTO vector_outbox (
        job_id, item_kind, item_id, embedding_version, status, retry_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
      ON CONFLICT (item_kind, item_id, embedding_version) DO NOTHING`).run(
        jobId,
        input.itemKind,
        input.itemId,
        version,
        now,
        now
      );

      const row = this.db.prepare(`SELECT job_id FROM vector_outbox
        WHERE item_kind = ? AND item_id = ? AND embedding_version = ?`).get(
          input.itemKind,
          input.itemId,
          version
        ) as { job_id: string } | undefined;

      if (!row) {
        return { success: false, error: 'vector outbox enqueue did not create or find a job' };
      }

      return { success: true, jobId: row.job_id, isNew: Number(result.changes ?? 0) > 0 };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Claim pending jobs for processing
   */
  async claimJobs(limit: number = 32): Promise<OutboxJob[]> {
    const now = new Date().toISOString();

    // Atomic claim using UPDATE RETURNING
    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `UPDATE vector_outbox
       SET status = 'processing', updated_at = ?
       WHERE job_id IN (
         SELECT job_id FROM vector_outbox
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT ?
       )
       RETURNING *`,
      [now, limit]
    );

    return rows.map(row => this.rowToJob(row));
  }

  /**
   * Mark job as done
   */
  async markDone(jobId: string): Promise<void> {
    await dbRun(
      this.db,
      `UPDATE vector_outbox
       SET status = 'done', updated_at = ?
       WHERE job_id = ?`,
      [new Date().toISOString(), jobId]
    );
  }

  /**
   * Mark job as failed
   */
  async markFailed(jobId: string, error: string): Promise<void> {
    const now = new Date().toISOString();

    // Check retry count
    const rows = await dbAll<{ retry_count: number }>(
      this.db,
      `SELECT retry_count FROM vector_outbox WHERE job_id = ?`,
      [jobId]
    );

    if (rows.length === 0) return;

    const retryCount = rows[0].retry_count;
    const newStatus: OutboxStatus = retryCount >= this.config.maxRetries - 1
      ? 'failed'
      : 'pending';  // Will retry

    await dbRun(
      this.db,
      `UPDATE vector_outbox
       SET status = ?, error = ?, retry_count = retry_count + 1, updated_at = ?
       WHERE job_id = ?`,
      [newStatus, error, now, jobId]
    );
  }

  /**
   * Get job by ID
   */
  async getJob(jobId: string): Promise<OutboxJob | null> {
    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM vector_outbox WHERE job_id = ?`,
      [jobId]
    );

    if (rows.length === 0) return null;
    return this.rowToJob(rows[0]);
  }

  /**
   * Get jobs by status
   */
  async getJobsByStatus(status: OutboxStatus, limit: number = 100): Promise<OutboxJob[]> {
    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM vector_outbox
       WHERE status = ?
       ORDER BY created_at ASC
       LIMIT ?`,
      [status, limit]
    );

    return rows.map(row => this.rowToJob(row));
  }

  /**
   * Reconcile: recover stuck and retry failed jobs
   */
  async reconcile(referenceTime: Date = new Date()): Promise<{ recovered: number; retried: number }> {
    const stuckThreshold = new Date(referenceTime.getTime() - this.config.stuckThresholdMs);
    const nowIso = referenceTime.toISOString();

    // Recover stuck processing jobs
    const recovered = this.db.prepare(`UPDATE vector_outbox
       SET status = 'pending', updated_at = ?, error = NULL
       WHERE status = 'processing'
       AND updated_at < ?`).run(nowIso, stuckThreshold.toISOString());

    // Retry failed jobs that haven't exceeded max retries
    const retried = this.db.prepare(`UPDATE vector_outbox
       SET status = 'pending', updated_at = ?, error = NULL
       WHERE status = 'failed'
       AND retry_count < ?`).run(nowIso, this.config.maxRetries);

    return {
      recovered: Number(recovered.changes ?? 0),
      retried: Number(retried.changes ?? 0)
    };
  }

  /**
   * Cleanup old done jobs
   */
  async cleanup(referenceTime: Date = new Date()): Promise<number> {
    const threshold = new Date(referenceTime.getTime() - this.config.cleanupDays * 24 * 60 * 60 * 1000);

    const result = this.db.prepare(`DELETE FROM vector_outbox
       WHERE status = 'done'
       AND updated_at < ?`).run(threshold.toISOString());

    return Number(result.changes ?? 0);
  }

  /**
   * Get metrics
   */
  async getMetrics(): Promise<OutboxMetrics> {
    const statusCounts = await dbAll<{ status: string; count: number }>(
      this.db,
      `SELECT status, COUNT(*) as count
       FROM vector_outbox
       GROUP BY status`
    );

    const oldestPending = await dbAll<{ created_at: string }>(
      this.db,
      `SELECT created_at FROM vector_outbox
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT 1`
    );

    const metrics: OutboxMetrics = {
      pendingCount: 0,
      processingCount: 0,
      doneCount: 0,
      failedCount: 0,
      oldestPendingAge: null
    };

    for (const row of statusCounts) {
      switch (row.status) {
        case 'pending':
          metrics.pendingCount = Number(row.count);
          break;
        case 'processing':
          metrics.processingCount = Number(row.count);
          break;
        case 'done':
          metrics.doneCount = Number(row.count);
          break;
        case 'failed':
          metrics.failedCount = Number(row.count);
          break;
      }
    }

    if (oldestPending.length > 0) {
      const oldestDate = new Date(oldestPending[0].created_at);
      metrics.oldestPendingAge = Date.now() - oldestDate.getTime();
    }

    return metrics;
  }

  /**
   * Validate state transition
   */
  isValidTransition(from: OutboxStatus, to: OutboxStatus): boolean {
    const validTransitions = [
      { from: 'pending', to: 'processing' },
      { from: 'processing', to: 'done' },
      { from: 'processing', to: 'failed' },
      { from: 'failed', to: 'pending' }
    ];

    return validTransitions.some(t => t.from === from && t.to === to);
  }

  /**
   * Convert database row to OutboxJob
   */
  private rowToJob(row: Record<string, unknown>): OutboxJob {
    return {
      jobId: row.job_id as string,
      itemKind: row.item_kind as OutboxItemKind,
      itemId: row.item_id as string,
      embeddingVersion: row.embedding_version as string,
      status: row.status as OutboxStatus,
      retryCount: row.retry_count as number,
      error: row.error as string | undefined,
      createdAt: toDate(row.created_at),
      updatedAt: toDate(row.updated_at)
    };
  }
}
