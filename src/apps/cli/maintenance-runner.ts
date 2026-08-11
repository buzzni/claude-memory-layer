import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SQLiteEventStore } from '../../core/sqlite-event-store.js';
import type { OutboxRecoveryResult, OutboxStats } from '../../core/types.js';
import { WorkerLock } from '../../core/worker-lock.js';
import { loadSessionRegistry } from '../../core/registry/session-registry.js';
import { getProjectStoragePath } from '../../core/registry/project-path.js';
import { DISABLED_SHARED_STORE_CONFIG, MemoryService } from '../../services/memory-service.js';

export interface MaintenanceTarget {
  key: string;
  storagePath: string;
  projectHash?: string;
  projectPath?: string;
  modifiedAtMs: number;
}

export interface MaintenanceTargetResult {
  key: string;
  status: 'healthy' | 'processed' | 'busy' | 'needs-attention' | 'error';
  processed: number;
  recovered: number;
  pendingBefore: number;
  retryableBefore: number;
  pendingAfter: number;
  retryableAfter: number;
  quarantined: number;
  error?: string;
}

export interface MaintenanceRunReport {
  startedAt: string;
  finishedAt: string;
  scanned: number;
  processed: number;
  recovered: number;
  busy: number;
  errors: number;
  pendingRemaining: number;
  retryableRemaining: number;
  quarantined: number;
  results: MaintenanceTargetResult[];
}

export type MaintenanceLastRunStatus = Omit<MaintenanceRunReport, 'results'> & { version: 1 };

export interface MaintenanceRunOptions {
  homeDir?: string;
  projectPath?: string;
  maxProjects?: number;
  maxBatches?: number;
}

export interface MaintenanceRunnerDeps {
  discoverTargets?: (options: MaintenanceRunOptions) => MaintenanceTarget[];
  inspectTarget?: (target: MaintenanceTarget) => Promise<OutboxStats>;
  processTarget?: (target: MaintenanceTarget) => Promise<{
    processed: number;
    recovery: OutboxRecoveryResult;
    stats: OutboxStats;
  }>;
  now?: () => Date;
}

export function discoverMaintenanceTargets(options: MaintenanceRunOptions = {}): MaintenanceTarget[] {
  if (options.projectPath) {
    const projectPath = path.resolve(options.projectPath);
    const storagePath = getProjectStoragePath(projectPath);
    return fs.existsSync(path.join(storagePath, 'events.sqlite'))
      ? [{
        key: path.basename(storagePath),
        storagePath,
        projectHash: path.basename(storagePath),
        projectPath,
        modifiedAtMs: getStoreModifiedAtMs(storagePath)
      }]
      : [];
  }

  const homeDir = options.homeDir ?? os.homedir();
  const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
  const registry = loadSessionRegistry({ homeDir });
  const latestByHash = new Map<string, { projectPath: string; registeredAt: string }>();
  for (const entry of Object.values(registry.sessions)) {
    const existing = latestByHash.get(entry.projectHash);
    if (!existing || entry.registeredAt > existing.registeredAt) {
      latestByHash.set(entry.projectHash, entry);
    }
  }

  const targets: MaintenanceTarget[] = [];
  const globalDb = path.join(memoryRoot, 'events.sqlite');
  if (fs.existsSync(globalDb)) {
    targets.push({
      key: '__global__',
      storagePath: memoryRoot,
      modifiedAtMs: getStoreModifiedAtMs(memoryRoot)
    });
  }

  const projectsRoot = path.join(memoryRoot, 'projects');
  if (fs.existsSync(projectsRoot)) {
    for (const projectHash of fs.readdirSync(projectsRoot)) {
      if (!/^[a-f0-9]{8}$/.test(projectHash)) continue;
      const storagePath = path.join(projectsRoot, projectHash);
      const dbPath = path.join(storagePath, 'events.sqlite');
      if (!isLocalProjectStore(storagePath, dbPath)) continue;
      targets.push({
        key: projectHash,
        storagePath,
        projectHash,
        projectPath: latestByHash.get(projectHash)?.projectPath,
        modifiedAtMs: getStoreModifiedAtMs(storagePath)
      });
    }
  }

  const maxProjects = normalizeMaxProjects(options.maxProjects);
  return targets
    .sort((a, b) => b.modifiedAtMs - a.modifiedAtMs || a.key.localeCompare(b.key))
    .slice(0, maxProjects);
}

export async function runMaintenanceCycle(
  options: MaintenanceRunOptions = {},
  deps: MaintenanceRunnerDeps = {}
): Promise<MaintenanceRunReport> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const targets = (deps.discoverTargets ?? discoverMaintenanceTargets)(options);
  const inspect = deps.inspectTarget ?? inspectMaintenanceTarget;
  const maxBatches = normalizeMaxBatches(options.maxBatches);
  const processTarget = deps.processTarget ?? ((target) => processMaintenanceTarget(target, maxBatches));
  const results: MaintenanceTargetResult[] = [];

  for (const target of targets) {
    let pendingBefore = 0;
    let retryableBefore = 0;
    let quarantined = 0;
    try {
      const stats = await inspect(target);
      pendingBefore = pendingCount(stats);
      retryableBefore = retryableCount(stats);
      quarantined = quarantinedCount(stats);
      const stuck = stuckCount(stats);
      if (pendingBefore === 0 && retryableBefore === 0 && stuck === 0) {
        results.push({
          key: target.key,
          status: quarantined > 0 ? 'needs-attention' : 'healthy',
          processed: 0,
          recovered: 0,
          pendingBefore,
          retryableBefore,
          pendingAfter: pendingBefore,
          retryableAfter: retryableBefore,
          quarantined
        });
        continue;
      }

      const result = await processTarget(target);
      const recovered = recoveryCount(result.recovery);
      const pendingAfter = pendingCount(result.stats);
      const retryableAfter = retryableCount(result.stats);
      const remainingQuarantined = quarantinedCount(result.stats);
      results.push({
        key: target.key,
        status: remainingQuarantined > 0 ? 'needs-attention' : 'processed',
        processed: result.processed,
        recovered,
        pendingBefore,
        retryableBefore,
        pendingAfter,
        retryableAfter,
        quarantined: remainingQuarantined
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('worker busy:')) {
        results.push({
          key: target.key,
          status: 'busy',
          processed: 0,
          recovered: 0,
          pendingBefore,
          retryableBefore,
          pendingAfter: pendingBefore,
          retryableAfter: retryableBefore,
          quarantined
        });
      } else {
        results.push({
          key: target.key,
          status: 'error',
          processed: 0,
          recovered: 0,
          pendingBefore,
          retryableBefore,
          pendingAfter: pendingBefore,
          retryableAfter: retryableBefore,
          quarantined,
          error: sanitizeMaintenanceError(message)
        });
      }
    }
  }

  return {
    startedAt,
    finishedAt: now().toISOString(),
    scanned: targets.length,
    processed: results.reduce((sum, item) => sum + item.processed, 0),
    recovered: results.reduce((sum, item) => sum + item.recovered, 0),
    busy: results.filter((item) => item.status === 'busy').length,
    errors: results.filter((item) => item.status === 'error').length,
    pendingRemaining: results.reduce((sum, item) => sum + item.pendingAfter, 0),
    retryableRemaining: results.reduce((sum, item) => sum + item.retryableAfter, 0),
    quarantined: results.reduce((sum, item) => sum + item.quarantined, 0),
    results
  };
}

export function formatMaintenanceRunReport(report: MaintenanceRunReport): string {
  const attention = report.results.filter((item) => item.status === 'needs-attention').length;
  return [
    'Claude Memory Layer maintenance',
    `Scanned stores: ${report.scanned}`,
    `Processed embeddings: ${report.processed}`,
    `Recovered outbox jobs: ${report.recovered}`,
    `Busy stores skipped: ${report.busy}`,
    `Pending jobs remaining: ${report.pendingRemaining}`,
    `Retryable failures remaining: ${report.retryableRemaining}`,
    `Stores needing attention: ${attention}`,
    `Quarantined jobs: ${report.quarantined}`,
    `Errors: ${report.errors}`
  ].join('\n');
}

export function writeMaintenanceLastRunStatus(
  report: MaintenanceRunReport,
  homeDir: string = os.homedir()
): string {
  const filePath = getMaintenanceLastRunStatusPath(homeDir);
  const status: MaintenanceLastRunStatus = {
    version: 1,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    scanned: report.scanned,
    processed: report.processed,
    recovered: report.recovered,
    busy: report.busy,
    errors: report.errors,
    pendingRemaining: report.pendingRemaining,
    retryableRemaining: report.retryableRemaining,
    quarantined: report.quarantined
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  return filePath;
}

export function readMaintenanceLastRunStatus(
  homeDir: string = os.homedir()
): MaintenanceLastRunStatus | null {
  try {
    const value = JSON.parse(fs.readFileSync(getMaintenanceLastRunStatusPath(homeDir), 'utf8')) as Partial<MaintenanceLastRunStatus>;
    if (value.version !== 1 || typeof value.startedAt !== 'string' || typeof value.finishedAt !== 'string') return null;
    const numericKeys = [
      'scanned',
      'processed',
      'recovered',
      'busy',
      'errors',
      'pendingRemaining',
      'retryableRemaining',
      'quarantined'
    ] as const;
    if (numericKeys.some((key) => !Number.isFinite(value[key]))) return null;
    return value as MaintenanceLastRunStatus;
  } catch {
    return null;
  }
}

export function formatMaintenanceLastRunStatus(status: MaintenanceLastRunStatus | null): string {
  if (!status) return 'Last maintenance run: none';
  return [
    `Last maintenance run: ${status.finishedAt}`,
    `  scanned=${status.scanned} processed=${status.processed} recovered=${status.recovered}`,
    `  busy=${status.busy} errors=${status.errors} pending=${status.pendingRemaining} retryable=${status.retryableRemaining} quarantined=${status.quarantined}`
  ].join('\n');
}

function getMaintenanceLastRunStatusPath(homeDir: string): string {
  return path.join(homeDir, '.claude-code', 'memory', 'maintenance-status.json');
}

async function inspectMaintenanceTarget(target: MaintenanceTarget): Promise<OutboxStats> {
  const store = new SQLiteEventStore(path.join(target.storagePath, 'events.sqlite'), { readonly: true });
  try {
    await store.initialize();
    return await store.getOutboxStats();
  } catch (error) {
    if (!String(error).toLowerCase().includes('no such table')) throw error;
  } finally {
    await store.close().catch(() => undefined);
  }

  // A pre-outbox store cannot be inspected read-only until current tables are
  // present. Maintenance is already an explicit writable operation, so run the
  // normal idempotent schema initializer once and then continue.
  const migratingStore = new SQLiteEventStore(path.join(target.storagePath, 'events.sqlite'));
  try {
    await migratingStore.initialize();
    return await migratingStore.getOutboxStats();
  } finally {
    await migratingStore.close().catch(() => undefined);
  }
}

async function processMaintenanceTarget(target: MaintenanceTarget, maxBatches: number): Promise<{
  processed: number;
  recovery: OutboxRecoveryResult;
  stats: OutboxStats;
}> {
  const workerLock = new WorkerLock(path.join(target.storagePath, 'vector-worker.lock'));
  const lockResult = workerLock.acquire();
  if (!lockResult.acquired) {
    throw new Error(`worker busy:${lockResult.holderPid ?? 'unknown'}`);
  }

  const service = new MemoryService({
    storagePath: target.storagePath,
    projectHash: target.projectHash,
    projectPath: target.projectPath,
    embeddingOnly: true,
    analyticsEnabled: false,
    sharedStoreConfig: DISABLED_SHARED_STORE_CONFIG
  });
  try {
    await service.initialize();
    const recovery = await service.recoverStuckOutboxItems();
    const processed = await service.processPendingEmbeddings(maxBatches);
    const stats = await service.getOutboxStats();
    return { processed, recovery, stats };
  } finally {
    await service.shutdown().catch(() => undefined);
    workerLock.release();
  }
}

function pendingCount(stats: OutboxStats): number {
  return stats.embedding.pending + stats.vector.pending;
}

function retryableCount(stats: OutboxStats): number {
  return (stats.embedding.retryableFailed ?? 0) + (stats.vector.retryableFailed ?? 0);
}

function quarantinedCount(stats: OutboxStats): number {
  return (stats.embedding.quarantinedFailed ?? 0) + (stats.vector.quarantinedFailed ?? 0);
}

function stuckCount(stats: OutboxStats): number {
  return stats.embedding.stuckProcessing + stats.vector.stuckProcessing;
}

function recoveryCount(result: OutboxRecoveryResult): number {
  return result.embedding.recoveredProcessing
    + result.embedding.retriedFailed
    + result.vector.recoveredProcessing
    + result.vector.retriedFailed;
}

function normalizeMaxProjects(value: number | undefined): number {
  if (value === undefined) return Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('--max-projects must be a positive integer');
  return value;
}

function normalizeMaxBatches(value: number | undefined): number {
  if (value === undefined) return 4;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error('--max-batches must be an integer between 1 and 100');
  }
  return value;
}

function getStoreModifiedAtMs(storagePath: string): number {
  return ['events.sqlite', 'events.sqlite-wal']
    .map((name) => path.join(storagePath, name))
    .filter((file) => fs.existsSync(file))
    .reduce((latest, file) => Math.max(latest, fs.statSync(file).mtimeMs), 0);
}

function isLocalProjectStore(storagePath: string, dbPath: string): boolean {
  try {
    return fs.lstatSync(storagePath).isDirectory() && fs.lstatSync(dbPath).isFile();
  } catch {
    return false;
  }
}

function sanitizeMaintenanceError(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('embedding backend') || normalized.includes('onnx')) {
    return 'embedding backend unavailable';
  }
  if (normalized.includes('lance') || normalized.includes('vector')) {
    return 'vector store maintenance failed';
  }
  if (normalized.includes('sqlite') || normalized.includes('database')) {
    return 'SQLite maintenance failed';
  }
  return 'maintenance operation failed';
}
