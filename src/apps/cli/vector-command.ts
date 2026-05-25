import type { OutboxQueueStats, OutboxStats } from '../../core/types.js';
import type { MemoryStats } from '../../core/engine/memory-query-service.js';

export interface RawVectorStatusCommandOptions {
  project?: string;
}

export interface VectorStatusCommandOptions {
  projectPath: string;
}

export interface VectorStatusReportInput {
  stats: Pick<MemoryStats, 'totalEvents' | 'vectorCount' | 'levelStats'>;
  outbox: OutboxStats;
}

export function resolveVectorStatusCommandOptions(
  options: RawVectorStatusCommandOptions,
  cwd: string = process.cwd()
): VectorStatusCommandOptions {
  if (options.project !== undefined && options.project.trim().length === 0) {
    throw new Error('--project must not be empty');
  }
  return { projectPath: options.project ?? cwd };
}

export function formatVectorStatusReport(input: VectorStatusReportInput): string {
  const embedding = normalizeQueue(input.outbox.embedding);
  const vector = normalizeQueue(input.outbox.vector);
  const totals = sumQueues(embedding, vector);
  const status = totals.failed > 0 || totals.stuckProcessing > 0 ? 'needs-attention' : 'ok';
  const oldestProcessingAge = maxNullable(embedding.oldestProcessingAgeMs, vector.oldestProcessingAgeMs);
  const lines = [
    'Vector Outbox Status',
    `Vector count: ${input.stats.vectorCount}`,
    `Total events: ${input.stats.totalEvents}`,
    '',
    'Queue      pending  processing  failed  stuck  total  oldest',
    formatQueueRow('Embedding', embedding),
    formatQueueRow('Vector', vector),
    formatQueueRow('Total', totals),
    '',
    `Totals: pending=${totals.pending}, processing=${totals.processing}, failed=${totals.failed}, stuck=${totals.stuckProcessing}, total=${totals.total}`,
    `Oldest processing age: ${formatDuration(oldestProcessingAge)}`,
    `Status: ${status}`
  ];

  if (status === 'needs-attention') {
    lines.push('', 'Next step: claude-memory-layer process --dry-run-recovery');
  }

  return lines.join('\n');
}

function normalizeQueue(queue: OutboxQueueStats): OutboxQueueStats {
  return {
    pending: numberOrZero(queue.pending),
    processing: numberOrZero(queue.processing),
    failed: numberOrZero(queue.failed),
    total: numberOrZero(queue.total),
    stuckProcessing: numberOrZero(queue.stuckProcessing),
    oldestProcessingAgeMs: Number.isFinite(queue.oldestProcessingAgeMs ?? Number.NaN)
      ? queue.oldestProcessingAgeMs
      : null
  };
}

function sumQueues(a: OutboxQueueStats, b: OutboxQueueStats): OutboxQueueStats {
  return {
    pending: a.pending + b.pending,
    processing: a.processing + b.processing,
    failed: a.failed + b.failed,
    stuckProcessing: a.stuckProcessing + b.stuckProcessing,
    total: a.total + b.total,
    oldestProcessingAgeMs: maxNullable(a.oldestProcessingAgeMs, b.oldestProcessingAgeMs)
  };
}

function formatQueueRow(label: string, queue: OutboxQueueStats): string {
  return [
    label.padEnd(10),
    String(queue.pending).padStart(7),
    String(queue.processing).padStart(11),
    String(queue.failed).padStart(7),
    String(queue.stuckProcessing).padStart(6),
    String(queue.total).padStart(6),
    formatDuration(queue.oldestProcessingAgeMs).padStart(7)
  ].join('  ');
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function numberOrZero(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return 'none';
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
}
