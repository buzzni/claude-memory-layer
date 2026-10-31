import * as fs from 'node:fs';
import * as path from 'node:path';

import { MongoClient } from 'mongodb';

import {
  auditMongoSync,
  type MongoAuditCollection,
  type MongoSyncAuditReport
} from '../../core/mongo-sync-audit.js';
import { redactMongoUri } from '../../core/mongo-sync-config.js';
import { SQLiteEventStore } from '../../core/sqlite-event-store.js';
import {
  getProjectStoragePath as defaultGetProjectStoragePath,
  hashProjectPath as defaultHashProjectPath
} from '../../core/registry/project-path.js';
import { WorkerLock, type WorkerLockAcquireResult } from '../../core/worker-lock.js';
import { createMemoryService as defaultCreateMemoryService } from '../../services/memory-service.js';
import { DISABLED_SHARED_STORE_CONFIG } from '../../services/memory-service-config.js';
import type { MemoryServiceRegistryConfig } from '../../services/memory-service-registry.js';

export interface RawMongoSyncProcessOptions {
  project?: string;
  processAfterSync?: boolean;
  processInterval?: string;
  processLockPath?: string;
}

export interface MongoSyncProcessOptions {
  projectPath: string;
  processAfterSync: boolean;
  processIntervalMs: number;
  lockPath: string;
}

export interface MongoSyncProcessOptionsDeps {
  getProjectStoragePath?: (projectPath: string) => string;
}

export interface MongoSyncResultSummary {
  pushed: number;
  pulled: number;
}

export interface MongoSyncProcessOnceInput {
  projectPath: string;
  lockPath: string;
}

export interface MongoSyncProcessOnceResult {
  skipped: boolean;
  processed: number;
  holderPid?: number | null;
}

export interface MongoSyncPostProcessor {
  afterSync(result: MongoSyncResultSummary): Promise<void>;
}

export interface MongoSyncPostProcessorDeps {
  now?: () => number;
  processOnce?: (input: MongoSyncProcessOnceInput) => Promise<MongoSyncProcessOnceResult>;
  log?: (message: string) => void;
}

export interface MongoSyncProcessService {
  initialize(): Promise<void>;
  recoverStuckOutboxItems(): Promise<unknown>;
  processPendingEmbeddings(): Promise<number>;
  shutdown(): Promise<void>;
}

export interface MongoSyncProcessWorkerLock {
  acquire(): WorkerLockAcquireResult;
  release(): boolean;
}

export interface ProcessProjectEmbeddingsDeps {
  createMemoryService?: (config: MemoryServiceRegistryConfig) => MongoSyncProcessService;
  getProjectStoragePath?: (projectPath: string) => string;
  hashProjectPath?: (projectPath: string) => string;
  createWorkerLock?: (lockPath: string) => MongoSyncProcessWorkerLock;
}

export interface RawMongoSyncTargetOptions {
  project?: string;
  mongoUri?: string;
  mongoDb?: string;
  mongoProject?: string;
}

export interface MongoSyncTarget {
  projectPath: string;
  uri?: string;
  dbName?: string;
  projectKey: string;
}

export interface MongoAuditConnection {
  collection: MongoAuditCollection;
  close(): Promise<void>;
}

export interface MongoSyncAuditDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  getProjectStoragePath?: (projectPath: string) => string;
  connect?: (uri: string, dbName: string) => Promise<MongoAuditConnection>;
}

export interface MongoSyncAuditOutcome {
  status: 'pass' | 'warn' | 'fail' | 'skip';
  projectKey: string;
  detail: string;
  report?: MongoSyncAuditReport;
}

const DEFAULT_PROCESS_INTERVAL_MS = 120_000;
const ORIGIN_CURSOR_ISSUE_URL = 'https://github.com/buzzni/claude-memory-layer/issues/142';
const MAX_LISTED_INSTANCES = 20;

/** Flags win over env; the remote project key defaults to the project directory name. */
export function resolveMongoSyncTarget(
  options: RawMongoSyncTargetOptions,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): MongoSyncTarget {
  const projectPath = options.project || cwd;
  return {
    projectPath,
    uri: options.mongoUri || env.CLAUDE_MEMORY_MONGO_URI,
    dbName: options.mongoDb || env.CLAUDE_MEMORY_MONGO_DB,
    projectKey: options.mongoProject || env.CLAUDE_MEMORY_MONGO_PROJECT || path.basename(projectPath)
  };
}

export function resolveMongoSyncProcessOptions(
  options: RawMongoSyncProcessOptions,
  cwd: string = process.cwd(),
  deps: MongoSyncProcessOptionsDeps = {}
): MongoSyncProcessOptions {
  const explicitProject = options.project;
  if (explicitProject !== undefined && explicitProject.trim().length === 0) {
    throw new Error('--project must not be empty');
  }

  const explicitLockPath = options.processLockPath;
  if (explicitLockPath !== undefined && explicitLockPath.trim().length === 0) {
    throw new Error('--process-lock-path must not be empty');
  }

  const projectPath = explicitProject ?? cwd;
  const processIntervalMs = parsePositiveIntegerOption(
    options.processInterval ?? String(DEFAULT_PROCESS_INTERVAL_MS),
    '--process-interval'
  );
  const getProjectStoragePath = deps.getProjectStoragePath ?? defaultGetProjectStoragePath;

  return {
    projectPath,
    processAfterSync: options.processAfterSync === true,
    processIntervalMs,
    lockPath: explicitLockPath ?? path.join(getProjectStoragePath(projectPath), 'vector-worker.lock')
  };
}

export function createMongoSyncPostProcessor(
  options: MongoSyncProcessOptions,
  deps: MongoSyncPostProcessorDeps = {}
): MongoSyncPostProcessor {
  const now = deps.now ?? (() => Date.now());
  const processOnce = deps.processOnce ?? processProjectEmbeddingsOnce;
  const log = deps.log ?? (() => undefined);
  let lastProcessAtMs: number | null = null;

  return {
    async afterSync(result: MongoSyncResultSummary): Promise<void> {
      if (!options.processAfterSync) return;
      if (result.pulled <= 0) return;

      const currentTimeMs = now();
      if (lastProcessAtMs !== null && currentTimeMs - lastProcessAtMs < options.processIntervalMs) {
        return;
      }

      lastProcessAtMs = currentTimeMs;
      log(`[mongo-sync] Processing pending embeddings after pulling ${result.pulled} events...`);
      let outcome: MongoSyncProcessOnceResult;
      try {
        outcome = await processOnce({
          projectPath: options.projectPath,
          lockPath: options.lockPath
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`[mongo-sync] Process-after-sync failed: ${message}`);
        return;
      }

      if (outcome.skipped) {
        const holder = outcome.holderPid === undefined || outcome.holderPid === null ? 'unknown' : String(outcome.holderPid);
        log(`[mongo-sync] Skipped embedding processing because another vector worker is running (holderPid=${holder})`);
        return;
      }

      log(`[mongo-sync] Processed ${outcome.processed} embeddings after sync`);
    }
  };
}

export async function processProjectEmbeddingsOnce(
  input: MongoSyncProcessOnceInput,
  deps: ProcessProjectEmbeddingsDeps = {}
): Promise<MongoSyncProcessOnceResult> {
  const createWorkerLock = deps.createWorkerLock ?? ((lockPath: string) => new WorkerLock(lockPath));
  const createService = deps.createMemoryService ?? defaultCreateMemoryService;
  const getProjectStoragePath = deps.getProjectStoragePath ?? defaultGetProjectStoragePath;
  const hashProjectPath = deps.hashProjectPath ?? defaultHashProjectPath;
  const workerLock = createWorkerLock(input.lockPath);
  const lockResult = workerLock.acquire();

  if (!lockResult.acquired) {
    return {
      skipped: true,
      processed: 0,
      holderPid: 'holderPid' in lockResult ? lockResult.holderPid : null
    };
  }

  let service: MongoSyncProcessService | undefined;
  try {
    service = createService({
      storagePath: getProjectStoragePath(input.projectPath),
      projectHash: hashProjectPath(input.projectPath),
      projectPath: input.projectPath,
      sharedStoreConfig: DISABLED_SHARED_STORE_CONFIG,
      analyticsEnabled: false
    });
    await service.initialize();
    await service.recoverStuckOutboxItems();
    const processed = await service.processPendingEmbeddings();
    return { skipped: false, processed };
  } finally {
    workerLock.release();
    await service?.shutdown().catch(() => undefined);
  }
}

function parsePositiveIntegerOption(raw: string, flagName: string): number {
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    throw new Error(`${flagName} must be a positive integer number of milliseconds`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer number of milliseconds`);
  }
  return parsed;
}

async function connectMongoForAudit(uri: string, dbName: string): Promise<MongoAuditConnection> {
  const client = new MongoClient(uri, { appName: 'claude-memory-layer', serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
  return { collection: client.db(dbName).collection('cml_events'), close: () => client.close() };
}

function summarizeAudit(report: MongoSyncAuditReport): string {
  if (report.status === 'pass') return `all ${report.mongoTotal} Mongo documents are in the local store`;
  const parts: string[] = [];
  if (report.lostBelowPullCursor > 0) parts.push(`${report.lostBelowPullCursor} below the pull cursor that no pull will read`);
  if (report.notYetPulled > 0) parts.push(`${report.notYetPulled} not pulled yet`);
  if (report.localOnly > 0) parts.push(`${report.localOnly} local events not in Mongo (${report.pendingPush} pending push)`);
  return parts.join('; ');
}

/**
 * Read-only: opens the local store read-only and sends Mongo only counts and grouped aggregations. Without a Mongo
 * configuration or a local store there is nothing to compare, so the audit reports skip instead of failing.
 */
export async function runMongoSyncAudit(
  options: RawMongoSyncTargetOptions,
  deps: MongoSyncAuditDeps = {}
): Promise<MongoSyncAuditOutcome> {
  const target = resolveMongoSyncTarget(options, deps.env ?? process.env, deps.cwd ?? process.cwd());
  const { projectKey, uri, dbName } = target;
  if (!uri || !dbName) {
    return {
      status: 'skip',
      projectKey,
      detail: 'Mongo sync is not configured (--mongo-uri/--mongo-db or CLAUDE_MEMORY_MONGO_URI/CLAUDE_MEMORY_MONGO_DB)'
    };
  }

  const getProjectStoragePath = deps.getProjectStoragePath ?? defaultGetProjectStoragePath;
  const dbPath = path.join(getProjectStoragePath(target.projectPath), 'events.sqlite');
  if (!fs.existsSync(dbPath)) {
    return { status: 'skip', projectKey, detail: `no local store at ${dbPath}` };
  }

  const store = new SQLiteEventStore(dbPath, { readonly: true });
  let connection: MongoAuditConnection | undefined;
  try {
    connection = await (deps.connect ?? connectMongoForAudit)(uri, dbName);
    const report = await auditMongoSync(store, connection.collection, { projectKey });
    return { status: report.status, projectKey, detail: summarizeAudit(report), report };
  } catch (error) {
    const safeUri = redactMongoUri(uri);
    const message = (error instanceof Error ? error.message : String(error)).split(uri).join(safeUri);
    return { status: 'fail', projectKey, detail: `Mongo audit failed (${safeUri}, db=${dbName}): ${message}` };
  } finally {
    await connection?.close().catch(() => undefined);
    await store.close();
  }
}

export function mongoSyncAuditExitCode(outcome: MongoSyncAuditOutcome): number {
  return outcome.status === 'fail' ? 1 : 0;
}

function formatInstance(instanceId: string | null, hostname: string | null): string {
  return `${instanceId ?? '(no instanceId)'} (${hostname ?? 'unknown host'})`;
}

export function formatMongoSyncAuditOutcome(outcome: MongoSyncAuditOutcome, json: boolean): string {
  if (json) return JSON.stringify(outcome, null, 2);

  const icon = { pass: '✅', warn: '⚠️ ', fail: '❌', skip: '⏭️ ' }[outcome.status];
  const lines = ['', `Mongo sync audit (project=${outcome.projectKey})`, '', `  ${icon} ${outcome.status}: ${outcome.detail}`];
  const report = outcome.report;
  if (!report) return [...lines, ''].join('\n');

  lines.push(
    `  Mongo documents: ${report.mongoTotal}  local events: ${report.localTotal}  missing locally: ${report.missing}`,
    `  Cursors: push rowid=${report.pushCursor}  pull seq=${report.pullCursor}`
      + (report.pullWindowStart ? `  (next pull re-reads inserts since ${report.pullWindowStart.toISOString()})` : '')
  );

  const gaps = report.instances.filter((instance) => instance.missing > 0);
  if (gaps.length > 0) {
    lines.push('', `  Instances with missing documents (${gaps.length} of ${report.instances.length}):`);
    for (const instance of gaps.slice(0, MAX_LISTED_INSTANCES)) {
      lines.push(`    ${formatInstance(instance.instanceId, instance.hostname)}  mongo=${instance.mongo} local=${instance.local}`
        + ` missing=${instance.missing}  seq ${instance.firstSeq}-${instance.lastSeq}`);
    }
    if (gaps.length > MAX_LISTED_INSTANCES) lines.push(`    ... and ${gaps.length - MAX_LISTED_INSTANCES} more (--json lists all)`);
  }

  const gap = report.oldestGap;
  if (gap) {
    lines.push(
      '',
      `  Oldest gap below the pull cursor: seq ${gap.fromSeq}-${gap.toSeq}, ${gap.count} document(s),`
        + ` inserted ${new Date(gap.firstInsertedAt).toISOString()} .. ${new Date(gap.lastInsertedAt).toISOString()}`,
      ...gap.instances.map((instance) => `    from ${formatInstance(instance.instanceId, instance.hostname)}: ${instance.count}`)
    );
  }

  const fixes: string[] = [];
  if (report.notYetPulled > 0) fixes.push('claude-memory-layer mongo-sync --direction pull');
  if (report.pendingPush > 0) fixes.push('claude-memory-layer mongo-sync --direction push');
  if (fixes.length > 0) lines.push('', `  Fix: ${fixes.join('  /  ')}`);
  if (report.lostBelowPullCursor > 0) {
    lines.push(`  No repair command for documents below the pull cursor yet; root fix: ${ORIGIN_CURSOR_ISSUE_URL}`);
  }
  return [...lines, ''].join('\n');
}
