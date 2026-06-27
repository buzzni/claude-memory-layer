import type { OutboxQueueStats, OutboxStats } from '../../core/types.js';
import type { MemoryStats } from '../../core/engine/memory-query-service.js';

export interface RawVectorStatusCommandOptions {
  project?: string;
  json?: boolean;
}

export interface VectorStatusCommandOptions {
  projectPath: string;
  json: boolean;
}

export interface VectorStatusReportInput {
  stats: Pick<MemoryStats, 'totalEvents' | 'vectorCount' | 'levelStats'>;
  outbox: OutboxStats;
}

type VectorStatus = 'ok' | 'needs-attention';
type VectorStatusRecommendedAction = 'none' | 'run-recovery' | 'inspect-quarantined';

interface NormalizedVectorStatusReport {
  storage: {
    totalEvents: number;
    vectorCount: number;
  };
  outbox: {
    embedding: OutboxQueueStats;
    vector: OutboxQueueStats;
    totals: OutboxQueueStats;
  };
  status: VectorStatus;
  recommendedAction: VectorStatusRecommendedAction;
  oldestProcessingAgeMs: number | null;
}

export function resolveVectorStatusCommandOptions(
  options: RawVectorStatusCommandOptions,
  cwd: string = process.cwd()
): VectorStatusCommandOptions {
  if (options.project !== undefined && options.project.trim().length === 0) {
    throw new Error('--project must not be empty');
  }
  return { projectPath: options.project ?? cwd, json: options.json === true };
}

export function formatVectorStatusReport(input: VectorStatusReportInput): string {
  const report = buildVectorStatusReport(input);
  const { embedding, vector, totals } = report.outbox;
  const oldestProcessingAge = report.oldestProcessingAgeMs;
  const lines = [
    'Vector Outbox Status',
    `Vector count: ${input.stats.vectorCount}`,
    `Total events: ${input.stats.totalEvents}`,
    '',
    'Queue      pending  processing  failed  retryable  quarantined  stuck  total  oldest',
    formatQueueRow('Embedding', embedding),
    formatQueueRow('Vector', vector),
    formatQueueRow('Total', totals),
    '',
    `Totals: pending=${totals.pending}, processing=${totals.processing}, failed=${totals.failed}, retryableFailed=${totals.retryableFailed ?? 0}, quarantinedFailed=${totals.quarantinedFailed ?? 0}, stuck=${totals.stuckProcessing}, total=${totals.total}`,
    `Oldest processing age: ${formatDuration(oldestProcessingAge)}`,
    `Status: ${report.status}`
  ];

  if (report.recommendedAction === 'run-recovery') {
    lines.push('', 'Next step: claude-memory-layer process --dry-run-recovery');
  } else if (report.recommendedAction === 'inspect-quarantined') {
    lines.push('', 'Next step: inspect quarantined outbox failures; recovery has no retryable failed rows.');
  }

  return lines.join('\n');
}

export function formatVectorStatusJsonReport(input: VectorStatusReportInput): string {
  return JSON.stringify(buildVectorStatusReport(input), null, 2);
}

function buildVectorStatusReport(input: VectorStatusReportInput): NormalizedVectorStatusReport {
  const embedding = normalizeQueue(input.outbox.embedding);
  const vector = normalizeQueue(input.outbox.vector);
  const totals = sumQueues(embedding, vector);
  const status: VectorStatus = totals.failed > 0 || totals.stuckProcessing > 0 ? 'needs-attention' : 'ok';
  const oldestProcessingAgeMs = maxNullable(embedding.oldestProcessingAgeMs, vector.oldestProcessingAgeMs);
  return {
    storage: {
      totalEvents: numberOrZero(input.stats.totalEvents),
      vectorCount: numberOrZero(input.stats.vectorCount)
    },
    outbox: { embedding, vector, totals },
    status,
    recommendedAction: selectRecommendedAction(totals),
    oldestProcessingAgeMs
  };
}

function selectRecommendedAction(totals: OutboxQueueStats): VectorStatusRecommendedAction {
  if ((totals.retryableFailed ?? 0) > 0 || totals.stuckProcessing > 0) return 'run-recovery';
  if ((totals.quarantinedFailed ?? 0) > 0) return 'inspect-quarantined';
  return 'none';
}

function normalizeQueue(queue: OutboxQueueStats): OutboxQueueStats {
  return {
    pending: numberOrZero(queue.pending),
    processing: numberOrZero(queue.processing),
    failed: numberOrZero(queue.failed),
    retryableFailed: numberOrZero(queue.retryableFailed),
    quarantinedFailed: numberOrZero(queue.quarantinedFailed),
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
    retryableFailed: (a.retryableFailed ?? 0) + (b.retryableFailed ?? 0),
    quarantinedFailed: (a.quarantinedFailed ?? 0) + (b.quarantinedFailed ?? 0),
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
    String(queue.retryableFailed ?? 0).padStart(9),
    String(queue.quarantinedFailed ?? 0).padStart(11),
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

function numberOrZero(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
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
