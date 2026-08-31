import * as fs from 'node:fs';
import * as path from 'node:path';

import type { OutboxQueueStats, OutboxStats } from '../../core/types.js';
import type { MemoryStats } from '../../core/engine/memory-query-service.js';
import type { ExistingStoreStatus } from '../../core/registry/existing-store.js';
import {
  VectorStore,
  withVectorOptimizeIntegrityFailure,
  type VectorOptimizeResult,
  type VectorPhysicalHealth
} from '../../core/vector-store.js';
import { WorkerLock } from '../../core/worker-lock.js';
import { getProjectStoragePath } from '../../core/registry/project-path.js';

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
  storeStatus?: ExistingStoreStatus;
  physicalHealth?: VectorPhysicalHealth;
}

export interface VectorCompactionOptions {
  projectPath: string;
  apply?: boolean;
  minPhysicalBytes?: number;
}

export interface VectorCompactionReport {
  schemaVersion: 'vector-compaction-v1';
  mode: 'preview' | 'apply';
  projectHash: string;
  eligible: boolean;
  reasons: string[];
  physicalHealth: VectorPhysicalHealth;
  optimize?: VectorOptimizeResult;
  logicalCountBefore: number;
  logicalCountAfter: number;
  smokeCheck: 'not_run' | 'passed' | 'failed' | 'unsupported' | 'budget_exhausted';
}

type VectorStatus = 'ok' | 'needs-attention';
type VectorStatusRecommendedAction = 'none' | 'run-recovery' | 'inspect-quarantined';

interface NormalizedVectorStatusReport {
  store?: { status: ExistingStoreStatus };
  storage: {
    totalEvents: number;
    vectorCount: number;
  };
  physicalHealth?: VectorPhysicalHealth;
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
    ...(input.storeStatus && input.storeStatus !== 'existing'
      ? [`Store status: ${input.storeStatus} (no store initialized)`]
      : []),
    `Vector count: ${input.stats.vectorCount}`,
    `Total events: ${input.stats.totalEvents}`,
    ...(input.physicalHealth ? [
      `Physical bytes: ${formatNullableNumber(input.physicalHealth.physicalBytes)}`,
      `Tables/fragments/versions: ${formatNullableNumber(input.physicalHealth.tableCount)}/${formatNullableNumber(input.physicalHealth.fragmentCount)}/${formatNullableNumber(input.physicalHealth.versionCount)}`,
      `Bytes per logical vector: ${formatNullableNumber(input.physicalHealth.bytesPerLogicalVector)}`,
      `Last optimize: ${input.physicalHealth.lastOptimizeOutcome}${input.physicalHealth.lastOptimizedAt ? ` at ${input.physicalHealth.lastOptimizedAt}` : ''}`,
      `Amplification: ${input.physicalHealth.amplificationState}`
    ] : []),
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
    ...(input.storeStatus ? { store: { status: input.storeStatus } } : {}),
    storage: {
      totalEvents: numberOrZero(input.stats.totalEvents),
      vectorCount: numberOrZero(input.stats.vectorCount)
    },
    ...(input.physicalHealth ? { physicalHealth: input.physicalHealth } : {}),
    outbox: { embedding, vector, totals },
    status,
    recommendedAction: selectRecommendedAction(totals),
    oldestProcessingAgeMs
  };
}

function formatNullableNumber(value: number | null): string {
  return value === null ? 'unsupported' : String(value);
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

export async function runVectorCompaction(
  options: VectorCompactionOptions,
  deps: {
    storagePathForProject?: (projectPath: string) => string;
    createVectorStore?: (vectorsPath: string) => VectorStore;
  } = {}
): Promise<VectorCompactionReport> {
  if (!options.projectPath.trim()) throw new Error('--project must not be empty');
  const storagePath = (deps.storagePathForProject ?? getProjectStoragePath)(path.resolve(options.projectPath));
  const projectHash = path.basename(storagePath);
  const vectorsPath = path.join(storagePath, 'vectors');
  const usesDefaultStore = deps.createVectorStore === undefined;
  if (usesDefaultStore && !isOwnedVectorDirectory(storagePath, vectorsPath)) {
    return {
      schemaVersion: 'vector-compaction-v1',
      mode: options.apply ? 'apply' : 'preview',
      projectHash,
      eligible: false,
      reasons: [],
      physicalHealth: emptyVectorPhysicalHealth(),
      logicalCountBefore: 0,
      logicalCountAfter: 0,
      smokeCheck: 'not_run'
    };
  }
  const store = (deps.createVectorStore ?? ((target) => new VectorStore(target)))(vectorsPath);
  const minPhysicalBytes = options.minPhysicalBytes ?? 256 * 1024 * 1024;
  const inspect = async (): Promise<VectorCompactionReport> => {
    const logicalCountBefore = await countAllVectors(store);
    const physicalHealth = await store.getPhysicalHealth(logicalCountBefore);
    const reasons: string[] = [];
    const meetsPhysicalThreshold = (physicalHealth.physicalBytes ?? 0) >= minPhysicalBytes;
    if (meetsPhysicalThreshold) reasons.push('physical_size');
    if (physicalHealth.amplificationState === 'elevated' || physicalHealth.amplificationState === 'critical') {
      reasons.push('amplification');
    }
    if (physicalHealth.lastOptimizeOutcome === 'failed') reasons.push('prior_failure');
    if (physicalHealth.lastOptimizeOutcome === 'never' && meetsPhysicalThreshold) reasons.push('never_optimized');
    return {
      schemaVersion: 'vector-compaction-v1',
      mode: options.apply ? 'apply' : 'preview',
      projectHash,
      eligible: reasons.length > 0,
      reasons,
      physicalHealth,
      logicalCountBefore,
      logicalCountAfter: logicalCountBefore,
      smokeCheck: 'not_run'
    };
  };
  if (!options.apply) return inspect();

  const lock = new WorkerLock(path.join(storagePath, 'vector-worker.lock'));
  const acquired = lock.acquire();
  if (!acquired.acquired) throw new Error('vector compaction is busy');
  try {
    // The directory can be replaced after preview/initial validation. Recheck
    // under the project vector lock before invoking destructive Lance optimize.
    if (usesDefaultStore && !isOwnedVectorDirectory(storagePath, vectorsPath)) {
      throw new Error('vector compaction target changed or left project storage');
    }
    const base = await inspect();
    if (!base.eligible) return base;
    const verifyReadableSample = typeof store.createReadSmokeVerifier === 'function'
      ? await store.createReadSmokeVerifier()
      : async () => true;
    const optimize = await store.optimizeAll();
    const logicalCountAfter = await countAllVectors(store);
    const readableSamplePreserved = await verifyReadableSample();
    const integrityError = logicalCountAfter !== base.logicalCountBefore
      ? 'logical_count_mismatch'
      : !readableSamplePreserved
        ? 'read_smoke_failed'
        : null;
    const verifiedOptimize = integrityError
      ? withVectorOptimizeIntegrityFailure(optimize, integrityError)
      : optimize;
    if (integrityError && typeof store.persistOptimizeResult === 'function') {
      store.persistOptimizeResult(verifiedOptimize);
    }
    return {
      ...base,
      optimize: verifiedOptimize,
      logicalCountAfter,
      smokeCheck: verifiedOptimize.failures > 0
        ? 'failed'
        : verifiedOptimize.budgetExhausted
          ? 'budget_exhausted'
          : !verifiedOptimize.supported
            ? 'unsupported'
            : 'passed'
    };
  } finally {
    lock.release();
  }
}

async function countAllVectors(store: VectorStore): Promise<number> {
  return typeof store.countAll === 'function' ? store.countAll() : store.count();
}

export function isOwnedVectorDirectory(storagePath: string, vectorsPath: string): boolean {
  try {
    const storageStat = fs.lstatSync(storagePath);
    const vectorStat = fs.lstatSync(vectorsPath);
    if (!storageStat.isDirectory() || storageStat.isSymbolicLink()
      || !vectorStat.isDirectory() || vectorStat.isSymbolicLink()) return false;
    const relative = path.relative(fs.realpathSync(storagePath), fs.realpathSync(vectorsPath));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function emptyVectorPhysicalHealth(): VectorPhysicalHealth {
  return {
    physicalBytes: 0,
    tableCount: 0,
    fragmentCount: 0,
    versionCount: 0,
    bytesPerLogicalVector: null,
    lastOptimizedAt: null,
    lastOptimizeOutcome: 'never',
    amplificationState: 'unknown'
  };
}
