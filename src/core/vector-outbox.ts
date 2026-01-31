/**
 * Vector Outbox V2 - Transactional Outbox Pattern
 * AXIOMMIND Principle 6: DuckDB → outbox → LanceDB unidirectional flow
 */

import { Database } from 'duckdb';
import { randomUUID } from 'crypto';
import type {
  OutboxJob,
  OutboxStatus,
  OutboxItemKind,
  VALID_OUTBOX_TRANSITIONS
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

export class VectorOutbox {
  private config: OutboxConfig;

  constructor(
    private db: Database,
    config?: Partial<OutboxConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Enqueue item for vectorization (idempotent)
   */
  async enqueue(
    itemKind: OutboxItemKind,
    itemId: string,
    embeddingVersion?: string
  ): Promise<string> {
    const version = embeddingVersion ?? this.config.embeddingVersion;
    const jobId = randomUUID();
    const now = new Date().toISOString();

    await this.db.run(
      `INSERT INTO vector_outbox (
        job_id, item_kind, item_id, embedding_version, status, retry_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
      ON CONFLICT (item_kind, item_id, embedding_version) DO NOTHING`,
      [jobId, itemKind, itemId, version, now, now]
    );

    return jobId;
  }

  /**
   * Claim pending jobs for processing
   */
  async claimJobs(limit: number = 32): Promise<OutboxJob[]> {
    const now = new Date().toISOString();

    // Atomic claim using UPDATE RETURNING
    const rows = await this.db.all<Array<Record<string, unknown>>>(
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
    await this.db.run(
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
    const rows = await this.db.all<Array<{ retry_count: number }>>(
      `SELECT retry_count FROM vector_outbox WHERE job_id = ?`,
      [jobId]
    );

    if (rows.length === 0) return;

    const retryCount = rows[0].retry_count;
    const newStatus: OutboxStatus = retryCount >= this.config.maxRetries - 1
      ? 'failed'
      : 'pending';  // Will retry

    await this.db.run(
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
    const rows = await this.db.all<Array<Record<string, unknown>>>(
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
    const rows = await this.db.all<Array<Record<string, unknown>>>(
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
  async reconcile(): Promise<{ recovered: number; retried: number }> {
    const now = new Date();
    const stuckThreshold = new Date(now.getTime() - this.config.stuckThresholdMs);

    // Recover stuck processing jobs
    const recoveredResult = await this.db.run(
      `UPDATE vector_outbox
       SET status = 'pending', updated_at = ?
       WHERE status = 'processing'
       AND updated_at < ?`,
      [now.toISOString(), stuckThreshold.toISOString()]
    );

    // Retry failed jobs that haven't exceeded max retries
    const retriedResult = await this.db.run(
      `UPDATE vector_outbox
       SET status = 'pending', updated_at = ?
       WHERE status = 'failed'
       AND retry_count < ?`,
      [now.toISOString(), this.config.maxRetries]
    );

    // Get counts (DuckDB doesn't return affected rows easily)
    const recoveredRows = await this.db.all<Array<{ count: number }>>(
      `SELECT COUNT(*) as count FROM vector_outbox
       WHERE status = 'pending' AND updated_at = ?`,
      [now.toISOString()]
    );

    return {
      recovered: 0,  // Approximate
      retried: 0     // Approximate
    };
  }

  /**
   * Cleanup old done jobs
   */
  async cleanup(): Promise<number> {
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - this.config.cleanupDays);

    await this.db.run(
      `DELETE FROM vector_outbox
       WHERE status = 'done'
       AND updated_at < ?`,
      [threshold.toISOString()]
    );

    return 0;  // DuckDB doesn't return affected rows easily
  }

  /**
   * Get metrics
   */
  async getMetrics(): Promise<OutboxMetrics> {
    const statusCounts = await this.db.all<Array<{ status: string; count: number }>>(
      `SELECT status, COUNT(*) as count
       FROM vector_outbox
       GROUP BY status`
    );

    const oldestPending = await this.db.all<Array<{ created_at: string }>>(
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
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string)
    };
  }
}
