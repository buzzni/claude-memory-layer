import * as path from 'node:path';

import type { OutboxRecoveryResult, OutboxStats } from '../../core/types.js';
import { getProjectStoragePath as defaultGetProjectStoragePath } from '../../core/registry/project-path.js';

export interface RawProcessCommandOptions {
  project?: string;
  recoverStuck?: boolean;
  dryRunRecovery?: boolean;
  lockPath?: string;
}

export interface ProcessCommandOptions {
  projectPath: string;
  recoverStuck: boolean;
  dryRunRecovery: boolean;
  lockPath: string;
}

export interface ProcessCommandDeps {
  getProjectStoragePath?: (projectPath: string) => string;
}

export interface ProcessRecoveryPreviewInput {
  projectPath: string;
  stats: OutboxStats;
  recovery: OutboxRecoveryResult;
}

export interface ProcessLockBusyInput {
  projectPath: string;
  lockPath: string;
  holderPid: number | null;
}

export function resolveProcessCommandOptions(
  options: RawProcessCommandOptions,
  cwd: string = process.cwd(),
  deps: ProcessCommandDeps = {}
): ProcessCommandOptions {
  const explicitProject = options.project;
  if (explicitProject !== undefined && explicitProject.trim().length === 0) {
    throw new Error('--project must not be empty');
  }

  const explicitLockPath = options.lockPath;
  if (explicitLockPath !== undefined && explicitLockPath.trim().length === 0) {
    throw new Error('--lock-path must not be empty');
  }

  const projectPath = explicitProject ?? cwd;
  const dryRunRecovery = options.dryRunRecovery === true;
  const recoverStuck = options.recoverStuck !== false;
  if (dryRunRecovery && !recoverStuck) {
    throw new Error('--dry-run-recovery cannot be combined with --no-recover-stuck');
  }

  const getProjectStoragePath = deps.getProjectStoragePath ?? defaultGetProjectStoragePath;
  return {
    projectPath,
    recoverStuck,
    dryRunRecovery,
    lockPath: explicitLockPath ?? path.join(getProjectStoragePath(projectPath), 'vector-worker.lock')
  };
}

export function formatProcessLockBusy(input: ProcessLockBusyInput): string {
  const holder = input.holderPid === null ? 'unknown' : String(input.holderPid);
  return [
    'Another vector worker is already running; skipping process command.',
    `Project: ${input.projectPath}`,
    `holderPid=${holder}`,
    `lockPath=${input.lockPath}`,
    'No outbox rows were recovered or processed.'
  ].join('\n');
}

export function formatProcessRecoveryPreview(input: ProcessRecoveryPreviewInput): string {
  const embeddingRecovered = input.recovery.embedding.recoveredProcessing;
  const vectorRecovered = input.recovery.vector.recoveredProcessing;
  const recoveredTotal = embeddingRecovered + vectorRecovered;
  const embeddingRetried = input.recovery.embedding.retriedFailed;
  const vectorRetried = input.recovery.vector.retriedFailed;
  const retriedTotal = embeddingRetried + vectorRetried;
  const oldestProcessingAge = maxNullable(
    input.stats.embedding.oldestProcessingAgeMs,
    input.stats.vector.oldestProcessingAgeMs
  );

  return [
    'Vector outbox recovery preview',
    'Mode: dry-run',
    `Current processing: embedding=${input.stats.embedding.processing}, vector=${input.stats.vector.processing}, total=${input.stats.embedding.processing + input.stats.vector.processing}`,
    `Current stuck processing: embedding=${input.stats.embedding.stuckProcessing}, vector=${input.stats.vector.stuckProcessing}, total=${input.stats.embedding.stuckProcessing + input.stats.vector.stuckProcessing}`,
    `Would recover stuck processing: embedding=${embeddingRecovered}, vector=${vectorRecovered}, total=${recoveredTotal}`,
    `Would retry failed: embedding=${embeddingRetried}, vector=${vectorRetried}, total=${retriedTotal}`,
    `Oldest processing age: ${formatDuration(oldestProcessingAge)}`,
    `Next command: claude-memory-layer process --project ${quoteCliArg(input.projectPath)}`
  ].join('\n');
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
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

function quoteCliArg(value: string): string {
  if (/^[A-Za-z0-9_/@%+=:.,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
