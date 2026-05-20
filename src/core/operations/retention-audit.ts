import { applyPrivacyFilter } from '../privacy/filter.js';
import {
  sqliteAll,
  sqliteGet,
  toDateFromSQLite,
  type SQLiteDatabase
} from '../sqlite-wrapper.js';
import { ConfigSchema } from '../types.js';
import {
  evaluateRetentionPolicy,
  RETENTION_POLICY_VERSION,
  type RetentionDecision,
  type RetentionDryRunAction,
  type RetentionFacet,
  type RetentionMemoryLevel,
  type RetentionPolicyInput
} from './retention-policy.js';

const DEFAULT_AUDIT_LIMIT = 100;
const DEFAULT_SAMPLE_LIMIT = 20;
const PREVIEW_LIMIT = 180;
const POSIX_ABSOLUTE_PATH_PATTERN = /(^|[^A-Za-z0-9._\/\\-])\/(?!\/)[^\n\r"'<>|`]*/g;
const WINDOWS_DRIVE_PATH_PATTERN = /(^|[^A-Za-z0-9._\/\\-])(?:[A-Za-z]:[\\/][^\n\r"'<>|`]*)/g;
const WINDOWS_UNC_PATH_PATTERN = /(^|[^A-Za-z0-9._\/\\-])(?:\\\\[^\\/\s"'<>|`]+[\\/][^\n\r"'<>|`]*)/g;
const PRIVACY_CONFIG = ConfigSchema.parse({}).privacy;
const MEMORY_LEVELS = new Set<RetentionMemoryLevel>(['L0', 'L1', 'L2', 'L3', 'L4']);
const RETENTION_AUDIT_TARGET_TYPES = new Set(['event', 'entity', 'edge', 'consolidated_memory', 'lesson', 'action']);

export interface RetentionAuditOptions {
  projectHash: string;
  targetType?: string;
  targetId?: string;
  dryRun?: boolean;
  limit?: number;
  sampleLimit?: number;
  projectPath?: string;
  now?: Date | string | number;
}

export interface RetentionAuditDecisionCounts {
  keep: number;
  review: number;
  downgrade: number;
  quarantine: number;
  tombstone_candidate: number;
}

export interface RetentionAuditSample {
  targetType: 'event';
  targetId: string;
  eventType: string;
  decision: RetentionDecision;
  lifecycleScore: number;
  policyVersion: typeof RETENTION_POLICY_VERSION;
  dryRunAction: RetentionDryRunAction;
  reasonCodes: string[];
  redactedPreview: string;
}

export interface RetentionAuditReport {
  dryRun: true;
  projectHash: string;
  policyVersion: typeof RETENTION_POLICY_VERSION;
  scanned: number;
  limit: number;
  decisions: RetentionAuditDecisionCounts;
  wouldChange: number;
  samples: RetentionAuditSample[];
}

interface EventRow {
  id: string;
  event_type: string;
  timestamp: string;
  content: string;
  metadata: string | null;
  access_count: number | null;
  last_accessed_at: string | null;
}

interface FacetRow {
  target_id: string;
  dimension: string;
  value: string;
  confidence: number;
}

interface HelpfulnessRow {
  event_id: string;
  helpfulness_score: number | null;
  retrieval_score: number | null;
}

interface RetrievalTraceRow {
  selected_event_ids: string | null;
}

interface EvaluatedSample {
  sample: RetentionAuditSample;
  wouldChange: boolean;
}

export function runRetentionAudit(db: SQLiteDatabase, options: RetentionAuditOptions): RetentionAuditReport {
  const projectHash = normalizeProjectHash(options.projectHash);
  if (options.dryRun === false) {
    throw new Error('retention audit is dry-run only and must not mutate memory data');
  }

  const limit = normalizePositiveInteger(options.limit, DEFAULT_AUDIT_LIMIT, 'retention audit limit');
  const sampleLimit = normalizePositiveInteger(options.sampleLimit, DEFAULT_SAMPLE_LIMIT, 'retention audit sample limit');
  const targetType = normalizeOptionalRetentionTargetType(options.targetType);
  const targetId = normalizeOptionalTargetId(options.targetId);
  if (targetType && targetType !== 'event') {
    return emptyRetentionAuditReport(projectHash, limit);
  }
  const facetsByTarget = loadFacetsByTarget(db, projectHash);
  const helpfulnessByEvent = loadHelpfulnessByEvent(db);
  const retrievalCounts = loadRetrievalCounts(db, projectHash);
  const eventQueryParams: Array<string | number> = [projectHash];
  const targetIdClause = targetId ? ' AND id = ?' : '';
  if (targetId) eventQueryParams.push(targetId);
  eventQueryParams.push(limit);

  const eventRows = sqliteAll<EventRow>(
    db,
    `SELECT id, event_type, timestamp, content, metadata, access_count, last_accessed_at
     FROM events
     WHERE COALESCE(
       json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.scope.project.hash'),
       json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.projectHash')
     ) = ?${targetIdClause}
     ORDER BY timestamp DESC
     LIMIT ?`,
    eventQueryParams
  );

  const decisions = emptyDecisionCounts();
  const evaluatedSamples: EvaluatedSample[] = [];
  let scanned = 0;
  let wouldChange = 0;

  for (const row of eventRows) {
    const metadata = safeParseObject(row.metadata) ?? {};
    if (!belongsToProject(metadata, projectHash)) continue;

    scanned++;
    const facets = facetsByTarget.get(row.id) ?? [];
    const helpfulness = helpfulnessByEvent.get(row.id);
    const retrievalCount = Math.max(0, Number(row.access_count ?? 0)) + (retrievalCounts.get(row.id) ?? 0);
    const result = evaluateRetentionPolicy({
      targetType: 'event',
      targetId: row.id,
      projectHash,
      eventType: row.event_type,
      memoryLevel: memoryLevelFromMetadata(metadata),
      createdAt: toDateFromSQLite(row.timestamp),
      lastAccessedAt: row.last_accessed_at ? toDateFromSQLite(row.last_accessed_at) : null,
      retrievalCount,
      helpfulnessScore: helpfulness?.helpfulnessScore,
      adherenceScore: helpfulness?.adherenceScore,
      evidenceConfidence: evidenceConfidenceFromFacets(facets),
      metadata,
      facets
    } satisfies RetentionPolicyInput, { now: options.now });

    decisions[result.decision]++;
    if (result.dryRunDiff.wouldChange) wouldChange++;

    evaluatedSamples.push({
      wouldChange: result.dryRunDiff.wouldChange,
      sample: {
        targetType: 'event',
        targetId: row.id,
        eventType: row.event_type,
        decision: result.decision,
        lifecycleScore: result.lifecycleScore,
        policyVersion: result.policyVersion,
        dryRunAction: result.dryRunDiff.action,
        reasonCodes: result.reasons.map((reason) => reason.code),
        redactedPreview: redactedPreview(row.content, options.projectPath)
      }
    });
  }

  evaluatedSamples.sort((left, right) => {
    if (left.wouldChange !== right.wouldChange) return left.wouldChange ? -1 : 1;
    return left.sample.lifecycleScore - right.sample.lifecycleScore;
  });

  return {
    dryRun: true,
    projectHash,
    policyVersion: RETENTION_POLICY_VERSION,
    scanned,
    limit,
    decisions,
    wouldChange,
    samples: evaluatedSamples.slice(0, sampleLimit).map((entry) => entry.sample)
  };
}

export function emptyRetentionAuditReport(projectHash: string, limit = DEFAULT_AUDIT_LIMIT): RetentionAuditReport {
  return {
    dryRun: true,
    projectHash: normalizeProjectHash(projectHash),
    policyVersion: RETENTION_POLICY_VERSION,
    scanned: 0,
    limit: normalizePositiveInteger(limit, DEFAULT_AUDIT_LIMIT, 'retention audit limit'),
    decisions: emptyDecisionCounts(),
    wouldChange: 0,
    samples: []
  };
}

function loadFacetsByTarget(db: SQLiteDatabase, projectHash: string): Map<string, RetentionFacet[]> {
  if (!tableExists(db, 'memory_facets')) return new Map();
  const rows = sqliteAll<FacetRow>(
    db,
    `SELECT target_id, dimension, value, confidence
     FROM memory_facets
     WHERE target_type = 'event'
       AND project_hash = ?
       AND confidence > 0
     ORDER BY updated_at DESC`,
    [projectHash]
  );
  const facets = new Map<string, RetentionFacet[]>();
  for (const row of rows) {
    const current = facets.get(row.target_id) ?? [];
    current.push({
      dimension: row.dimension,
      value: row.value,
      confidence: Number(row.confidence)
    });
    facets.set(row.target_id, current);
  }
  return facets;
}

function loadHelpfulnessByEvent(db: SQLiteDatabase): Map<string, { helpfulnessScore?: number; adherenceScore?: number }> {
  if (!tableExists(db, 'memory_helpfulness')) return new Map();
  const rows = sqliteAll<HelpfulnessRow>(
    db,
    `SELECT event_id,
            AVG(helpfulness_score) AS helpfulness_score,
            AVG(retrieval_score) AS retrieval_score
     FROM memory_helpfulness
     GROUP BY event_id`,
    []
  );
  const helpfulness = new Map<string, { helpfulnessScore?: number; adherenceScore?: number }>();
  for (const row of rows) {
    helpfulness.set(row.event_id, {
      helpfulnessScore: normalizeScore(row.helpfulness_score),
      adherenceScore: normalizeScore(row.retrieval_score)
    });
  }
  return helpfulness;
}

function loadRetrievalCounts(db: SQLiteDatabase, projectHash: string): Map<string, number> {
  if (!tableExists(db, 'retrieval_traces')) return new Map();
  const rows = sqliteAll<RetrievalTraceRow>(
    db,
    `SELECT selected_event_ids
     FROM retrieval_traces
     WHERE project_hash = ?`,
    [projectHash]
  );
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const eventId of parseStringArray(row.selected_event_ids)) {
      counts.set(eventId, (counts.get(eventId) ?? 0) + 1);
    }
  }
  return counts;
}

function belongsToProject(metadata: Record<string, unknown>, projectHash: string): boolean {
  const currentHash = nestedString(metadata, ['scope', 'project', 'hash'])
    ?? nestedString(metadata, ['projectHash']);
  return currentHash === undefined || currentHash === projectHash;
}

function memoryLevelFromMetadata(metadata: Record<string, unknown>): RetentionMemoryLevel {
  const level = nestedString(metadata, ['memoryLevel'])
    ?? nestedString(metadata, ['memory', 'level'])
    ?? nestedString(metadata, ['level']);
  return MEMORY_LEVELS.has(level as RetentionMemoryLevel) ? level as RetentionMemoryLevel : 'L0';
}

function evidenceConfidenceFromFacets(facets: RetentionFacet[]): number | undefined {
  if (facets.some((facet) => facet.dimension === 'quality' && facet.value === 'verified' && facet.confidence > 0)) {
    return 0.9;
  }
  if (facets.some((facet) => facet.dimension === 'quality' && facet.value === 'disputed' && facet.confidence > 0)) {
    return 0.1;
  }
  return undefined;
}

function redactedPreview(content: string, projectPath?: string): string {
  return redactLocalPaths(applyPrivacyFilter(content, PRIVACY_CONFIG).content, projectPath)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PREVIEW_LIMIT);
}

function redactLocalPaths(content: string, projectPath?: string): string {
  let filtered = content;
  if (projectPath) {
    filtered = filtered.split(projectPath).join('[REDACTED]');
  }
  return [WINDOWS_UNC_PATH_PATTERN, WINDOWS_DRIVE_PATH_PATTERN, POSIX_ABSOLUTE_PATH_PATTERN].reduce(
    (current, pattern) => current.replace(pattern, (_match, prefix: string) => `${prefix}[REDACTED]`),
    filtered
  );
}

function tableExists(db: SQLiteDatabase, tableName: string): boolean {
  const row = sqliteGet<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [tableName]
  );
  return Boolean(row);
}

function emptyDecisionCounts(): RetentionAuditDecisionCounts {
  return {
    keep: 0,
    review: 0,
    downgrade: 0,
    quarantine: 0,
    tombstone_candidate: 0
  };
}

function normalizeProjectHash(value: string): string {
  const projectHash = value.trim();
  if (!/^[a-f0-9]{8}$/.test(projectHash)) {
    throw new Error('retention audit projectHash must be an 8-character lowercase hex hash');
  }
  return projectHash;
}

function normalizeOptionalRetentionTargetType(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const targetType = value.trim();
  if (!RETENTION_AUDIT_TARGET_TYPES.has(targetType)) {
    throw new Error('retention audit targetType is not supported');
  }
  return targetType;
}

function normalizeOptionalTargetId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const targetId = value.trim();
  return targetId.length > 0 ? targetId : undefined;
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0 || value > 10000) {
    throw new Error(`${label} must be a positive integer <= 10000`);
  }
  return value;
}

function normalizeScore(value: number | null): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
  } catch {
    return [];
  }
}

function safeParseObject(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function nestedString(root: Record<string, unknown>, path: string[]): string | undefined {
  let cursor: unknown = root;
  for (const key of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[key];
  }
  return typeof cursor === 'string' && cursor.length > 0 ? cursor : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
