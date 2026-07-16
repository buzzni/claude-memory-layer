import type { OutboxQueueStats, OutboxStats } from './types.js';
import type { MemoryStats } from './engine/memory-query-service.js';
import type { DerivationLiveness } from './sqlite-event-store.js';

export const PRODUCTIVITY_HEALTH_SCHEMA_VERSION = 'agent-productivity-health-v1' as const;

export const PRODUCTIVITY_HEALTH_PROFILES = ['coder', 'reviewer', 'pm', 'support', 'researcher', 'team'] as const;
export type ProductivityHealthProfile = typeof PRODUCTIVITY_HEALTH_PROFILES[number];

export const PRODUCTIVITY_HEALTH_MODES = ['observe', 'preview', 'enforce'] as const;
export type ProductivityHealthMode = typeof PRODUCTIVITY_HEALTH_MODES[number];

export type ProductivityHealthStatus = 'ok' | 'needs-attention';
export type ProductivityHealthRiskGateStatus = 'pass' | 'warn';
export type ProductivityHealthRiskGateSeverity = 'blocker' | 'warning';

export interface ProductivityHealthProjectIdentity {
  scope: 'project' | 'global';
  id: string;
}

export interface ProductivityHealthReportInput {
  stats: Pick<MemoryStats, 'totalEvents' | 'vectorCount' | 'levelStats'>;
  outbox: OutboxStats;
  derivation?: DerivationLiveness;
  project: ProductivityHealthProjectIdentity;
  profile?: ProductivityHealthProfile;
  mode?: ProductivityHealthMode;
  generatedAt?: Date;
}

export interface ProductivityHealthRiskGate {
  id: 'project-scope-known' | 'outbox-healthy' | 'memory-density' | 'derivation-liveness' | 'derived-sources-ready';
  severity: ProductivityHealthRiskGateSeverity;
  status: ProductivityHealthRiskGateStatus;
  message?: string;
}

export interface ProductivityHealthReport {
  schemaVersion: typeof PRODUCTIVITY_HEALTH_SCHEMA_VERSION;
  generatedAt: string;
  status: ProductivityHealthStatus;
  profile: ProductivityHealthProfile;
  mode: ProductivityHealthMode;
  project: ProductivityHealthProjectIdentity;
  summary: {
    warningReasons: string[];
  };
  signals: {
    storage: {
      totalEvents: number;
      vectorCount: number;
      levelStats: Array<{ level: string; count: number }>;
    };
    outbox: {
      embedding: OutboxQueueStats;
      vector: OutboxQueueStats;
      totals: OutboxQueueStats;
    };
    derivation: DerivationLiveness;
  };
  riskGates: ProductivityHealthRiskGate[];
  nextBestAction: string;
}

export function parseProductivityHealthProfile(value: unknown): ProductivityHealthProfile {
  const normalized = typeof value === 'string' && value.trim().length > 0 ? value.trim() : 'coder';
  if ((PRODUCTIVITY_HEALTH_PROFILES as readonly string[]).includes(normalized)) {
    return normalized as ProductivityHealthProfile;
  }
  throw new Error(`Invalid --profile: expected one of ${PRODUCTIVITY_HEALTH_PROFILES.join(', ')}`);
}

export function parseProductivityHealthMode(value: unknown): ProductivityHealthMode {
  const normalized = typeof value === 'string' && value.trim().length > 0 ? value.trim() : 'preview';
  if ((PRODUCTIVITY_HEALTH_MODES as readonly string[]).includes(normalized)) {
    return normalized as ProductivityHealthMode;
  }
  throw new Error(`Invalid --mode: expected one of ${PRODUCTIVITY_HEALTH_MODES.join(', ')}`);
}

export function buildProductivityHealthReport(input: ProductivityHealthReportInput): ProductivityHealthReport {
  const profile = input.profile ?? 'coder';
  const mode = input.mode ?? 'preview';
  const embedding = normalizeQueue(input.outbox.embedding);
  const vector = normalizeQueue(input.outbox.vector);
  const totals = sumQueues(embedding, vector);
  const storage = {
    totalEvents: numberOrZero(input.stats.totalEvents),
    vectorCount: numberOrZero(input.stats.vectorCount),
    levelStats: normalizeLevelStats(input.stats.levelStats)
  };

  const warningReasons: string[] = [];
  const projectGate = buildProjectScopeGate(input.project);
  const outboxGate = buildOutboxGate(totals);
  const densityGate = buildMemoryDensityGate(storage.totalEvents);
  const derivation = normalizeDerivationLiveness(input.derivation);
  const derivationGate = buildDerivationLivenessGate(storage.totalEvents, derivation);
  const sourcesGate = buildDerivedSourcesGate(storage.totalEvents, derivation);
  const riskGates = [projectGate, outboxGate, densityGate, derivationGate, sourcesGate];

  if (projectGate.status === 'warn') warningReasons.push('project_scope_unknown');
  if (outboxGate.status === 'warn') warningReasons.push('outbox_requires_attention');
  if (densityGate.status === 'warn') warningReasons.push('memory_density_low');
  if (derivationGate.status === 'warn') warningReasons.push('pipeline_never_run');
  if (sourcesGate.status === 'warn') warningReasons.push('no_derived_sources');

  const status: ProductivityHealthStatus = riskGates.some((gate) => gate.status === 'warn')
    ? 'needs-attention'
    : 'ok';

  return {
    schemaVersion: PRODUCTIVITY_HEALTH_SCHEMA_VERSION,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    status,
    profile,
    mode,
    project: input.project,
    summary: { warningReasons },
    signals: {
      storage,
      outbox: { embedding, vector, totals },
      derivation
    },
    riskGates,
    nextBestAction: selectNextBestAction({ projectGate, outboxGate, densityGate, derivationGate, sourcesGate })
  };
}

function normalizeDerivationLiveness(value: DerivationLiveness | undefined): DerivationLiveness {
  const graduation = value?.graduation;
  const status = graduation?.lastStatus === 'success' || graduation?.lastStatus === 'not_eligible' || graduation?.lastStatus === 'failed'
    ? graduation.lastStatus
    : null;
  return {
    graduation: {
      attempts: numberOrZero(graduation?.attempts),
      lastAttemptAt: safeIsoTimestamp(graduation?.lastAttemptAt),
      lastSuccessAt: safeIsoTimestamp(graduation?.lastSuccessAt),
      lastStatus: status,
      lastErrorCategory: status === 'failed' && graduation?.lastErrorCategory === 'graduation_failed'
        ? 'graduation_failed'
        : null
    },
    sources: {
      graduatedEvents: numberOrZero(value?.sources?.graduatedEvents),
      curatedLessons: numberOrZero(value?.sources?.curatedLessons)
    }
  };
}

function buildProjectScopeGate(project: ProductivityHealthProjectIdentity): ProductivityHealthRiskGate {
  if (project.scope === 'project') {
    return { id: 'project-scope-known', severity: 'blocker', status: 'pass' };
  }
  return {
    id: 'project-scope-known',
    severity: 'blocker',
    status: 'warn',
    message: 'No project parameter supplied; report uses global memory scope.'
  };
}

function buildOutboxGate(totals: OutboxQueueStats): ProductivityHealthRiskGate {
  if (totals.failed > 0 || totals.stuckProcessing > 0) {
    return {
      id: 'outbox-healthy',
      severity: 'warning',
      status: 'warn',
      message: 'Outbox has failed or stuck processing items; run recovery before trusting retrieval freshness.'
    };
  }
  return { id: 'outbox-healthy', severity: 'warning', status: 'pass' };
}

function buildMemoryDensityGate(totalEvents: number): ProductivityHealthRiskGate {
  if (totalEvents <= 0) {
    return {
      id: 'memory-density',
      severity: 'warning',
      status: 'warn',
      message: 'No memories are available for this scope yet.'
    };
  }
  return { id: 'memory-density', severity: 'warning', status: 'pass' };
}

function buildDerivationLivenessGate(totalEvents: number, derivation: DerivationLiveness): ProductivityHealthRiskGate {
  if (totalEvents > 0 && derivation.graduation.attempts === 0) {
    return {
      id: 'derivation-liveness',
      severity: 'blocker',
      status: 'warn',
      message: 'Memories exist but graduation has never run; execute claude-memory-layer process.'
    };
  }
  return { id: 'derivation-liveness', severity: 'blocker', status: 'pass' };
}

function buildDerivedSourcesGate(totalEvents: number, derivation: DerivationLiveness): ProductivityHealthRiskGate {
  if (totalEvents > 0 && derivation.sources.graduatedEvents === 0 && derivation.sources.curatedLessons === 0) {
    return {
      id: 'derived-sources-ready',
      severity: 'blocker',
      status: 'warn',
      message: 'No graduated memories or curated lessons are available for a Project Brief.'
    };
  }
  return { id: 'derived-sources-ready', severity: 'blocker', status: 'pass' };
}

function selectNextBestAction(input: {
  projectGate: ProductivityHealthRiskGate;
  outboxGate: ProductivityHealthRiskGate;
  densityGate: ProductivityHealthRiskGate;
  derivationGate: ProductivityHealthRiskGate;
  sourcesGate: ProductivityHealthRiskGate;
}): string {
  if (input.outboxGate.status === 'warn') {
    return 'Run claude-memory-layer process --dry-run-recovery, then process pending embeddings.';
  }
  if (input.densityGate.status === 'warn') {
    return 'Import or capture project context before relying on productivity memory guidance.';
  }
  if (input.derivationGate.status === 'warn') {
    return 'Run claude-memory-layer process to execute one bounded graduation pass.';
  }
  if (input.sourcesGate.status === 'warn') {
    return 'Capture a reviewed lesson or promote eligible memories before generating a Project Brief.';
  }
  if (input.projectGate.status === 'warn') {
    return 'Provide a project path or project hash before relying on project-scoped productivity guidance.';
  }
  return 'No immediate maintenance action required.';
}

function normalizeLevelStats(levelStats: Array<{ level: string; count: number }> | undefined): Array<{ level: string; count: number }> {
  if (!Array.isArray(levelStats)) return [];
  return levelStats
    .filter((entry) => typeof entry.level === 'string' && entry.level.trim().length > 0)
    .map((entry) => ({ level: entry.level.trim().slice(0, 20), count: numberOrZero(entry.count) }));
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
    oldestProcessingAgeMs: normalizeNullableAge(queue.oldestProcessingAgeMs)
  };
}

function sumQueues(a: OutboxQueueStats, b: OutboxQueueStats): OutboxQueueStats {
  return {
    pending: a.pending + b.pending,
    processing: a.processing + b.processing,
    failed: a.failed + b.failed,
    retryableFailed: (a.retryableFailed ?? 0) + (b.retryableFailed ?? 0),
    quarantinedFailed: (a.quarantinedFailed ?? 0) + (b.quarantinedFailed ?? 0),
    total: a.total + b.total,
    stuckProcessing: a.stuckProcessing + b.stuckProcessing,
    oldestProcessingAgeMs: maxNullable(a.oldestProcessingAgeMs, b.oldestProcessingAgeMs)
  };
}

function normalizeNullableAge(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function safeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function numberOrZero(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}
