import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const RUNTIME_RESOURCE_TELEMETRY_SCHEMA_VERSION = 1;
export const LEGACY_RUNTIME_VERSION = 'legacy-or-uninstrumented';

export type RuntimeClientKind = 'mcp' | 'semantic-daemon' | 'cli' | 'dashboard' | 'unknown';
export type RuntimeModelReleaseReason =
  | 'idle-timeout'
  | 'daemon-idle-shutdown'
  | 'process-shutdown'
  | 'manual'
  | 'unknown';

export interface RuntimeLatencyAggregate {
  count: number;
  failedCount: number;
  totalMs: number;
  maxMs: number;
}

export interface RuntimeResourceSnapshot {
  schemaVersion: 1;
  pid: number;
  ppid: number;
  version: string;
  client: RuntimeClientKind;
  processState: 'running' | 'stopped';
  startedAt: string;
  updatedAt: string;
  stoppedAt: string | null;
  model: {
    loaded: boolean;
    loadedInstances: number;
    backendId: string | null;
    loadCount: number;
    loadFailureCount: number;
    totalLoadDurationMs: number;
    lastLoadDurationMs: number | null;
    lastLoadedAt: string | null;
    releaseCount: number;
    releaseFailureCount: number;
    lastReleasedAt: string | null;
    lastReleaseReason: RuntimeModelReleaseReason | null;
    lastActivityAt: string | null;
    useCount: number;
  };
  retrieval: {
    cold: RuntimeLatencyAggregate;
    hot: RuntimeLatencyAggregate;
  };
}

export interface RuntimeResourceTelemetryOptions {
  now?: () => number;
  pid?: number;
  ppid?: number;
  version?: string;
  telemetryDir?: string;
  persist?: boolean;
}

export interface RuntimeRetrievalTelemetry {
  isModelLoaded(): boolean;
  now(): number;
  recordRetrieval(tier: 'cold' | 'hot', durationMs: number, succeeded: boolean): void;
}

const RUNTIME_CLIENT_KINDS = new Set<RuntimeClientKind>([
  'mcp',
  'semantic-daemon',
  'cli',
  'dashboard',
  'unknown'
]);
const SAFE_RUNTIME_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

function emptyLatencyAggregate(): RuntimeLatencyAggregate {
  return { count: 0, failedCount: 0, totalMs: 0, maxMs: 0 };
}

function runtimeVersion(): string {
  const value = process.env.CLAUDE_MEMORY_LAYER_VERSION?.trim();
  return sanitizeRuntimeVersion(value || 'development');
}

function sanitizeRuntimeVersion(value: string): string {
  return SAFE_RUNTIME_VERSION.test(value) ? value : 'unknown';
}

export function defaultRuntimeTelemetryDir(): string {
  const configured = process.env.CLAUDE_MEMORY_RUNTIME_TELEMETRY_DIR?.trim();
  return configured || path.join(os.homedir(), '.claude-code', 'memory', 'runtime-resources');
}

export function opaqueBackendId(modelName: string): string {
  return `sha256:${createHash('sha256').update(modelName).digest('hex').slice(0, 12)}`;
}

export class RuntimeResourceTelemetry implements RuntimeRetrievalTelemetry {
  private readonly nowFn: () => number;
  private readonly telemetryDir: string;
  private readonly persistEnabled: boolean;
  private readonly loadedResources = new Set<string>();
  private registered = false;
  private snapshot: RuntimeResourceSnapshot;

  constructor(options: RuntimeResourceTelemetryOptions = {}) {
    this.nowFn = options.now ?? Date.now;
    this.telemetryDir = options.telemetryDir ?? defaultRuntimeTelemetryDir();
    const telemetryDisabled = ['1', 'true', 'yes'].includes(
      String(process.env.CLAUDE_MEMORY_DISABLE_RUNTIME_TELEMETRY || '').toLowerCase()
    );
    this.persistEnabled = options.persist ?? !telemetryDisabled;
    const now = this.isoNow();
    this.snapshot = {
      schemaVersion: RUNTIME_RESOURCE_TELEMETRY_SCHEMA_VERSION,
      pid: options.pid ?? process.pid,
      ppid: options.ppid ?? process.ppid,
      version: sanitizeRuntimeVersion(options.version ?? runtimeVersion()),
      client: 'unknown',
      processState: 'running',
      startedAt: now,
      updatedAt: now,
      stoppedAt: null,
      model: {
        loaded: false,
        loadedInstances: 0,
        backendId: null,
        loadCount: 0,
        loadFailureCount: 0,
        totalLoadDurationMs: 0,
        lastLoadDurationMs: null,
        lastLoadedAt: null,
        releaseCount: 0,
        releaseFailureCount: 0,
        lastReleasedAt: null,
        lastReleaseReason: null,
        lastActivityAt: null,
        useCount: 0
      },
      retrieval: {
        cold: emptyLatencyAggregate(),
        hot: emptyLatencyAggregate()
      }
    };
  }

  now(): number {
    return this.nowFn();
  }

  registerProcess(client: RuntimeClientKind): void {
    this.registered = true;
    this.snapshot.client = client;
    this.snapshot.processState = 'running';
    this.snapshot.stoppedAt = null;
    this.touchAndPersist();
  }

  markProcessStopped(): void {
    this.snapshot.processState = 'stopped';
    this.snapshot.stoppedAt = this.isoNow();
    this.touchAndPersist();
  }

  recordModelLoad(resourceId: string, backendId: string, durationMs: number): void {
    this.loadedResources.add(resourceId);
    const model = this.snapshot.model;
    model.loaded = true;
    model.loadedInstances = this.loadedResources.size;
    model.backendId = backendId;
    model.loadCount += 1;
    model.totalLoadDurationMs += boundedDuration(durationMs);
    model.lastLoadDurationMs = boundedDuration(durationMs);
    model.lastLoadedAt = this.isoNow();
    model.lastActivityAt = model.lastLoadedAt;
    this.touchAndPersist();
  }

  recordModelLoadFailure(durationMs: number): void {
    const model = this.snapshot.model;
    model.loadFailureCount += 1;
    model.lastLoadDurationMs = boundedDuration(durationMs);
    model.lastActivityAt = this.isoNow();
    this.touchAndPersist();
  }

  recordModelActivity(): void {
    this.snapshot.model.useCount += 1;
    this.snapshot.model.lastActivityAt = this.isoNow();
    this.touchAndPersist();
  }

  recordModelRelease(resourceId: string, reason: RuntimeModelReleaseReason): void {
    this.loadedResources.delete(resourceId);
    const model = this.snapshot.model;
    model.loadedInstances = this.loadedResources.size;
    model.loaded = model.loadedInstances > 0;
    model.releaseCount += 1;
    model.lastReleasedAt = this.isoNow();
    model.lastReleaseReason = reason;
    model.lastActivityAt = model.lastReleasedAt;
    this.touchAndPersist();
  }

  recordModelReleaseFailure(): void {
    this.snapshot.model.releaseFailureCount += 1;
    this.snapshot.model.lastActivityAt = this.isoNow();
    this.touchAndPersist();
  }

  isModelLoaded(): boolean {
    return this.snapshot.model.loaded;
  }

  recordRetrieval(tier: 'cold' | 'hot', durationMs: number, succeeded: boolean): void {
    const aggregate = this.snapshot.retrieval[tier];
    const duration = boundedDuration(durationMs);
    aggregate.count += 1;
    aggregate.totalMs += duration;
    aggregate.maxMs = Math.max(aggregate.maxMs, duration);
    if (!succeeded) aggregate.failedCount += 1;
    this.snapshot.model.lastActivityAt = this.isoNow();
    this.touchAndPersist();
  }

  getSnapshot(): RuntimeResourceSnapshot {
    return structuredClone(this.snapshot);
  }

  private isoNow(): string {
    return new Date(this.nowFn()).toISOString();
  }

  private touchAndPersist(): void {
    this.snapshot.updatedAt = this.isoNow();
    if (!this.registered || !this.persistEnabled) return;
    try {
      mkdirSync(this.telemetryDir, { recursive: true, mode: 0o700 });
      const target = path.join(this.telemetryDir, `process-${this.snapshot.pid}.json`);
      const temporary = `${target}.tmp-${process.pid}`;
      writeFileSync(temporary, `${JSON.stringify(this.snapshot)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, target);
    } catch {
      // Runtime telemetry must never make retrieval or shutdown fail.
    }
  }
}

let processTelemetry = new RuntimeResourceTelemetry();

export function getRuntimeResourceTelemetry(): RuntimeResourceTelemetry {
  return processTelemetry;
}

export function setRuntimeResourceTelemetryForTests(telemetry: RuntimeResourceTelemetry): void {
  processTelemetry = telemetry;
}

export function registerRuntimeProcess(client: RuntimeClientKind): void {
  processTelemetry.registerProcess(client);
}

export function markRuntimeProcessStopped(): void {
  processTelemetry.markProcessStopped();
}

function boundedDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round(value * 1000) / 1000;
}

interface ProcessRow {
  pid: number;
  ppid: number;
  rssKiB: number;
  command: string;
}

export interface RuntimeResourceGroup {
  version: string;
  client: RuntimeClientKind;
  processCount: number;
  rssMiB: number;
  orphanCount: number;
  modelLoadedCount: number;
  modelUnloadedCount: number;
  modelStateUnavailableCount: number;
  modelLoadCount: number;
  modelReleaseCount: number;
  coldRetrievalCount: number;
  coldRetrievalAverageMs: number | null;
  hotRetrievalCount: number;
  hotRetrievalAverageMs: number | null;
}

export interface RuntimeResourceReport {
  generatedAt: string;
  processLocal: Omit<RuntimeResourceSnapshot, 'pid' | 'ppid'>;
  observation: {
    supported: boolean;
    platform: NodeJS.Platform;
    reason?: 'unsupported-platform' | 'process-metrics-unavailable';
    processCount: number | null;
    rssMiB: number | null;
    groups: RuntimeResourceGroup[];
  };
}

export interface CollectRuntimeResourceReportOptions {
  platform?: NodeJS.Platform;
  telemetryDir?: string;
  now?: () => number;
  readProcessTable?: () => string;
  localSnapshot?: RuntimeResourceSnapshot;
}

export function collectRuntimeResourceReport(
  options: CollectRuntimeResourceReportOptions = {}
): RuntimeResourceReport {
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const localSnapshot = options.localSnapshot ?? processTelemetry.getSnapshot();
  const processLocal = stripProcessIdentity(localSnapshot);

  if (platform !== 'darwin' && platform !== 'linux') {
    return {
      generatedAt: new Date(now()).toISOString(),
      processLocal,
      observation: {
        supported: false,
        platform,
        reason: 'unsupported-platform',
        processCount: null,
        rssMiB: null,
        groups: []
      }
    };
  }

  let rows: ProcessRow[];
  try {
    const raw = options.readProcessTable
      ? options.readProcessTable()
      : execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], {
          encoding: 'utf8',
          timeout: 5_000,
          maxBuffer: 8 * 1024 * 1024
        });
    rows = parseProcessTable(raw);
  } catch {
    return {
      generatedAt: new Date(now()).toISOString(),
      processLocal,
      observation: {
        supported: false,
        platform,
        reason: 'process-metrics-unavailable',
        processCount: null,
        rssMiB: null,
        groups: []
      }
    };
  }

  const snapshots = readRuntimeResourceSnapshots(options.telemetryDir ?? defaultRuntimeTelemetryDir());
  const snapshotsByPid = new Map(
    snapshots
      .filter((snapshot) => snapshot.processState === 'running')
      .map((snapshot) => [snapshot.pid, snapshot])
  );
  // A snapshot alone is not proof that a PID still belongs to this product;
  // stale files plus PID reuse must not turn unrelated processes into samples.
  const candidates = rows.filter((row) => classifyRuntimeCommand(row.command) !== null);
  const groups = aggregateRuntimeResourceGroups(candidates, snapshotsByPid);

  return {
    generatedAt: new Date(now()).toISOString(),
    processLocal,
    observation: {
      supported: true,
      platform,
      processCount: candidates.length,
      rssMiB: roundMiB(candidates.reduce((sum, row) => sum + row.rssKiB, 0)),
      groups
    }
  };
}

export function readRuntimeResourceSnapshots(directory: string): RuntimeResourceSnapshot[] {
  if (!existsSync(directory)) return [];
  const snapshots: RuntimeResourceSnapshot[] = [];
  for (const entry of readdirSync(directory)) {
    if (!/^process-\d+\.json$/.test(entry)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path.join(directory, entry), 'utf8')) as RuntimeResourceSnapshot;
      if (isRuntimeResourceSnapshot(parsed)) snapshots.push(parsed);
    } catch {
      // Ignore partial, corrupt, or incompatible telemetry snapshots.
    }
  }
  return snapshots;
}

function isRuntimeResourceSnapshot(value: RuntimeResourceSnapshot): boolean {
  return value?.schemaVersion === RUNTIME_RESOURCE_TELEMETRY_SCHEMA_VERSION
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
    && SAFE_RUNTIME_VERSION.test(value.version)
    && RUNTIME_CLIENT_KINDS.has(value.client)
    && typeof value.model?.loaded === 'boolean';
}

function parseProcessTable(raw: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of raw.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKiB: Number(match[3]),
      command: match[4]
    });
  }
  return rows;
}

function classifyRuntimeCommand(command: string): RuntimeClientKind | null {
  if (/(?:^|[\\/])semantic-daemon\.(?:js|ts)(?:\s|$)/.test(command)) return 'semantic-daemon';
  if (/claude-memory-layer-mcp|(?:^|[\\/])(?:dist|src)[\\/](?:extensions[\\/])?mcp[\\/]index\.(?:js|ts)(?:\s|$)/.test(command)) {
    return 'mcp';
  }
  return null;
}

function aggregateRuntimeResourceGroups(
  rows: ProcessRow[],
  snapshotsByPid: Map<number, RuntimeResourceSnapshot>
): RuntimeResourceGroup[] {
  const groups = new Map<string, RuntimeResourceGroup & { coldTotalMs: number; hotTotalMs: number }>();

  for (const row of rows) {
    const snapshot = snapshotsByPid.get(row.pid);
    const client = snapshot?.client ?? classifyRuntimeCommand(row.command) ?? 'unknown';
    const version = snapshot?.version || LEGACY_RUNTIME_VERSION;
    const key = `${version}\u0000${client}`;
    const group = groups.get(key) ?? {
      version,
      client,
      processCount: 0,
      rssMiB: 0,
      orphanCount: 0,
      modelLoadedCount: 0,
      modelUnloadedCount: 0,
      modelStateUnavailableCount: 0,
      modelLoadCount: 0,
      modelReleaseCount: 0,
      coldRetrievalCount: 0,
      coldRetrievalAverageMs: null,
      hotRetrievalCount: 0,
      hotRetrievalAverageMs: null,
      coldTotalMs: 0,
      hotTotalMs: 0
    };
    group.processCount += 1;
    group.rssMiB += row.rssKiB / 1024;
    // The semantic daemon is intentionally detached, so PPID 1 is expected for
    // that client. MCP stdio servers, in contrast, should retain a live parent.
    if (row.ppid === 1 && client === 'mcp') group.orphanCount += 1;
    if (snapshot) {
      if (snapshot.model.loaded) group.modelLoadedCount += 1;
      else group.modelUnloadedCount += 1;
      group.modelLoadCount += snapshot.model.loadCount;
      group.modelReleaseCount += snapshot.model.releaseCount;
      group.coldRetrievalCount += snapshot.retrieval.cold.count;
      group.coldTotalMs += snapshot.retrieval.cold.totalMs;
      group.hotRetrievalCount += snapshot.retrieval.hot.count;
      group.hotTotalMs += snapshot.retrieval.hot.totalMs;
    } else {
      group.modelStateUnavailableCount += 1;
    }
    groups.set(key, group);
  }

  return Array.from(groups.values())
    .map(({ coldTotalMs, hotTotalMs, ...group }) => ({
      ...group,
      rssMiB: Math.round(group.rssMiB * 10) / 10,
      coldRetrievalAverageMs: average(coldTotalMs, group.coldRetrievalCount),
      hotRetrievalAverageMs: average(hotTotalMs, group.hotRetrievalCount)
    }))
    .sort((a, b) => a.version.localeCompare(b.version) || a.client.localeCompare(b.client));
}

function average(total: number, count: number): number | null {
  return count === 0 ? null : Math.round((total / count) * 1000) / 1000;
}

function roundMiB(rssKiB: number): number {
  return Math.round((rssKiB / 1024) * 10) / 10;
}

function stripProcessIdentity(
  snapshot: RuntimeResourceSnapshot
): Omit<RuntimeResourceSnapshot, 'pid' | 'ppid'> {
  const { pid: _pid, ppid: _ppid, ...safe } = snapshot;
  return safe;
}
