/**
 * Stats API
 * Endpoints for storage statistics
 */

import { Hono } from 'hono';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getLightweightServiceFromQuery, getServiceFromQuery, jsonError } from './utils.js';
import { hashProjectPath } from '../../../core/registry/project-path.js';
import { sanitizeGovernanceAuditValue } from '../../../core/operations/governance-audit.js';
import {
  createSQLiteDatabase,
  sqliteAll,
  sqliteGet,
  type SQLiteDatabase
} from '../../../core/sqlite-wrapper.js';
import type { MemoryEvent } from '../../../core/types.js';

export const statsRouter = new Hono();

const OPERATION_STATS_TABLES = [
  'memory_facets',
  'memory_actions',
  'memory_leases',
  'memory_retention_scores',
  'memory_governance_audit',
  'memory_lessons'
] as const;

const PERSPECTIVE_STATS_TABLES = [
  'memory_actors',
  'session_actors',
  'actor_cards',
  'perspective_observations'
] as const;

const LESSON_CONFIDENCE_BUCKETS = [
  { bucket: '0.00-0.25', min: 0, max: 0.25 },
  { bucket: '0.25-0.50', min: 0.25, max: 0.5 },
  { bucket: '0.50-0.75', min: 0.5, max: 0.75 },
  { bucket: '0.75-1.00', min: 0.75, max: 1.0000001 }
] as const;

type OperationsStatsContext = {
  projectHash?: string;
  storagePath: string;
  dbPath: string;
};

type CountByLabelRow = {
  label: string;
  count: number;
};

type FacetCountRow = {
  dimension: string;
  value: string;
  count: number;
};

type AuditOperationRow = {
  date: string;
  operation: string;
  count: number;
};

type LessonConfidenceRow = {
  confidence: number;
};

type ActorCardAggregateRow = {
  total: number;
  totalEntries: number;
  fullCards: number;
};

type SessionActorAggregateRow = {
  total: number;
  observeSelfEnabled: number;
  observeOthersEnabled: number;
};

type PerspectiveActivityRow = {
  date: string;
  level: string;
  count: number;
};

type PerspectiveContradictionRow = {
  observationId: string;
  observerActorId: string;
  observedActorId: string;
  confidence: number;
  sourceEventCount: number;
  sourceObservationCount: number;
  createdAt: string;
  updatedAt: string;
};

type PerspectiveGraphRow = {
  observerActorId: string;
  observedActorId: string;
  observationCount: number;
  averageConfidence: number;
  sourceEventCount: number;
  sourceObservationCount: number;
  latestUpdatedAt: string;
  actorCardCount: number;
};

type PerspectiveGraphLevelRow = {
  observerActorId: string;
  observedActorId: string;
  level: string;
  count: number;
};

type PerspectiveGraphEdgeKeyRow = {
  observerActorId: string;
  observedActorId: string;
  count: number;
};

type PerspectiveSourceEvidenceRow = {
  level: string;
  count: number;
  sourceEventCount: number;
  sourceObservationCount: number;
  observationsWithEventEvidence: number;
  observationsWithObservationEvidence: number;
  missingEvidenceCount: number;
};

function operationsStatsHomeDir(): string {
  return process.env.HOME || os.homedir();
}

function projectStoragePathForOperationsStats(projectOrHash: string): string {
  const projectHash = /^[a-f0-9]{8}$/.test(projectOrHash)
    ? projectOrHash
    : hashProjectPath(projectOrHash);
  return path.join(operationsStatsHomeDir(), '.claude-code', 'memory', 'projects', projectHash);
}

function getOperationsStatsContext(project: string | undefined): OperationsStatsContext {
  if (project && project.trim().length > 0) {
    const normalizedProject = project.trim();
    const projectHash = /^[a-f0-9]{8}$/.test(normalizedProject)
      ? normalizedProject
      : hashProjectPath(normalizedProject);
    const storagePath = projectStoragePathForOperationsStats(normalizedProject);
    return {
      projectHash,
      storagePath,
      dbPath: path.join(storagePath, 'events.sqlite')
    };
  }

  const storagePath = path.join(operationsStatsHomeDir(), '.claude-code', 'memory');
  return {
    storagePath,
    dbPath: path.join(storagePath, 'events.sqlite')
  };
}

function countRowValue(db: SQLiteDatabase, sql: string, params: unknown[] = []): number {
  const row = sqliteGet<{ count: number }>(db, sql, params);
  return Number(row?.count ?? 0);
}

function projectFilter(projectHash: string | undefined, column = 'project_hash'): { clause: string; params: unknown[] } {
  if (!projectHash) return { clause: '', params: [] };
  return { clause: `WHERE ${column} = ?`, params: [projectHash] };
}

function sanitizeAggregateLabel(value: unknown): string {
  const raw = typeof value === 'string' ? value : String(value ?? 'unknown');
  const sanitized = String(sanitizeGovernanceAuditValue(raw));
  if (sanitized !== raw || sanitized.includes('[REDACTED]')) return '[REDACTED]';
  const trimmed = sanitized.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 96) : 'unknown';
}

const SAFE_RETRIEVAL_TRACE_STRATEGIES = new Set([
  'auto',
  'deep',
  'fast',
  'hybrid',
  'keyword',
  'semantic',
  'mcp-context-pack',
  'session-start-hook',
  'unknown'
]);

function normalizeRetrievalTraceStrategy(value: unknown): string {
  const label = sanitizeAggregateLabel(value);
  if (label === '[REDACTED]') return 'unknown';
  const normalized = label.trim().toLowerCase();
  return SAFE_RETRIEVAL_TRACE_STRATEGIES.has(normalized) ? normalized : 'unknown';
}

function emptyOperationsStatsPayload(context: OperationsStatsContext, databaseExists: boolean, missingTables: readonly string[], windowDays: number) {
  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    projectHash: context.projectHash,
    projection: {
      databaseExists,
      available: databaseExists && missingTables.length === 0,
      missingTables
    },
    facets: { totalAssignments: 0, distribution: [] },
    actions: { total: 0, byStatus: [] },
    leases: { totalActive: 0, activeByTargetType: [] },
    retention: { total: 0, byDecision: [] },
    governanceAudit: { total: 0, operationsByDay: [] },
    lessons: {
      total: 0,
      confidenceBuckets: LESSON_CONFIDENCE_BUCKETS.map((bucket) => ({ bucket: bucket.bucket, count: 0 }))
    }
  };
}

function getMissingOperationTables(db: SQLiteDatabase): string[] {
  const placeholders = OPERATION_STATS_TABLES.map(() => '?').join(', ');
  const rows = sqliteAll<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
    [...OPERATION_STATS_TABLES]
  );
  const present = new Set(rows.map((row) => row.name));
  return OPERATION_STATS_TABLES.filter((table) => !present.has(table));
}

function emptyPerspectiveStatsPayload(context: OperationsStatsContext, databaseExists: boolean, missingTables: readonly string[], windowDays: number) {
  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    projectHash: context.projectHash,
    projection: {
      databaseExists,
      available: databaseExists && missingTables.length === 0,
      missingTables
    },
    actors: { total: 0, byKind: [] },
    sessionActors: {
      total: 0,
      observeSelfEnabled: 0,
      observeOthersEnabled: 0,
      byRole: []
    },
    actorCards: {
      total: 0,
      totalEntries: 0,
      averageEntries: 0,
      fullCards: 0
    },
    observations: {
      total: 0,
      byLevel: [],
      byCreatedBy: []
    },
    perspectiveGraph: {
      summary: { totalEdges: 0, returnedEdges: 0, totalObservations: 0, selfEdges: 0, crossActorEdges: 0 },
      edges: []
    },
    sourceEvidence: {
      summary: {
        totalObservations: 0,
        observationsWithEventEvidence: 0,
        observationsWithObservationEvidence: 0,
        observationsMissingEvidence: 0,
        totalSourceEvents: 0,
        totalSourceObservations: 0
      },
      byLevel: []
    },
    contradictions: {
      summary: { total: 0, returnedItems: 0 },
      items: []
    },
    recentActivity: { byDay: [] }
  };
}

function getMissingPerspectiveTables(db: SQLiteDatabase): string[] {
  const placeholders = PERSPECTIVE_STATS_TABLES.map(() => '?').join(', ');
  const rows = sqliteAll<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
    [...PERSPECTIVE_STATS_TABLES]
  );
  const present = new Set(rows.map((row) => row.name));
  return PERSPECTIVE_STATS_TABLES.filter((table) => !present.has(table));
}

function activeObservationFilter(projectHash: string | undefined, extraClauses: string[] = [], extraParams: unknown[] = []): { clause: string; params: unknown[] } {
  const clauses = ['deleted_at IS NULL', ...extraClauses];
  const params = [...extraParams];
  if (projectHash) {
    clauses.push('project_hash = ?');
    params.push(projectHash);
  }
  return { clause: `WHERE ${clauses.join(' AND ')}`, params };
}

function buildSessionActorStats(db: SQLiteDatabase, projectHash: string | undefined) {
  const filter = projectFilter(projectHash);
  const row = sqliteGet<SessionActorAggregateRow>(
    db,
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN observe_self = 1 THEN 1 ELSE 0 END), 0) AS observeSelfEnabled,
       COALESCE(SUM(CASE WHEN observe_others = 1 THEN 1 ELSE 0 END), 0) AS observeOthersEnabled
     FROM session_actors
     ${filter.clause}`,
    filter.params
  );
  return {
    total: Number(row?.total ?? 0),
    observeSelfEnabled: Number(row?.observeSelfEnabled ?? 0),
    observeOthersEnabled: Number(row?.observeOthersEnabled ?? 0),
    byRole: buildCountRows(
      db,
      `SELECT role_in_session AS label, COUNT(*) AS count FROM session_actors ${filter.clause} GROUP BY role_in_session`,
      filter.params,
      'role'
    )
  };
}

function buildActorCardStats(db: SQLiteDatabase, projectHash: string | undefined) {
  const filter = projectFilter(projectHash);
  const row = sqliteGet<ActorCardAggregateRow>(
    db,
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN json_valid(entries_json) THEN json_array_length(entries_json) ELSE 0 END), 0) AS totalEntries,
       COALESCE(SUM(CASE WHEN json_valid(entries_json) AND json_array_length(entries_json) >= 40 THEN 1 ELSE 0 END), 0) AS fullCards
     FROM actor_cards
     ${filter.clause}`,
    filter.params
  );
  const total = Number(row?.total ?? 0);
  const totalEntries = Number(row?.totalEntries ?? 0);
  return {
    total,
    totalEntries,
    averageEntries: total > 0 ? round(totalEntries / total, 2) : 0,
    fullCards: Number(row?.fullCards ?? 0)
  };
}

function buildPerspectiveActivityByDay(db: SQLiteDatabase, projectHash: string | undefined, windowStartIso: string) {
  const filter = activeObservationFilter(projectHash, ['updated_at >= ?'], [windowStartIso]);
  const rows = sqliteAll<PerspectiveActivityRow>(
    db,
    `SELECT date(updated_at) AS date, level, COUNT(*) AS count
     FROM perspective_observations
     ${filter.clause}
     GROUP BY date(updated_at), level
     ORDER BY date ASC, level ASC`,
    filter.params
  );
  const byDay = new Map<string, Array<{ level: string; count: number }>>();
  for (const row of rows) {
    const levels = byDay.get(row.date) ?? [];
    levels.push({ level: sanitizeAggregateLabel(row.level), count: Number(row.count ?? 0) });
    byDay.set(row.date, levels);
  }
  return Array.from(byDay.entries()).map(([date, levels]) => ({
    date,
    total: levels.reduce((sum, row) => sum + row.count, 0),
    levels: sortCountRows(levels, 'level')
  }));
}

function buildPerspectiveContradictions(db: SQLiteDatabase, projectHash: string | undefined, limit: number) {
  const totalFilter = activeObservationFilter(projectHash, ['level = ?'], ['contradiction']);
  const total = countRowValue(
    db,
    `SELECT COUNT(*) AS count FROM perspective_observations ${totalFilter.clause}`,
    totalFilter.params
  );
  const rows = sqliteAll<PerspectiveContradictionRow>(
    db,
    `SELECT
       observation_id AS observationId,
       observer_actor_id AS observerActorId,
       observed_actor_id AS observedActorId,
       confidence,
       CASE WHEN json_valid(source_event_ids_json) THEN json_array_length(source_event_ids_json) ELSE 0 END AS sourceEventCount,
       CASE WHEN json_valid(source_observation_ids_json) THEN json_array_length(source_observation_ids_json) ELSE 0 END AS sourceObservationCount,
       created_at AS createdAt,
       updated_at AS updatedAt
     FROM perspective_observations
     ${totalFilter.clause}
     ORDER BY updated_at DESC, confidence DESC
     LIMIT ?`,
    [...totalFilter.params, limit]
  );
  const items = rows.map((row) => ({
    observationId: sanitizeAggregateLabel(row.observationId),
    observerActorId: sanitizeAggregateLabel(row.observerActorId),
    observedActorId: sanitizeAggregateLabel(row.observedActorId),
    confidence: round(Number(row.confidence ?? 0), 4),
    sourceEventCount: Number(row.sourceEventCount ?? 0),
    sourceObservationCount: Number(row.sourceObservationCount ?? 0),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }));
  return {
    summary: { total, returnedItems: items.length },
    items
  };
}

function perspectivePairKey(observerActorId: string, observedActorId: string): string {
  return `${observerActorId}\u0000${observedActorId}`;
}

function buildPerspectiveGraph(db: SQLiteDatabase, projectHash: string | undefined, limit: number, totalObservations: number) {
  const filter = activeObservationFilter(projectHash);
  const edgeRows = sqliteAll<PerspectiveGraphEdgeKeyRow>(
    db,
    `SELECT observer_actor_id AS observerActorId,
            observed_actor_id AS observedActorId,
            COUNT(*) AS count
     FROM perspective_observations
     ${filter.clause}
     GROUP BY observer_actor_id, observed_actor_id`,
    filter.params
  );
  const totalEdges = edgeRows.length;
  const selfEdges = edgeRows.filter((row) => row.observerActorId === row.observedActorId).length;

  const levelRows = sqliteAll<PerspectiveGraphLevelRow>(
    db,
    `SELECT observer_actor_id AS observerActorId,
            observed_actor_id AS observedActorId,
            level,
            COUNT(*) AS count
     FROM perspective_observations
     ${filter.clause}
     GROUP BY observer_actor_id, observed_actor_id, level`,
    filter.params
  );
  const levelCountsByEdge = new Map<string, Array<{ level: string; count: number }>>();
  for (const row of levelRows) {
    const key = perspectivePairKey(row.observerActorId, row.observedActorId);
    const levels = levelCountsByEdge.get(key) ?? [];
    levels.push({ level: sanitizeAggregateLabel(row.level), count: Number(row.count ?? 0) });
    levelCountsByEdge.set(key, levels);
  }

  const topRows = sqliteAll<PerspectiveGraphRow>(
    db,
    `SELECT
       p.observer_actor_id AS observerActorId,
       p.observed_actor_id AS observedActorId,
       COUNT(*) AS observationCount,
       AVG(p.confidence) AS averageConfidence,
       COALESCE(SUM(CASE WHEN json_valid(p.source_event_ids_json) THEN json_array_length(p.source_event_ids_json) ELSE 0 END), 0) AS sourceEventCount,
       COALESCE(SUM(CASE WHEN json_valid(p.source_observation_ids_json) THEN json_array_length(p.source_observation_ids_json) ELSE 0 END), 0) AS sourceObservationCount,
       MAX(p.updated_at) AS latestUpdatedAt,
       (
         SELECT COUNT(*)
         FROM actor_cards c
         WHERE c.observer_actor_id = p.observer_actor_id
           AND c.observed_actor_id = p.observed_actor_id
           AND (? IS NULL OR c.project_hash = ?)
       ) AS actorCardCount
     FROM perspective_observations p
     ${filter.clause.replace(/\bproject_hash\b/g, 'p.project_hash')}
     GROUP BY p.observer_actor_id, p.observed_actor_id
     ORDER BY observationCount DESC, latestUpdatedAt DESC, p.observer_actor_id ASC, p.observed_actor_id ASC
     LIMIT ?`,
    [projectHash ?? null, projectHash ?? null, ...filter.params, limit]
  );

  const edges = topRows.map((row) => {
    const observerActorId = sanitizeAggregateLabel(row.observerActorId);
    const observedActorId = sanitizeAggregateLabel(row.observedActorId);
    return {
      observerActorId,
      observedActorId,
      observationCount: Number(row.observationCount ?? 0),
      actorCardCount: Number(row.actorCardCount ?? 0),
      averageConfidence: round(Number(row.averageConfidence ?? 0), 4),
      sourceEventCount: Number(row.sourceEventCount ?? 0),
      sourceObservationCount: Number(row.sourceObservationCount ?? 0),
      latestUpdatedAt: row.latestUpdatedAt,
      levelCounts: sortCountRows(levelCountsByEdge.get(perspectivePairKey(row.observerActorId, row.observedActorId)) ?? [], 'level')
    };
  });

  return {
    summary: {
      totalEdges,
      returnedEdges: edges.length,
      totalObservations,
      selfEdges,
      crossActorEdges: totalEdges - selfEdges
    },
    edges
  };
}

function buildPerspectiveSourceEvidence(db: SQLiteDatabase, projectHash: string | undefined) {
  const filter = activeObservationFilter(projectHash);
  const rows = sqliteAll<PerspectiveSourceEvidenceRow>(
    db,
    `WITH evidence AS (
       SELECT
         level,
         CASE WHEN json_valid(source_event_ids_json) THEN json_array_length(source_event_ids_json) ELSE 0 END AS sourceEventCount,
         CASE WHEN json_valid(source_observation_ids_json) THEN json_array_length(source_observation_ids_json) ELSE 0 END AS sourceObservationCount
       FROM perspective_observations
       ${filter.clause}
     )
     SELECT
       level,
       COUNT(*) AS count,
       COALESCE(SUM(sourceEventCount), 0) AS sourceEventCount,
       COALESCE(SUM(sourceObservationCount), 0) AS sourceObservationCount,
       COALESCE(SUM(CASE WHEN sourceEventCount > 0 THEN 1 ELSE 0 END), 0) AS observationsWithEventEvidence,
       COALESCE(SUM(CASE WHEN sourceObservationCount > 0 THEN 1 ELSE 0 END), 0) AS observationsWithObservationEvidence,
       COALESCE(SUM(CASE WHEN sourceEventCount = 0 AND sourceObservationCount = 0 THEN 1 ELSE 0 END), 0) AS missingEvidenceCount
     FROM evidence
     GROUP BY level`,
    filter.params
  );
  const byLevel = sortCountRows(rows, 'level').map((row) => ({
    level: sanitizeAggregateLabel(row.level),
    count: Number(row.count ?? 0),
    sourceEventCount: Number(row.sourceEventCount ?? 0),
    sourceObservationCount: Number(row.sourceObservationCount ?? 0),
    observationsWithEventEvidence: Number(row.observationsWithEventEvidence ?? 0),
    observationsWithObservationEvidence: Number(row.observationsWithObservationEvidence ?? 0),
    missingEvidenceCount: Number(row.missingEvidenceCount ?? 0)
  }));

  return {
    summary: {
      totalObservations: byLevel.reduce((sum, row) => sum + row.count, 0),
      observationsWithEventEvidence: byLevel.reduce((sum, row) => sum + row.observationsWithEventEvidence, 0),
      observationsWithObservationEvidence: byLevel.reduce((sum, row) => sum + row.observationsWithObservationEvidence, 0),
      observationsMissingEvidence: byLevel.reduce((sum, row) => sum + row.missingEvidenceCount, 0),
      totalSourceEvents: byLevel.reduce((sum, row) => sum + row.sourceEventCount, 0),
      totalSourceObservations: byLevel.reduce((sum, row) => sum + row.sourceObservationCount, 0)
    },
    byLevel
  };
}

function sortCountRows<T extends Record<string, unknown>>(rows: T[], labelKey: keyof T): T[] {
  return [...rows].sort((a, b) => {
    const countDiff = Number(b.count ?? 0) - Number(a.count ?? 0);
    if (countDiff !== 0) return countDiff;
    return String(a[labelKey] ?? '').localeCompare(String(b[labelKey] ?? ''));
  });
}

function buildFacetDistribution(db: SQLiteDatabase, projectHash: string | undefined, topFacetValues: number) {
  const filter = projectFilter(projectHash);
  const rows = sqliteAll<FacetCountRow>(
    db,
    `SELECT dimension, value, COUNT(*) AS count
     FROM memory_facets
     ${filter.clause}
     GROUP BY dimension, value
     ORDER BY dimension ASC, count DESC, value ASC`,
    filter.params
  );
  const dimensionMap = new Map<string, Map<string, number>>();

  for (const row of rows) {
    const dimension = sanitizeAggregateLabel(row.dimension);
    const value = sanitizeAggregateLabel(row.value);
    const values = dimensionMap.get(dimension) ?? new Map<string, number>();
    values.set(value, (values.get(value) ?? 0) + Number(row.count ?? 0));
    dimensionMap.set(dimension, values);
  }

  return Array.from(dimensionMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dimension, values]) => {
      const sortedValues = Array.from(values.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
      const visible = sortedValues.slice(0, topFacetValues);
      const other = sortedValues.slice(topFacetValues).reduce((sum, row) => sum + row.count, 0);
      return { dimension, values: visible, other };
    });
}

function buildCountRows(db: SQLiteDatabase, sql: string, params: unknown[], labelKey: string): Array<Record<string, string | number>> {
  const rows = sqliteAll<CountByLabelRow>(db, sql, params);
  return sortCountRows(rows, 'label').map((row) => ({ [labelKey]: sanitizeAggregateLabel(row.label), count: Number(row.count ?? 0) }));
}

function buildOperationsByDay(db: SQLiteDatabase, projectHash: string | undefined, windowStartIso: string) {
  const clauses = ['created_at >= ?'];
  const params: unknown[] = [windowStartIso];
  if (projectHash) {
    clauses.push('project_hash = ?');
    params.push(projectHash);
  }
  const rows = sqliteAll<AuditOperationRow>(
    db,
    `SELECT date(created_at) AS date, operation, COUNT(*) AS count
     FROM memory_governance_audit
     WHERE ${clauses.join(' AND ')}
     GROUP BY date(created_at), operation
     ORDER BY date ASC, operation ASC`,
    params
  );
  const byDay = new Map<string, Array<{ operation: string; count: number }>>();
  for (const row of rows) {
    const operations = byDay.get(row.date) ?? [];
    operations.push({ operation: sanitizeAggregateLabel(row.operation), count: Number(row.count ?? 0) });
    byDay.set(row.date, operations);
  }
  return Array.from(byDay.entries()).map(([date, operations]) => ({
    date,
    total: operations.reduce((sum, row) => sum + row.count, 0),
    operations
  }));
}

function buildLessonConfidenceBuckets(db: SQLiteDatabase, projectHash: string | undefined) {
  const filter = projectFilter(projectHash);
  const rows = sqliteAll<LessonConfidenceRow>(db, `SELECT confidence FROM memory_lessons ${filter.clause}`, filter.params);
  return LESSON_CONFIDENCE_BUCKETS.map((bucket) => ({
    bucket: bucket.bucket,
    count: rows.filter((row) => {
      const confidence = Number(row.confidence ?? 0);
      return confidence >= bucket.min && confidence < bucket.max;
    }).length
  }));
}

type KpiWindow = '24h' | '7d' | '30d';

type KpiThresholds = {
  usefulRecallRateMin: number;
  reworkRateMax: number;
  postChangeFailureRateMax: number;
  avgCompletionTurnsMax: number;
  memoryHitRateMin: number;
};

const DEFAULT_KPI_THRESHOLDS: KpiThresholds = {
  usefulRecallRateMin: 0.45,
  reworkRateMax: 0.25,
  postChangeFailureRateMax: 0.2,
  avgCompletionTurnsMax: 12,
  memoryHitRateMin: 0.35
};

function loadKpiThresholds(): KpiThresholds {
  try {
    const filePath = path.resolve(process.cwd(), 'config', 'kpi-thresholds.json');
    if (!fs.existsSync(filePath)) return DEFAULT_KPI_THRESHOLDS;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<KpiThresholds>;
    return {
      usefulRecallRateMin: Number(parsed.usefulRecallRateMin ?? DEFAULT_KPI_THRESHOLDS.usefulRecallRateMin),
      reworkRateMax: Number(parsed.reworkRateMax ?? DEFAULT_KPI_THRESHOLDS.reworkRateMax),
      postChangeFailureRateMax: Number(parsed.postChangeFailureRateMax ?? DEFAULT_KPI_THRESHOLDS.postChangeFailureRateMax),
      avgCompletionTurnsMax: Number(parsed.avgCompletionTurnsMax ?? DEFAULT_KPI_THRESHOLDS.avgCompletionTurnsMax),
      memoryHitRateMin: Number(parsed.memoryHitRateMin ?? DEFAULT_KPI_THRESHOLDS.memoryHitRateMin)
    };
  } catch {
    return DEFAULT_KPI_THRESHOLDS;
  }
}

function windowToMs(window: KpiWindow): number {
  if (window === '24h') return 24 * 60 * 60 * 1000;
  if (window === '7d') return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

function inWindow(e: MemoryEvent, now: number, window: KpiWindow): boolean {
  return now - e.timestamp.getTime() <= windowToMs(window);
}

function isEditToolName(name: string): boolean {
  return ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name);
}

function parseToolPayload(e: MemoryEvent): { toolName?: string; success?: boolean; filePath?: string; command?: string } | null {
  if (e.eventType !== 'tool_observation') return null;
  try {
    const payload = JSON.parse(e.content) as any;
    return {
      toolName: payload?.toolName,
      success: payload?.success,
      filePath: payload?.metadata?.filePath,
      command: payload?.metadata?.command
    };
  } catch {
    return {
      toolName: (e.metadata as any)?.toolName,
      success: (e.metadata as any)?.success,
      filePath: (e.metadata as any)?.filePath,
      command: (e.metadata as any)?.command
    };
  }
}

function isTestLikeCommand(command?: string): boolean {
  if (!command) return false;
  return /(test|jest|vitest|pytest|go test|cargo test|lint|eslint|build|tsc)/i.test(command);
}

function safeRatio(num: number, den: number): number {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return 0;
  return num / den;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function computeSessionTurnCount(sessionEvents: MemoryEvent[]): number {
  const turnIds = new Set<string>();
  for (const e of sessionEvents) {
    const turnId = (e.metadata as any)?.turnId;
    if (typeof turnId === 'string' && turnId.length > 0) turnIds.add(turnId);
  }
  if (turnIds.size > 0) return turnIds.size;
  return sessionEvents.filter((e) => e.eventType === 'user_prompt').length;
}

type KpiMetrics = {
  memoryHitRate: number;
  usefulRecallRate: number;
  avgCompletionTurns: number;
  timeToFirstValidEditMinutes: number;
  reworkRate: number;
  postChangeFailureRate: number;
};

type MemoryUsefulnessComponentKey =
  | 'avgHelpfulnessScore'
  | 'usefulRecallRate'
  | 'memoryHitRate'
  | 'retrievalUsageRate'
  | 'queryYieldRate';

type MemoryUsefulnessComponent = {
  key: MemoryUsefulnessComponentKey;
  label: string;
  value: number;
  weight: number;
  available: boolean;
  contribution: number;
};

type MemoryUsefulnessDiagnostic = {
  key: string;
  severity: 'info' | 'warn';
  metric: string;
  value: number;
  target: number;
  title: string;
  detail: string;
  action: string;
};

type HelpfulnessStatsLike = {
  avgScore?: number;
  totalEvaluated?: number;
  totalRetrievals?: number;
  helpful?: number;
  neutral?: number;
  unhelpful?: number;
};

type RetrievalTraceLike = {
  traceId?: string;
  sessionId?: string;
  projectHash?: string;
  strategy?: string;
  confidence?: string;
  candidateCount?: number;
  selectedCount?: number;
  candidateEventIds?: string[];
  selectedEventIds?: string[];
  candidateDetails?: Array<{
    eventId?: string;
    score?: number;
    semanticScore?: number;
    lexicalScore?: number;
    recencyScore?: number;
  }>;
  selectedDetails?: Array<{
    eventId?: string;
    score?: number;
    semanticScore?: number;
    lexicalScore?: number;
    recencyScore?: number;
  }>;
  fallbackTrace?: unknown[];
  queryRewriteKind?: string;
  createdAt?: Date | string;
};

type QueryRewriteKind = 'none' | 'follow-up-context' | 'intent-rewrite';

function normalizeQueryRewriteKind(value?: string | null): QueryRewriteKind {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'follow-up-context' || normalized === 'intent-rewrite') return normalized;
  return 'none';
}

function normalizeMetric(value: unknown): number {
  const numberValue = Number(value || 0);
  if (!Number.isFinite(numberValue)) return 0;
  return Math.max(0, Math.min(1, numberValue));
}

function getTimestampMs(value: Date | string | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function isRewrittenRetrievalTrace(trace: RetrievalTraceLike): boolean {
  return normalizeQueryRewriteKind(trace.queryRewriteKind) !== 'none';
}

function getTraceSelectedCount(trace: RetrievalTraceLike): number {
  return Number(trace.selectedCount ?? trace.selectedEventIds?.length ?? 0);
}

function getTraceCandidateCount(trace: RetrievalTraceLike): number {
  return Number(trace.candidateCount ?? trace.candidateEventIds?.length ?? trace.candidateDetails?.length ?? 0);
}


type RetrievalTraceStrategyStatsLike = {
  strategy?: unknown;
  totalQueries?: unknown;
  queriesWithSelection?: unknown;
  rewrittenQueries?: unknown;
  rewriteRate?: unknown;
  totalCandidateCount?: unknown;
  totalSelectedCount?: unknown;
  avgCandidateCount?: unknown;
  avgSelectedCount?: unknown;
  selectionRate?: unknown;
  queryYieldRate?: unknown;
};

type RetrievalTraceStrategyStatsBucket = {
  strategy: string;
  totalQueries: number;
  queriesWithSelection: number;
  rewrittenQueries: number;
  totalCandidateCount: number;
  totalSelectedCount: number;
};

function normalizeStatsNumber(value: unknown): number {
  const numberValue = Number(value || 0);
  return Number.isFinite(numberValue) ? Math.max(0, numberValue) : 0;
}

function sanitizeRetrievalTraceStrategyBreakdown(value: unknown): RetrievalTraceStrategyStatsLike[] {
  if (!Array.isArray(value)) return [];

  const byStrategy = new Map<string, RetrievalTraceStrategyStatsBucket>();

  for (const item of value) {
    const row = item && typeof item === 'object' ? item as RetrievalTraceStrategyStatsLike : {};
    const strategy = normalizeRetrievalTraceStrategy(row.strategy ?? 'unknown');
    const bucket = byStrategy.get(strategy) ?? {
      strategy,
      totalQueries: 0,
      queriesWithSelection: 0,
      rewrittenQueries: 0,
      totalCandidateCount: 0,
      totalSelectedCount: 0,
    };

    bucket.totalQueries += normalizeStatsNumber(row.totalQueries);
    bucket.queriesWithSelection += normalizeStatsNumber(row.queriesWithSelection);
    bucket.rewrittenQueries += normalizeStatsNumber(row.rewrittenQueries);
    bucket.totalCandidateCount += normalizeStatsNumber(row.totalCandidateCount);
    bucket.totalSelectedCount += normalizeStatsNumber(row.totalSelectedCount);
    byStrategy.set(strategy, bucket);
  }

  return Array.from(byStrategy.values()).map((row) => ({
    strategy: row.strategy,
    totalQueries: row.totalQueries,
    queriesWithSelection: row.queriesWithSelection,
    rewrittenQueries: row.rewrittenQueries,
    rewriteRate: normalizeMetric(safeRatio(row.rewrittenQueries, row.totalQueries)),
    totalCandidateCount: row.totalCandidateCount,
    totalSelectedCount: row.totalSelectedCount,
    avgCandidateCount: safeRatio(row.totalCandidateCount, row.totalQueries),
    avgSelectedCount: safeRatio(row.totalSelectedCount, row.totalQueries),
    selectionRate: normalizeMetric(safeRatio(row.totalSelectedCount, row.totalCandidateCount)),
    queryYieldRate: normalizeMetric(safeRatio(row.queriesWithSelection, row.totalQueries)),
  }));
}

function sanitizeRetrievalTraceStats(stats: unknown) {
  const s = stats && typeof stats === 'object' ? stats as Record<string, unknown> : {};
  return {
    totalQueries: Number(s.totalQueries || 0),
    avgCandidateCount: Number(s.avgCandidateCount || 0),
    avgSelectedCount: Number(s.avgSelectedCount || 0),
    selectionRate: normalizeMetric(s.selectionRate),
    rewrittenQueries: Number(s.rewrittenQueries || 0),
    rewriteRate: normalizeMetric(s.rewriteRate),
    rewrittenQueriesWithSelection: Number(s.rewrittenQueriesWithSelection || 0),
    rawQueriesWithSelection: Number(s.rawQueriesWithSelection || 0),
    rewrittenSelectionRate: normalizeMetric(s.rewrittenSelectionRate),
    rawSelectionRate: normalizeMetric(s.rawSelectionRate),
    avgSelectedCountForRewrittenQueries: Number(s.avgSelectedCountForRewrittenQueries || 0),
    avgSelectedCountForRawQueries: Number(s.avgSelectedCountForRawQueries || 0),
    strategyBreakdown: sanitizeRetrievalTraceStrategyBreakdown(s.strategyBreakdown),
  };
}

type RetrievalReviewReason =
  | 'rewritten-query-no-selection'
  | 'candidate-no-selection'
  | 'empty-candidate-set'
  | 'low-selection-rate';

type RetrievalReviewItem = {
  traceId: string;
  reason: RetrievalReviewReason;
  severity: 'warn' | 'info';
  priority: number;
  title: string;
  detail: string;
  action: string;
  queryRewriteKind: QueryRewriteKind;
  rewritten: boolean;
  strategy: string | null;
  candidateCount: number;
  selectedCount: number;
  candidateEventIds: string[];
  selectedEventIds: string[];
  candidateDetails: NonNullable<RetrievalTraceLike['candidateDetails']>;
  selectedDetails: NonNullable<RetrievalTraceLike['selectedDetails']>;
  createdAt: string;
};

function makeRetrievalReviewItem(trace: RetrievalTraceLike): RetrievalReviewItem | null {
  const candidateCount = getTraceCandidateCount(trace);
  const selectedCount = getTraceSelectedCount(trace);
  const queryRewriteKind = normalizeQueryRewriteKind(trace.queryRewriteKind);
  const rewritten = queryRewriteKind !== 'none';
  const createdAtMs = getTimestampMs(trace.createdAt);
  const createdAt = createdAtMs > 0 ? new Date(createdAtMs).toISOString() : new Date(0).toISOString();

  let reason: RetrievalReviewReason | null = null;
  let severity: 'warn' | 'info' = 'info';
  let priority = 0;
  let title = '';
  let detail = '';
  let action = '';

  if (candidateCount > 0 && selectedCount === 0 && rewritten) {
    reason = 'rewritten-query-no-selection';
    severity = 'warn';
    priority = 100;
    title = 'Rewritten query selected no memories';
    detail = `${candidateCount} candidates were found after query rewrite, but no memory was selected.`;
    action = 'Review rewrite wording, rerank scores, and final selection thresholds for this trace.';
  } else if (candidateCount > 0 && selectedCount === 0) {
    reason = 'candidate-no-selection';
    severity = 'warn';
    priority = 90;
    title = 'Candidates found but nothing selected';
    detail = `${candidateCount} candidates were available, but the final selection injected no memory.`;
    action = 'Review rerank thresholds and candidate filtering; consider overfetching before final selection.';
  } else if (candidateCount === 0) {
    reason = 'empty-candidate-set';
    severity = 'info';
    priority = 70;
    title = 'Retrieval found no candidates';
    detail = 'The retrieval pipeline returned no candidate memories for this trace.';
    action = 'Check trigger/query rewrite coverage and whether the project has indexed memories for this topic.';
  } else if (candidateCount >= 10 && safeRatio(selectedCount, candidateCount) < 0.15) {
    reason = 'low-selection-rate';
    severity = 'info';
    priority = 60;
    title = 'Low selection ratio from many candidates';
    detail = `${selectedCount} of ${candidateCount} candidates were selected.`;
    action = 'Inspect score distribution and MMR/diversity settings before lowering thresholds.';
  }

  if (!reason) return null;

  return {
    traceId: trace.traceId || 'unknown-trace',
    reason,
    severity,
    priority,
    title,
    detail,
    action,
    queryRewriteKind,
    rewritten,
    strategy: normalizeRetrievalTraceStrategy(trace.strategy ?? 'unknown'),
    candidateCount,
    selectedCount,
    candidateEventIds: (trace.candidateEventIds || []).slice(0, 5),
    selectedEventIds: (trace.selectedEventIds || []).slice(0, 5),
    candidateDetails: (trace.candidateDetails || []).slice(0, 3).map((detail) => ({
      eventId: detail.eventId,
      score: detail.score,
      semanticScore: detail.semanticScore,
      lexicalScore: detail.lexicalScore,
      recencyScore: detail.recencyScore,
    })),
    selectedDetails: (trace.selectedDetails || []).slice(0, 3).map((detail) => ({
      eventId: detail.eventId,
      score: detail.score,
      semanticScore: detail.semanticScore,
      lexicalScore: detail.lexicalScore,
      recencyScore: detail.recencyScore,
    })),
    createdAt,
  };
}

function buildRetrievalReviewQueue(traces: RetrievalTraceLike[], limit: number) {
  const reviewItems = traces
    .map(makeRetrievalReviewItem)
    .filter((item): item is RetrievalReviewItem => item !== null)
    .sort((a, b) => b.priority - a.priority || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return {
    summary: {
      totalTraces: traces.length,
      reviewItems: reviewItems.length,
      returnedItems: Math.min(reviewItems.length, limit),
      candidateNoSelection: reviewItems.filter((item) => item.reason === 'candidate-no-selection').length,
      emptyCandidateSet: reviewItems.filter((item) => item.reason === 'empty-candidate-set').length,
      rewrittenNoSelection: reviewItems.filter((item) => item.reason === 'rewritten-query-no-selection').length,
      lowSelectionRate: reviewItems.filter((item) => item.reason === 'low-selection-rate').length,
    },
    items: reviewItems.slice(0, limit),
  };
}

function parseStatsLimit(value: string | undefined, fallback: number, max: number): number {
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function usefulnessScoreLabel(score: number, confidence: number): 'excellent' | 'good' | 'watch' | 'low' | 'unknown' {
  if (confidence <= 0) return 'unknown';
  if (score >= 80) return 'excellent';
  if (score >= 60) return 'good';
  if (score >= 40) return 'watch';
  return 'low';
}

function buildMemoryUsefulnessDiagnostics(input: {
  metrics: {
    avgHelpfulnessScore: number;
    memoryHitRate: number;
    queryYieldRate: number;
    evaluationCoverage: number;
    selectionRate: number;
  };
  counts: {
    promptCount: number;
    memoryCheckedPrompts: number;
    retrievalQueries: number;
    queriesWithSelected: number;
    selectedMemories: number;
    candidateMemories: number;
    totalEvaluated: number;
    totalRetrievals: number;
  };
}): MemoryUsefulnessDiagnostic[] {
  const { metrics, counts } = input;
  const diagnostics: MemoryUsefulnessDiagnostic[] = [];

  if (counts.promptCount > 0 && counts.retrievalQueries === 0) {
    diagnostics.push({
      key: 'no-retrieval-traces',
      severity: 'warn',
      metric: 'retrievalUsageRate',
      value: 0,
      target: 0.5,
      title: 'No retrieval traces were recorded',
      detail: `${counts.promptCount} prompts were seen, but none produced a retrieval trace in this window.`,
      action: 'Confirm the prompt hook is enabled and broaden adherence triggers for continuation, write-intent, and project-specific prompts.'
    });
  }

  if (counts.promptCount > 0 && metrics.memoryHitRate < 0.5) {
    diagnostics.push({
      key: 'low-memory-hit-rate',
      severity: 'warn',
      metric: 'memoryHitRate',
      value: metrics.memoryHitRate,
      target: 0.5,
      title: 'Memory checks are missing many prompts',
      detail: `Only ${counts.memoryCheckedPrompts} of ${counts.promptCount} prompts had an adherence check in this window.`,
      action: 'Broaden adherence triggers for continuation, write-intent, topic-shift, and project-specific prompts.'
    });
  }

  if (counts.retrievalQueries > 0 && metrics.queryYieldRate < 0.6) {
    diagnostics.push({
      key: 'low-query-yield-rate',
      severity: 'warn',
      metric: 'queryYieldRate',
      value: metrics.queryYieldRate,
      target: 0.6,
      title: 'Searches often select no memory',
      detail: `${counts.queriesWithSelected} of ${counts.retrievalQueries} retrieval queries injected at least one memory.`,
      action: 'Overfetch candidates, then filter/rerank before applying the final injection threshold.'
    });
  }

  if (counts.totalEvaluated > 0 && metrics.avgHelpfulnessScore < 0.7) {
    diagnostics.push({
      key: 'low-helpfulness-score',
      severity: 'warn',
      metric: 'avgHelpfulnessScore',
      value: metrics.avgHelpfulnessScore,
      target: 0.7,
      title: 'Injected memories are not translating into outcomes',
      detail: `${counts.totalEvaluated} evaluated retrievals averaged ${(metrics.avgHelpfulnessScore * 100).toFixed(1)}% helpfulness.`,
      action: 'Review low-scoring retrieval samples for stale decisions, cross-project noise, or raw transcript snippets.'
    });
  }

  if (counts.totalRetrievals > 0 && metrics.evaluationCoverage < 0.8) {
    diagnostics.push({
      key: 'low-evaluation-coverage',
      severity: 'info',
      metric: 'evaluationCoverage',
      value: metrics.evaluationCoverage,
      target: 0.8,
      title: 'Many retrievals are still unevaluated',
      detail: `${counts.totalEvaluated} of ${counts.totalRetrievals} retrievals have measured helpfulness.`,
      action: 'Ensure Stop/session-end hooks or pending-session backfill are running so usefulness reflects real outcomes.'
    });
  }

  if (counts.candidateMemories > 0 && counts.selectedMemories === 0) {
    diagnostics.push({
      key: 'candidates-without-selection',
      severity: 'warn',
      metric: 'selectionRate',
      value: metrics.selectionRate,
      target: 0.2,
      title: 'Candidates are found but none are injected',
      detail: `${counts.candidateMemories} candidates were retrieved, but no memories passed the injection policy.`,
      action: 'Inspect threshold settings and prompt-injection policy before lowering filters globally.'
    });
  }

  return diagnostics.slice(0, 3);
}

function computeMemoryUsefulnessSummary(
  events: MemoryEvent[],
  helpfulness: HelpfulnessStatsLike,
  traces: RetrievalTraceLike[],
  now: number,
  window: KpiWindow,
  limits: { eventsLimit?: number; tracesLimit?: number } = {}
) {
  const windowEvents = events.filter((event) => inWindow(event, now, window));
  const prompts = windowEvents.filter((event) => event.eventType === 'user_prompt');
  const promptCount = prompts.length;
  const memoryCheckedPrompts = prompts.filter((prompt) => (prompt.metadata as any)?.adherence?.checked).length;

  const windowMs = windowToMs(window);
  const windowStart = now - windowMs;
  const windowTraces = traces.filter((trace) => {
    const ts = getTimestampMs(trace.createdAt);
    return ts > 0 && ts >= windowStart;
  });
  const oldestEventTimestamp = events.reduce((oldest, event) => {
    const timestamp = event.timestamp?.getTime?.() || 0;
    return timestamp > 0 ? Math.min(oldest, timestamp) : oldest;
  }, Number.POSITIVE_INFINITY);
  const oldestTraceTimestamp = traces.reduce((oldest, trace) => {
    const timestamp = getTimestampMs(trace.createdAt);
    return timestamp > 0 ? Math.min(oldest, timestamp) : oldest;
  }, Number.POSITIVE_INFINITY);
  const eventWindowTruncated = Boolean(
    limits.eventsLimit &&
    events.length >= limits.eventsLimit &&
    Number.isFinite(oldestEventTimestamp) &&
    oldestEventTimestamp >= windowStart
  );
  const traceWindowTruncated = Boolean(
    limits.tracesLimit &&
    traces.length >= limits.tracesLimit &&
    Number.isFinite(oldestTraceTimestamp) &&
    oldestTraceTimestamp >= windowStart
  );

  const retrievalQueries = windowTraces.length;
  const candidateCounts = windowTraces.map((trace) => Number(trace.candidateCount ?? trace.candidateEventIds?.length ?? 0));
  const selectedCounts = windowTraces.map((trace) => getTraceSelectedCount(trace));
  const totalCandidateCount = candidateCounts.reduce((sum, count) => sum + (Number.isFinite(count) ? count : 0), 0);
  const totalSelectedCount = selectedCounts.reduce((sum, count) => sum + (Number.isFinite(count) ? count : 0), 0);
  const queriesWithSelected = selectedCounts.filter((count) => Number.isFinite(count) && count > 0).length;
  const rewrittenTraces = windowTraces.filter(isRewrittenRetrievalTrace);
  const rawTraces = windowTraces.filter((trace) => !isRewrittenRetrievalTrace(trace));
  const rewrittenQueries = rewrittenTraces.length;
  const rawQueries = rawTraces.length;
  const rewrittenSelectedCount = rewrittenTraces.reduce((sum, trace) => {
    const selectedCount = getTraceSelectedCount(trace);
    return sum + (Number.isFinite(selectedCount) ? selectedCount : 0);
  }, 0);
  const rawSelectedCount = rawTraces.reduce((sum, trace) => {
    const selectedCount = getTraceSelectedCount(trace);
    return sum + (Number.isFinite(selectedCount) ? selectedCount : 0);
  }, 0);
  const rewrittenQueriesWithSelected = rewrittenTraces.filter((trace) => getTraceSelectedCount(trace) > 0).length;
  const rawQueriesWithSelected = rawTraces.filter((trace) => getTraceSelectedCount(trace) > 0).length;

  const totalEvaluated = Number(helpfulness.totalEvaluated || 0);
  const totalRetrievals = Number(helpfulness.totalRetrievals || 0);
  const helpful = Number(helpfulness.helpful || 0);
  const neutral = Number(helpfulness.neutral || 0);
  const unhelpful = Number(helpfulness.unhelpful || 0);

  const retrievalsPerPrompt = safeRatio(retrievalQueries, promptCount);
  const metrics = {
    avgHelpfulnessScore: round(normalizeMetric(helpfulness.avgScore)),
    usefulRecallRate: round(safeRatio(helpful, totalEvaluated)),
    memoryHitRate: round(safeRatio(memoryCheckedPrompts, promptCount)),
    retrievalUsageRate: round(Math.min(1, retrievalsPerPrompt)),
    queryYieldRate: round(safeRatio(queriesWithSelected, retrievalQueries)),
    evaluationCoverage: round(safeRatio(totalEvaluated, totalRetrievals)),
    retrievalsPerPrompt: round(retrievalsPerPrompt),
    avgCandidatesPerQuery: round(safeRatio(totalCandidateCount, retrievalQueries), 2),
    avgSelectedPerQuery: round(safeRatio(totalSelectedCount, retrievalQueries), 2),
    selectionRate: round(safeRatio(totalSelectedCount, totalCandidateCount)),
    queryRewriteRate: round(safeRatio(rewrittenQueries, retrievalQueries)),
    rewrittenQueryYieldRate: round(safeRatio(rewrittenQueriesWithSelected, rewrittenQueries)),
    rawQueryYieldRate: round(safeRatio(rawQueriesWithSelected, rawQueries)),
    avgSelectedPerRewrittenQuery: round(safeRatio(rewrittenSelectedCount, rewrittenQueries), 2),
    avgSelectedPerRawQuery: round(safeRatio(rawSelectedCount, rawQueries), 2)
  };
  const counts = {
    promptCount,
    memoryCheckedPrompts,
    retrievalQueries,
    queriesWithSelected,
    rewrittenQueries,
    rawQueries,
    rewrittenQueriesWithSelected,
    rawQueriesWithSelected,
    selectedMemories: totalSelectedCount,
    candidateMemories: totalCandidateCount,
    totalEvaluated,
    totalRetrievals,
    helpful,
    neutral,
    unhelpful
  };

  const componentSpecs: Omit<MemoryUsefulnessComponent, 'contribution'>[] = [
    { key: 'avgHelpfulnessScore', label: 'Average helpfulness score', value: metrics.avgHelpfulnessScore, weight: 0.3, available: totalEvaluated > 0 },
    { key: 'usefulRecallRate', label: 'Useful recall rate', value: metrics.usefulRecallRate, weight: 0.25, available: totalEvaluated > 0 },
    { key: 'memoryHitRate', label: 'Memory hit rate', value: metrics.memoryHitRate, weight: 0.2, available: promptCount > 0 },
    { key: 'retrievalUsageRate', label: 'Retrieval usage rate', value: metrics.retrievalUsageRate, weight: 0.15, available: promptCount > 0 },
    { key: 'queryYieldRate', label: 'Query yield rate', value: metrics.queryYieldRate, weight: 0.1, available: retrievalQueries > 0 }
  ];
  const totalWeight = componentSpecs.reduce((sum, component) => sum + component.weight, 0);
  const availableWeight = componentSpecs
    .filter((component) => component.available)
    .reduce((sum, component) => sum + component.weight, 0);
  const weightedScore = availableWeight > 0
    ? componentSpecs.reduce((sum, component) => sum + (component.available ? component.value * component.weight : 0), 0) / availableWeight
    : 0;
  const scoreValue = round(weightedScore * 100, 1);
  const confidence = round(safeRatio(availableWeight, totalWeight), 2);
  const components = componentSpecs.map((component) => ({
    ...component,
    contribution: component.available ? round(component.value * component.weight * 100, 2) : 0
  }));

  return {
    window,
    score: {
      value: scoreValue,
      label: usefulnessScoreLabel(scoreValue, confidence),
      confidence
    },
    metrics,
    counts,
    components,
    diagnostics: buildMemoryUsefulnessDiagnostics({ metrics, counts }),
    limits: {
      eventsLimit: limits.eventsLimit || events.length,
      tracesLimit: limits.tracesLimit || traces.length,
      eventWindowTruncated,
      traceWindowTruncated
    },
    generatedAt: new Date(now).toISOString()
  };
}

function computeKpiMetrics(events: MemoryEvent[], usefulRecallRate: number): KpiMetrics {
  const prompts = events.filter((e) => e.eventType === 'user_prompt');
  const promptCount = prompts.length;
  const memoryHitPrompts = prompts.filter((p) => (p.metadata as any)?.adherence?.checked).length;
  const memoryHitRate = round(safeRatio(memoryHitPrompts, promptCount));

  const sessions = new Map<string, MemoryEvent[]>();
  for (const e of events) {
    const arr = sessions.get(e.sessionId) || [];
    arr.push(e);
    sessions.set(e.sessionId, arr);
  }

  let sessionTurnTotal = 0;
  let sessionTurnSamples = 0;
  let firstValidEditMinutesTotal = 0;
  let firstValidEditSamples = 0;

  for (const sessionEvents of sessions.values()) {
    sessionEvents.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const turns = computeSessionTurnCount(sessionEvents);
    if (turns > 0) {
      sessionTurnTotal += turns;
      sessionTurnSamples++;
    }

    const firstPrompt = sessionEvents.find((e) => e.eventType === 'user_prompt');
    const firstEdit = sessionEvents.find((e) => {
      const payload = parseToolPayload(e);
      return payload?.toolName && isEditToolName(payload.toolName) && payload.success === true;
    });
    if (firstPrompt && firstEdit) {
      const minutes = (firstEdit.timestamp.getTime() - firstPrompt.timestamp.getTime()) / 60000;
      if (minutes >= 0) {
        firstValidEditMinutesTotal += minutes;
        firstValidEditSamples++;
      }
    }
  }

  const avgCompletionTurns = round(safeRatio(sessionTurnTotal, sessionTurnSamples), 2);
  const timeToFirstValidEditMinutes = round(safeRatio(firstValidEditMinutesTotal, firstValidEditSamples), 2);

  const editActions: Array<{ sessionId: string; timestamp: number; filePath?: string }> = [];
  let testRunsAfterEdit = 0;
  let failedTestRunsAfterEdit = 0;

  for (const [sessionId, sessionEvents] of sessions.entries()) {
    const sorted = [...sessionEvents].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    let seenEdit = false;

    for (const e of sorted) {
      const payload = parseToolPayload(e);
      if (!payload?.toolName) continue;

      if (isEditToolName(payload.toolName) && payload.success === true) {
        editActions.push({ sessionId, timestamp: e.timestamp.getTime(), filePath: payload.filePath });
        seenEdit = true;
        continue;
      }

      if (seenEdit && isTestLikeCommand(payload.command)) {
        testRunsAfterEdit++;
        if (payload.success === false) failedTestRunsAfterEdit++;
      }
    }
  }

  const THIRTY_MIN_MS = 30 * 60 * 1000;
  let reworkCount = 0;
  const bySessionFile = new Map<string, number>();
  const sortedEdits = [...editActions].sort((a, b) => a.timestamp - b.timestamp);
  for (const edit of sortedEdits) {
    if (!edit.filePath) continue;
    const key = `${edit.sessionId}::${edit.filePath}`;
    const prev = bySessionFile.get(key);
    if (typeof prev === 'number' && edit.timestamp - prev <= THIRTY_MIN_MS) {
      reworkCount++;
    }
    bySessionFile.set(key, edit.timestamp);
  }

  const reworkRate = round(safeRatio(reworkCount, editActions.length));
  const postChangeFailureRate = round(safeRatio(failedTestRunsAfterEdit, testRunsAfterEdit));

  return {
    memoryHitRate,
    usefulRecallRate,
    avgCompletionTurns,
    timeToFirstValidEditMinutes,
    reworkRate,
    postChangeFailureRate
  };
}


// GET /api/stats/shared - Get shared store statistics
statsRouter.get('/shared', async (c) => {
  const memoryService = getLightweightServiceFromQuery(c);
  try {
    await memoryService.initialize();
    const sharedStats = await memoryService.getSharedStoreStats();
    return c.json({
      troubleshooting: sharedStats?.total || 0,
      bestPractices: 0,
      commonErrors: 0,
      totalUsageCount: sharedStats?.totalUsageCount || 0,
      lastUpdated: null
    });
  } catch (error) {
    return c.json({
      troubleshooting: 0,
      bestPractices: 0,
      commonErrors: 0,
      totalUsageCount: 0,
      lastUpdated: null
    });
  } finally {
    await memoryService.shutdown();
  }
});

// GET /api/stats/endless - Get endless mode status
statsRouter.get('/endless', async (c) => {
  const memoryService = getLightweightServiceFromQuery(c);
  try {
    await memoryService.initialize();
    const status = await memoryService.getEndlessModeStatus();
    return c.json({
      mode: status.mode,
      continuityScore: status.continuityScore,
      workingSetSize: status.workingSetSize,
      consolidatedCount: status.consolidatedCount,
      lastConsolidation: status.lastConsolidation?.toISOString() || null
    });
  } catch (error) {
    return c.json({
      mode: 'session',
      continuityScore: 0,
      workingSetSize: 0,
      consolidatedCount: 0,
      lastConsolidation: null
    });
  } finally {
    await memoryService.shutdown();
  }
});

// GET /api/stats/levels/:level - Get events by memory level
statsRouter.get('/levels/:level', async (c) => {
  const { level } = c.req.param();
  const limit = parseInt(c.req.query('limit') || '20', 10);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  const sort = c.req.query('sort') || 'recent';

  // Validate level
  const validLevels = ['L0', 'L1', 'L2', 'L3', 'L4'];
  if (!validLevels.includes(level)) {
    return c.json({ error: `Invalid level. Must be one of: ${validLevels.join(', ')}` }, 400);
  }

  const memoryService = getLightweightServiceFromQuery(c);
  try {
    await memoryService.initialize();
    let events = await memoryService.getEventsByLevel(level, { limit: limit * 2, offset });
    const stats = await memoryService.getStats();
    const levelStat = stats.levelStats.find(s => s.level === level);

    // Apply sorting
    if (sort === 'accessed') {
      // Sort by access count (will need to get from SQLite)
      // For now, add access count from SQLite if available
      const sqliteStore = (memoryService as any).sqliteEventStore;
      if (sqliteStore) {
        const accessedEvents = await sqliteStore.getMostAccessed(1000);
        const accessMap = new Map(accessedEvents.map((e: any) => [e.id, e.access_count || 0]));
        events = events.map((e: any) => ({
          ...e,
          accessCount: accessMap.get(e.id) || 0
        }));
        events.sort((a: any, b: any) => b.accessCount - a.accessCount);
      }
    } else if (sort === 'oldest') {
      events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    } else {
      // 'recent' - default sorting (newest first)
      events.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    }

    // Apply limit after sorting
    events = events.slice(0, limit);

    return c.json({
      level,
      events: events.map((e: any) => ({
        id: e.id,
        eventType: e.eventType,
        sessionId: e.sessionId,
        timestamp: e.timestamp.toISOString(),
        content: e.content.slice(0, 500) + (e.content.length > 500 ? '...' : ''),
        metadata: e.metadata,
        accessCount: e.accessCount || 0
      })),
      total: levelStat?.count || 0,
      limit,
      offset,
      hasMore: events.length === limit
    });
  } catch (error) {
    return jsonError(c, error);
  } finally {
    await memoryService.shutdown();
  }
});

// GET /api/stats/operations - Aggregate-only operation-layer observability stats
statsRouter.get('/operations', async (c) => {
  const context = getOperationsStatsContext(c.req.query('project') || c.req.query('projectId'));
  const windowDays = parseStatsLimit(c.req.query('windowDays'), 30, 365);
  const topFacetValues = parseStatsLimit(c.req.query('topFacetValues'), 5, 25);
  const databaseExists = fs.existsSync(context.dbPath);

  if (!databaseExists) {
    return c.json(emptyOperationsStatsPayload(context, false, [...OPERATION_STATS_TABLES], windowDays));
  }

  let db: SQLiteDatabase | null = null;
  try {
    db = createSQLiteDatabase(context.dbPath, { readonly: true, walMode: false });
    const missingTables = getMissingOperationTables(db);
    if (missingTables.length > 0) {
      return c.json(emptyOperationsStatsPayload(context, true, missingTables, windowDays));
    }

    const now = Date.now();
    const windowStartIso = new Date(now - windowDays * 24 * 60 * 60 * 1000).toISOString();
    const projectScoped = projectFilter(context.projectHash);
    const auditClauses = ['created_at >= ?'];
    const auditParams: unknown[] = [windowStartIso];
    if (context.projectHash) {
      auditClauses.push('project_hash = ?');
      auditParams.push(context.projectHash);
    }
    const auditWhere = `WHERE ${auditClauses.join(' AND ')}`;

    const facets = {
      totalAssignments: countRowValue(db, `SELECT COUNT(*) AS count FROM memory_facets ${projectScoped.clause}`, projectScoped.params),
      distribution: buildFacetDistribution(db, context.projectHash, topFacetValues)
    };
    const actions = {
      total: countRowValue(db, `SELECT COUNT(*) AS count FROM memory_actions ${projectScoped.clause}`, projectScoped.params),
      byStatus: buildCountRows(
        db,
        `SELECT status AS label, COUNT(*) AS count FROM memory_actions ${projectScoped.clause} GROUP BY status`,
        projectScoped.params,
        'status'
      )
    };
    const leases = {
      totalActive: countRowValue(db, 'SELECT COUNT(*) AS count FROM memory_leases WHERE released_at IS NULL AND expires_at > ?', [new Date(now).toISOString()]),
      activeByTargetType: buildCountRows(
        db,
        'SELECT target_type AS label, COUNT(*) AS count FROM memory_leases WHERE released_at IS NULL AND expires_at > ? GROUP BY target_type',
        [new Date(now).toISOString()],
        'targetType'
      )
    };
    const retention = {
      total: countRowValue(db, `SELECT COUNT(*) AS count FROM memory_retention_scores ${projectScoped.clause}`, projectScoped.params),
      byDecision: buildCountRows(
        db,
        `SELECT decision AS label, COUNT(*) AS count FROM memory_retention_scores ${projectScoped.clause} GROUP BY decision`,
        projectScoped.params,
        'decision'
      )
    };
    const governanceAudit = {
      total: countRowValue(db, `SELECT COUNT(*) AS count FROM memory_governance_audit ${auditWhere}`, auditParams),
      operationsByDay: buildOperationsByDay(db, context.projectHash, windowStartIso)
    };
    const lessons = {
      total: countRowValue(db, `SELECT COUNT(*) AS count FROM memory_lessons ${projectScoped.clause}`, projectScoped.params),
      confidenceBuckets: buildLessonConfidenceBuckets(db, context.projectHash)
    };

    return c.json({
      generatedAt: new Date(now).toISOString(),
      windowDays,
      projectHash: context.projectHash,
      projection: {
        databaseExists: true,
        available: true,
        missingTables: []
      },
      facets,
      actions,
      leases,
      retention,
      governanceAudit,
      lessons
    });
  } catch (error) {
    console.error('[stats/operations] Failed to load aggregate stats:', error);
    return c.json({ error: 'Failed to load operations stats' }, 500);
  } finally {
    db?.close();
  }
});

// GET /api/stats/perspective - Aggregate-only perspective-memory observability stats
statsRouter.get('/perspective', async (c) => {
  const context = getOperationsStatsContext(c.req.query('project') || c.req.query('projectId'));
  const windowDays = parseStatsLimit(c.req.query('windowDays'), 30, 365);
  const contradictionLimit = parseStatsLimit(c.req.query('contradictionLimit'), 10, 50);
  const graphLimit = parseStatsLimit(c.req.query('graphLimit'), 10, 50);
  const databaseExists = fs.existsSync(context.dbPath);

  if (!databaseExists) {
    return c.json(emptyPerspectiveStatsPayload(context, false, [...PERSPECTIVE_STATS_TABLES], windowDays));
  }

  let db: SQLiteDatabase | null = null;
  try {
    db = createSQLiteDatabase(context.dbPath, { readonly: true, walMode: false });
    const missingTables = getMissingPerspectiveTables(db);
    if (missingTables.length > 0) {
      return c.json(emptyPerspectiveStatsPayload(context, true, missingTables, windowDays));
    }

    const now = Date.now();
    const windowStartIso = new Date(now - windowDays * 24 * 60 * 60 * 1000).toISOString();
    const projectScoped = projectFilter(context.projectHash);
    const observationScoped = activeObservationFilter(context.projectHash);

    const actors = {
      total: countRowValue(db, `SELECT COUNT(*) AS count FROM memory_actors ${projectScoped.clause}`, projectScoped.params),
      byKind: buildCountRows(
        db,
        `SELECT kind AS label, COUNT(*) AS count FROM memory_actors ${projectScoped.clause} GROUP BY kind`,
        projectScoped.params,
        'kind'
      )
    };
    const sessionActors = buildSessionActorStats(db, context.projectHash);
    const actorCards = buildActorCardStats(db, context.projectHash);
    const observations = {
      total: countRowValue(db, `SELECT COUNT(*) AS count FROM perspective_observations ${observationScoped.clause}`, observationScoped.params),
      byLevel: buildCountRows(
        db,
        `SELECT level AS label, COUNT(*) AS count FROM perspective_observations ${observationScoped.clause} GROUP BY level`,
        observationScoped.params,
        'level'
      ),
      byCreatedBy: buildCountRows(
        db,
        `SELECT created_by AS label, COUNT(*) AS count FROM perspective_observations ${observationScoped.clause} GROUP BY created_by`,
        observationScoped.params,
        'createdBy'
      )
    };
    const contradictions = buildPerspectiveContradictions(db, context.projectHash, contradictionLimit);
    const perspectiveGraph = buildPerspectiveGraph(db, context.projectHash, graphLimit, observations.total);
    const sourceEvidence = buildPerspectiveSourceEvidence(db, context.projectHash);
    const recentActivity = {
      byDay: buildPerspectiveActivityByDay(db, context.projectHash, windowStartIso)
    };

    return c.json({
      generatedAt: new Date(now).toISOString(),
      windowDays,
      projectHash: context.projectHash,
      projection: {
        databaseExists: true,
        available: true,
        missingTables: []
      },
      actors,
      sessionActors,
      actorCards,
      observations,
      perspectiveGraph,
      sourceEvidence,
      contradictions,
      recentActivity
    });
  } catch {
    console.error('[stats/perspective] Failed to load aggregate stats');
    return c.json({ error: 'Failed to load perspective stats' }, 500);
  } finally {
    db?.close();
  }
});

// GET /api/stats - Get overall statistics
statsRouter.get('/', async (c) => {
  const memoryService = getLightweightServiceFromQuery(c);
  try {
    await memoryService.initialize();

    // Aggregate in SQL rather than loading the 10k most-recent events and
    // counting in JS (which also under-counted stores larger than that window).
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [stats, typeCounts, sessionTotal, dailyCounts, rawTrace] = await Promise.all([
      memoryService.getStats(),
      memoryService.getEventTypeCounts(),
      memoryService.getDistinctSessionCount(),
      memoryService.getDailyEventCounts(sevenDaysAgo),
      memoryService.getRetrievalTraceStats()
    ]);

    const eventsByType = Object.fromEntries(typeCounts.map((t) => [t.eventType, t.count]));
    const eventsByDay = Object.fromEntries(dailyCounts.map((d) => [d.day, d.total]));
    const retrievalTrace = sanitizeRetrievalTraceStats(rawTrace);

    return c.json({
      storage: {
        eventCount: stats.totalEvents,
        vectorCount: stats.vectorCount
      },
      sessions: {
        total: sessionTotal
      },
      eventsByType,
      activity: {
        daily: eventsByDay,
        total7Days: dailyCounts.reduce((sum, d) => sum + d.total, 0)
      },
      memory: {
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
      },
      levelStats: stats.levelStats,
      retrievalTrace
    });
  } catch (error) {
    return jsonError(c, error);
  } finally {
    await memoryService.shutdown();
  }
});

// GET /api/stats/most-accessed - Get most accessed memories
statsRouter.get('/most-accessed', async (c) => {
  const limit = parseInt(c.req.query('limit') || '10', 10);
  // Use the same read-only service that other stats endpoints use
  const memoryService = getLightweightServiceFromQuery(c);

  try {
    await memoryService.initialize();
    console.log('[most-accessed] Fetching most accessed memories, limit:', limit);
    const memories = await memoryService.getMostAccessedMemories(limit);
    console.log('[most-accessed] Got memories:', memories.length);

    return c.json({
      memories: memories.map(m => ({
        memoryId: m.memoryId,
        summary: m.summary,
        topics: m.topics,
        accessCount: m.accessCount,
        lastAccessed: m.lastAccessed || null,
        confidence: m.confidence,
        createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt
      })),
      total: memories.length
    });
  } catch (error) {
    console.error('[most-accessed] Error:', error);
    return c.json({
      memories: [],
      total: 0,
      error: (error as Error).message
    });
  } finally {
    await memoryService.shutdown();
  }
});

// GET /api/stats/timeline - Get activity timeline
statsRouter.get('/timeline', async (c) => {
  const parsedDays = parseInt(c.req.query('days') || '7', 10);
  const days = Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : 7;
  const memoryService = getLightweightServiceFromQuery(c);

  try {
    await memoryService.initialize();

    // Group by day in SQL instead of scanning the 10k most-recent events.
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const daily = (await memoryService.getDailyEventCounts(cutoff)).map((d) => ({
      date: d.day,
      total: d.total,
      prompts: d.prompts,
      responses: d.responses,
      tools: d.tools
    }));

    return c.json({ days, daily });
  } catch (error) {
    return jsonError(c, error);
  } finally {
    await memoryService.shutdown();
  }
});

// GET /api/stats/helpfulness - Get helpfulness statistics and top helpful memories
statsRouter.get('/helpfulness', async (c) => {
  const limit = parseInt(c.req.query('limit') || '10', 10);
  const memoryService = getLightweightServiceFromQuery(c);

  try {
    await memoryService.initialize();
    const stats = await memoryService.getHelpfulnessStats();
    const topMemories = await memoryService.getHelpfulMemories(limit);

    return c.json({
      ...stats,
      topMemories: topMemories.map(m => ({
        eventId: m.eventId,
        summary: m.summary,
        helpfulnessScore: m.helpfulnessScore,
        accessCount: m.accessCount,
        evaluationCount: m.evaluationCount
      }))
    });
  } catch (error) {
    return c.json({
      avgScore: 0,
      totalEvaluated: 0,
      totalRetrievals: 0,
      helpful: 0,
      neutral: 0,
      unhelpful: 0,
      topMemories: []
    });
  } finally {
    await memoryService.shutdown();
  }
});
// GET /api/stats/usefulness - Get a dashboard-ready memory usefulness score
statsRouter.get('/usefulness', async (c) => {
  const rawWindow = (c.req.query('window') || '7d') as KpiWindow;
  const window: KpiWindow = rawWindow === '24h' || rawWindow === '30d' ? rawWindow : '7d';
  const memoryService = getLightweightServiceFromQuery(c);

  try {
    await memoryService.initialize();
    const now = Date.now();
    const eventLimit = 20000;
    const traceLimit = 5000;
    const windowStart = new Date(now - windowToMs(window));
    const [events, helpfulness, traces] = await Promise.all([
      memoryService.getRecentEvents(eventLimit),
      memoryService.getHelpfulnessStats(windowStart),
      memoryService.getRecentRetrievalTraces(traceLimit)
    ]);

    return c.json(computeMemoryUsefulnessSummary(events, helpfulness, traces, now, window, {
      eventsLimit: eventLimit,
      tracesLimit: traceLimit
    }));
  } catch (error) {
    console.error('[stats/usefulness] failed to calculate dashboard metrics', error);
    return c.json({ error: 'Unable to calculate memory usefulness statistics' }, 500);
  } finally {
    await memoryService.shutdown();
  }
});



// GET /api/stats/retrieval-traces - Get recent retrieval traces (query -> selected context)
statsRouter.get('/retrieval-traces', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const memoryService = getLightweightServiceFromQuery(c);

  try {
    await memoryService.initialize();
    const traces = await memoryService.getRecentRetrievalTraces(limit);
    const traceStats = await memoryService.getRetrievalTraceStats();

    return c.json({
      stats: sanitizeRetrievalTraceStats(traceStats as unknown as Record<string, unknown>),
      traces: traces.map((t) => {
        const queryRewriteKind = normalizeQueryRewriteKind(t.queryRewriteKind);
        return {
          traceId: t.traceId,
          sessionId: t.sessionId || null,
          projectHash: t.projectHash || null,
          queryRewriteKind,
          rewritten: queryRewriteKind !== 'none',
          strategy: normalizeRetrievalTraceStrategy(t.strategy ?? 'unknown'),
          candidateEventIds: t.candidateEventIds,
          selectedEventIds: t.selectedEventIds,
          candidateDetails: t.candidateDetails || [],
          selectedDetails: t.selectedDetails || [],
          candidateCount: t.candidateCount,
          selectedCount: t.selectedCount,
          confidence: t.confidence || null,
          fallbackTrace: t.fallbackTrace,
          createdAt: t.createdAt.toISOString()
        };
      })
    });
  } catch (error) {
    return c.json({
      stats: {
        totalQueries: 0,
        avgCandidateCount: 0,
        avgSelectedCount: 0,
        selectionRate: 0,
        rewrittenQueries: 0,
        rewriteRate: 0,
        rewrittenQueriesWithSelection: 0,
        rawQueriesWithSelection: 0,
        rewrittenSelectionRate: 0,
        rawSelectionRate: 0,
        avgSelectedCountForRewrittenQueries: 0,
        avgSelectedCountForRawQueries: 0,
        strategyBreakdown: [],
      },
      traces: [],
      error: (error as Error).message
    }, 500);
  } finally {
    await memoryService.shutdown();
  }
});

// GET /api/stats/retrieval-review-queue - Prioritized privacy-safe retrieval traces that need review
statsRouter.get('/retrieval-review-queue', async (c) => {
  const limit = parseStatsLimit(c.req.query('limit'), 10, 50);
  const scanLimit = parseStatsLimit(c.req.query('scanLimit'), 500, 5000);
  const memoryService = getLightweightServiceFromQuery(c);

  try {
    await memoryService.initialize();
    const traces = await memoryService.getRecentRetrievalTraces(scanLimit);
    return c.json({
      ...buildRetrievalReviewQueue(traces, limit),
      limits: {
        requestedLimit: limit,
        scanLimit,
        scannedTraces: traces.length,
      }
    });
  } catch (error) {
    console.error('Failed to build retrieval review queue');
    return c.json({
      summary: {
        totalTraces: 0,
        reviewItems: 0,
        returnedItems: 0,
        candidateNoSelection: 0,
        emptyCandidateSet: 0,
        rewrittenNoSelection: 0,
        lowSelectionRate: 0,
      },
      items: [],
      error: 'Unable to build retrieval review queue'
    }, 500);
  } finally {
    await memoryService.shutdown();
  }
});

// GET /api/stats/kpi - Productivity KPI summary + trend
statsRouter.get('/kpi', async (c) => {
  const rawWindow = (c.req.query('window') || '7d') as KpiWindow;
  const window: KpiWindow = rawWindow === '24h' || rawWindow === '30d' ? rawWindow : '7d';
  const memoryService = getLightweightServiceFromQuery(c);

  try {
    await memoryService.initialize();
    const now = Date.now();
    const thresholds = loadKpiThresholds();
    const allEvents = await memoryService.getRecentEvents(20000);
    const events = allEvents.filter((e) => inWindow(e, now, window));

    const helpfulness = await memoryService.getHelpfulnessStats();
    const usefulRecallRate = helpfulness.totalEvaluated > 0
      ? round(safeRatio(helpfulness.helpful, helpfulness.totalEvaluated))
      : 0;

    const metrics = computeKpiMetrics(events, usefulRecallRate);

    const windowMs = windowToMs(window);
    const prevEvents = allEvents.filter((e) => {
      const age = now - e.timestamp.getTime();
      return age > windowMs && age <= windowMs * 2;
    });
    const previousMetrics = computeKpiMetrics(prevEvents, usefulRecallRate);
    const deltas = {
      memoryHitRate: round(metrics.memoryHitRate - previousMetrics.memoryHitRate),
      usefulRecallRate: round(metrics.usefulRecallRate - previousMetrics.usefulRecallRate),
      avgCompletionTurns: round(metrics.avgCompletionTurns - previousMetrics.avgCompletionTurns, 2),
      timeToFirstValidEditMinutes: round(metrics.timeToFirstValidEditMinutes - previousMetrics.timeToFirstValidEditMinutes, 2),
      reworkRate: round(metrics.reworkRate - previousMetrics.reworkRate),
      postChangeFailureRate: round(metrics.postChangeFailureRate - previousMetrics.postChangeFailureRate)
    };

    const THIRTY_MIN_MS = 30 * 60 * 1000;

    // Trend (daily buckets for last 30 days)
    const trendWindowMs = 30 * 24 * 60 * 60 * 1000;
    const trendEvents = allEvents.filter((e) => now - e.timestamp.getTime() <= trendWindowMs);
    const buckets = new Map<string, MemoryEvent[]>();
    for (const e of trendEvents) {
      const day = e.timestamp.toISOString().split('T')[0];
      const arr = buckets.get(day) || [];
      arr.push(e);
      buckets.set(day, arr);
    }

    const trendDaily = Array.from(buckets.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, dayEvents]) => {
        const dayPrompts = dayEvents.filter((e) => e.eventType === 'user_prompt');
        const dayPromptCount = dayPrompts.length;
        const dayMemoryHit = dayPrompts.filter((p) => (p.metadata as any)?.adherence?.checked).length;

        // lightweight day rework/failure approximation
        const dayEdits = dayEvents.filter((e) => {
          const p = parseToolPayload(e);
          return Boolean(p?.toolName && isEditToolName(p.toolName) && p.success === true);
        });
        const dayEditActions = dayEdits
          .map((e) => {
            const p = parseToolPayload(e);
            return { sessionId: e.sessionId, timestamp: e.timestamp.getTime(), filePath: p?.filePath };
          })
          .filter((x) => Boolean(x.filePath));
        let dayReworkCount = 0;
        const dayBySessionFile = new Map<string, number>();
        for (const edit of dayEditActions) {
          const key = `${edit.sessionId}::${edit.filePath}`;
          const prev = dayBySessionFile.get(key);
          if (typeof prev === 'number' && edit.timestamp - prev <= THIRTY_MIN_MS) dayReworkCount++;
          dayBySessionFile.set(key, edit.timestamp);
        }
        const dayTests = dayEvents.filter((e) => {
          const p = parseToolPayload(e);
          return Boolean(p?.toolName && isTestLikeCommand(p.command));
        });
        const dayFailedTests = dayEvents.filter((e) => {
          const p = parseToolPayload(e);
          return Boolean(p?.toolName && isTestLikeCommand(p.command) && p.success === false);
        });

        const turnsBySession = new Map<string, MemoryEvent[]>();
        for (const e of dayEvents) {
          const arr = turnsBySession.get(e.sessionId) || [];
          arr.push(e);
          turnsBySession.set(e.sessionId, arr);
        }
        let dayTurnsTotal = 0;
        let dayTurnsSamples = 0;
        for (const sessionEvents of turnsBySession.values()) {
          const turns = computeSessionTurnCount(sessionEvents);
          if (turns > 0) {
            dayTurnsTotal += turns;
            dayTurnsSamples++;
          }
        }

        return {
          date,
          memoryHitRate: round(safeRatio(dayMemoryHit, dayPromptCount)),
          usefulRecallRate,
          reworkRate: round(safeRatio(dayReworkCount, dayEditActions.length)),
          postChangeFailureRate: round(safeRatio(dayFailedTests.length, dayTests.length)),
          avgCompletionTurns: round(safeRatio(dayTurnsTotal, dayTurnsSamples), 2)
        };
      });

    const alerts: Array<{ metric: string; level: 'warn'; message: string; value: number; threshold: number }> = [];
    if (metrics.usefulRecallRate < thresholds.usefulRecallRateMin) {
      alerts.push({ metric: 'usefulRecallRate', level: 'warn', message: 'Useful recall rate is below threshold', value: metrics.usefulRecallRate, threshold: thresholds.usefulRecallRateMin });
    }
    if (metrics.reworkRate > thresholds.reworkRateMax) {
      alerts.push({ metric: 'reworkRate', level: 'warn', message: 'Rework rate is above threshold', value: metrics.reworkRate, threshold: thresholds.reworkRateMax });
    }
    if (metrics.postChangeFailureRate > thresholds.postChangeFailureRateMax) {
      alerts.push({ metric: 'postChangeFailureRate', level: 'warn', message: 'Post-change failure rate is above threshold', value: metrics.postChangeFailureRate, threshold: thresholds.postChangeFailureRateMax });
    }
    if (metrics.avgCompletionTurns > thresholds.avgCompletionTurnsMax) {
      alerts.push({ metric: 'avgCompletionTurns', level: 'warn', message: 'Average completion turns is above threshold', value: metrics.avgCompletionTurns, threshold: thresholds.avgCompletionTurnsMax });
    }
    if (metrics.memoryHitRate < thresholds.memoryHitRateMin) {
      alerts.push({ metric: 'memoryHitRate', level: 'warn', message: 'Memory hit rate is below threshold', value: metrics.memoryHitRate, threshold: thresholds.memoryHitRateMin });
    }

    return c.json({
      window,
      metrics,
      previousMetrics,
      deltas,
      trend: {
        daily: trendDaily
      },
      thresholds,
      alerts
    });
  } catch (error) {
    return jsonError(c, error);
  } finally {
    await memoryService.shutdown();
  }
});

// POST /api/stats/graduation/run - Force graduation evaluation
statsRouter.post('/graduation/run', async (c) => {
  const memoryService = getServiceFromQuery(c);
  try {
    await memoryService.initialize();
    const result = await memoryService.forceGraduation();

    return c.json({
      success: true,
      evaluated: result.evaluated,
      graduated: result.graduated,
      byLevel: result.byLevel
    });
  } catch (error) {
    return c.json({
      success: false,
      error: (error as Error).message
    }, 500);
  } finally {
    await memoryService.shutdown();
  }
});

// GET /api/stats/graduation - Get graduation criteria info
statsRouter.get('/graduation', async (c) => {
  return c.json({
    criteria: {
      L0toL1: { minAccessCount: 1, minConfidence: 0.5, minCrossSessionRefs: 0, maxAgeDays: 30 },
      L1toL2: { minAccessCount: 3, minConfidence: 0.7, minCrossSessionRefs: 1, maxAgeDays: 60 },
      L2toL3: { minAccessCount: 5, minConfidence: 0.85, minCrossSessionRefs: 2, maxAgeDays: 90 },
      L3toL4: { minAccessCount: 10, minConfidence: 0.92, minCrossSessionRefs: 3, maxAgeDays: 180 }
    },
    description: {
      accessCount: 'Number of times the memory was retrieved/referenced',
      confidence: 'Match confidence score when retrieved (0.0-1.0)',
      crossSessionRefs: 'Number of different sessions that referenced this memory',
      maxAgeDays: 'Maximum days since last access (prevents stale promotion)'
    }
  });
});
