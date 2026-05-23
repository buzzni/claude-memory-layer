import { createHash, randomUUID } from 'crypto';
import { z } from 'zod';

import {
  sqliteAll,
  sqliteGet,
  sqliteRun,
  toDateFromSQLite,
  type SQLiteDatabase
} from '../sqlite-wrapper.js';
import {
  CreatePerspectiveObservationInputSchema,
  DeletePerspectiveObservationInputSchema,
  ListPerspectiveObservationsBySourceInputSchema,
  PerspectiveObservationSchema,
  QueryPerspectiveObservationsInputSchema,
  type PerspectiveObservation
} from '../types.js';
import {
  sanitizeGovernanceAuditValue,
  writeGovernanceAuditEntry
} from './governance-audit.js';

interface PerspectiveObservationRow {
  observation_id: string;
  project_hash: string;
  observer_actor_id: string;
  observed_actor_id: string;
  session_id: string | null;
  level: string;
  content: string;
  confidence: number;
  source_event_ids_json: string;
  source_observation_ids_json: string;
  created_by: string;
  metadata_json: string | null;
  content_hash: string;
  source_hash: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

type ParsedObservationCreate = z.output<typeof CreatePerspectiveObservationInputSchema>;

function projectHashToStorage(projectHash: string | undefined): string {
  return projectHash ?? '';
}

function projectHashFromStorage(projectHash: string): string | undefined {
  return projectHash.length > 0 ? projectHash : undefined;
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeStoredString(value: string): string {
  const sanitized = sanitizeGovernanceAuditValue(value);
  return typeof sanitized === 'string' ? sanitized.trim() : String(value).trim();
}

function sanitizeStoredStringArray(values: string[]): string[] {
  return values.map(sanitizeStoredString).filter((value) => value.length > 0);
}

function sanitizeStoredRecord(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  return sanitizeGovernanceAuditValue(value) as Record<string, unknown>;
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function evidenceHash(sourceEventIds: string[], sourceObservationIds: string[]): string {
  return stableHash({
    sourceEventIds: [...sourceEventIds].sort(),
    sourceObservationIds: [...sourceObservationIds].sort()
  });
}

function rowToObservation(row: PerspectiveObservationRow): PerspectiveObservation {
  return PerspectiveObservationSchema.parse({
    observationId: row.observation_id,
    projectHash: projectHashFromStorage(row.project_hash),
    observerActorId: row.observer_actor_id,
    observedActorId: row.observed_actor_id,
    sessionId: row.session_id ?? undefined,
    level: row.level,
    content: row.content,
    confidence: Number(row.confidence),
    sourceEventIds: parseStringArray(row.source_event_ids_json),
    sourceObservationIds: parseStringArray(row.source_observation_ids_json),
    createdBy: row.created_by,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toDateFromSQLite(row.created_at),
    updatedAt: toDateFromSQLite(row.updated_at),
    deletedAt: row.deleted_at ? toDateFromSQLite(row.deleted_at) : undefined
  });
}

function sanitizedObservationSnapshot(observation: PerspectiveObservation): Record<string, unknown> {
  return sanitizeGovernanceAuditValue({
    observationId: observation.observationId,
    projectHash: observation.projectHash,
    observerActorId: observation.observerActorId,
    observedActorId: observation.observedActorId,
    sessionId: observation.sessionId,
    level: observation.level,
    content: observation.content,
    confidence: observation.confidence,
    sourceEventIds: observation.sourceEventIds,
    sourceObservationIds: observation.sourceObservationIds,
    createdBy: observation.createdBy,
    metadata: observation.metadata,
    createdAt: observation.createdAt.toISOString(),
    updatedAt: observation.updatedAt.toISOString(),
    deletedAt: observation.deletedAt?.toISOString()
  }) as Record<string, unknown>;
}

function queryScore(observation: PerspectiveObservation, terms: string[]): number {
  if (terms.length === 0) return 0;
  const haystack = [observation.content, observation.level, observation.sessionId ?? ''].join(' ').toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

export class PerspectiveObservationRepository {
  constructor(private readonly db: SQLiteDatabase) {}

  async create(input: unknown): Promise<PerspectiveObservation> {
    const parsed = CreatePerspectiveObservationInputSchema.parse(input);
    const projectHash = projectHashToStorage(parsed.projectHash);
    const observerActorId = sanitizeStoredString(parsed.observerActorId);
    const observedActorId = sanitizeStoredString(parsed.observedActorId);
    const sessionId = parsed.sessionId ? sanitizeStoredString(parsed.sessionId) : undefined;
    const content = sanitizeStoredString(parsed.content);
    const sourceEventIds = sanitizeStoredStringArray(parsed.sourceEventIds);
    const sourceObservationIds = sanitizeStoredStringArray(parsed.sourceObservationIds);
    const createdBy = parsed.createdBy;
    const actor = parsed.actor ? sanitizeStoredString(parsed.actor) : undefined;
    const now = new Date().toISOString();
    const observationId = parsed.observationId ?? randomUUID();
    const contentHash = stableHash(content);
    const sourceHash = evidenceHash(sourceEventIds, sourceObservationIds);
    const metadata = sanitizeStoredRecord(parsed.metadata);

    sqliteRun(
      this.db,
      `INSERT INTO perspective_observations (
        observation_id, project_hash, observer_actor_id, observed_actor_id, session_id,
        level, content, confidence, source_event_ids_json, source_observation_ids_json,
        created_by, metadata_json, content_hash, source_hash, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(project_hash, observer_actor_id, observed_actor_id, level, content_hash, source_hash)
      DO UPDATE SET
        confidence = excluded.confidence,
        session_id = excluded.session_id,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at,
        deleted_at = NULL`,
      [
        observationId,
        projectHash,
        observerActorId,
        observedActorId,
        sessionId ?? null,
        parsed.level,
        content,
        parsed.confidence,
        JSON.stringify(sourceEventIds),
        JSON.stringify(sourceObservationIds),
        createdBy,
        metadata ? JSON.stringify(metadata) : null,
        contentHash,
        sourceHash,
        now,
        now
      ]
    );

    const saved = this.getByUnique(
      projectHash,
      observerActorId,
      observedActorId,
      parsed.level,
      contentHash,
      sourceHash
    );
    if (!saved) throw new Error('perspective observation was not saved');
    await this.writeCreateAudit({ ...parsed, observerActorId, observedActorId, sessionId, content, sourceEventIds, sourceObservationIds, createdBy, actor, metadata }, saved);
    return saved;
  }

  async query(input: unknown): Promise<PerspectiveObservation[]> {
    const parsed = QueryPerspectiveObservationsInputSchema.parse(input);
    const clauses = ['project_hash = ?'];
    const params: unknown[] = [projectHashToStorage(parsed.projectHash)];

    if (parsed.observerActorId) {
      clauses.push('observer_actor_id = ?');
      params.push(parsed.observerActorId);
    }
    if (parsed.observedActorId) {
      clauses.push('observed_actor_id = ?');
      params.push(parsed.observedActorId);
    }
    if (parsed.sessionId) {
      clauses.push('(session_id = ? OR session_id IS NULL)');
      params.push(parsed.sessionId);
    }
    if (parsed.levels && parsed.levels.length > 0) {
      clauses.push(`level IN (${parsed.levels.map(() => '?').join(', ')})`);
      params.push(...parsed.levels);
    }
    if (!parsed.includeDeleted) {
      clauses.push('deleted_at IS NULL');
    }

    const rowLimit = parsed.query ? Math.min(parsed.limit * 5, 500) : parsed.limit;
    params.push(rowLimit);
    const rows = sqliteAll<PerspectiveObservationRow>(
      this.db,
      `SELECT * FROM perspective_observations
       WHERE ${clauses.join(' AND ')}
       ORDER BY confidence DESC, updated_at DESC
       LIMIT ?`,
      params
    );
    const observations = rows.map(rowToObservation);
    const terms = parsed.query
      ? parsed.query.toLowerCase().split(/\s+/).map((term) => term.trim()).filter(Boolean)
      : [];
    return observations
      .map((observation) => ({ observation, score: queryScore(observation, terms) }))
      .sort((a, b) => b.score - a.score || b.observation.confidence - a.observation.confidence || b.observation.updatedAt.getTime() - a.observation.updatedAt.getTime())
      .slice(0, parsed.limit)
      .map((item) => item.observation);
  }

  async listBySourceEvent(input: unknown): Promise<PerspectiveObservation[]> {
    const parsed = ListPerspectiveObservationsBySourceInputSchema.parse(input);
    const rows = sqliteAll<PerspectiveObservationRow>(
      this.db,
      `SELECT * FROM perspective_observations
       WHERE project_hash = ?
         AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1
           FROM json_each(perspective_observations.source_event_ids_json)
           WHERE json_each.value = ?
         )
       ORDER BY confidence DESC, updated_at DESC
       LIMIT ?`,
      [projectHashToStorage(parsed.projectHash), parsed.sourceEventId, parsed.limit]
    );
    return rows.map(rowToObservation);
  }

  async deleteSoft(input: unknown): Promise<PerspectiveObservation> {
    const parsed = DeletePerspectiveObservationInputSchema.parse(input);
    const projectHash = projectHashToStorage(parsed.projectHash);
    const before = this.get(projectHash, parsed.observationId);
    if (!before) throw new Error('perspective observation not found');
    const deletedAt = new Date().toISOString();
    sqliteRun(
      this.db,
      `UPDATE perspective_observations
       SET deleted_at = ?, updated_at = ?
       WHERE project_hash = ? AND observation_id = ?`,
      [deletedAt, deletedAt, projectHash, parsed.observationId]
    );
    const after = this.get(projectHash, parsed.observationId);
    if (!after) throw new Error('perspective observation not found after delete');
    await writeGovernanceAuditEntry(this.db, {
      operation: 'perspective_observation_delete',
      actor: parsed.actor,
      projectHash: parsed.projectHash,
      targetType: 'perspective_observation',
      targetId: parsed.observationId,
      beforeJson: sanitizedObservationSnapshot(before),
      afterJson: sanitizedObservationSnapshot(after),
      sourceEventIds: after.sourceEventIds
    });
    return after;
  }

  get(projectHash: string, observationId: string): PerspectiveObservation | null {
    const row = sqliteGet<PerspectiveObservationRow>(
      this.db,
      `SELECT * FROM perspective_observations WHERE project_hash = ? AND observation_id = ?`,
      [projectHash, observationId]
    );
    return row ? rowToObservation(row) : null;
  }

  private getByUnique(
    projectHash: string,
    observerActorId: string,
    observedActorId: string,
    level: string,
    contentHash: string,
    sourceHash: string
  ): PerspectiveObservation | null {
    const row = sqliteGet<PerspectiveObservationRow>(
      this.db,
      `SELECT * FROM perspective_observations
       WHERE project_hash = ? AND observer_actor_id = ? AND observed_actor_id = ?
         AND level = ? AND content_hash = ? AND source_hash = ?`,
      [projectHash, observerActorId, observedActorId, level, contentHash, sourceHash]
    );
    return row ? rowToObservation(row) : null;
  }

  private async writeCreateAudit(
    parsed: ParsedObservationCreate,
    after: PerspectiveObservation
  ): Promise<void> {
    await writeGovernanceAuditEntry(this.db, {
      operation: 'perspective_observation_create',
      actor: parsed.actor ?? parsed.createdBy,
      projectHash: parsed.projectHash,
      targetType: 'perspective_observation',
      targetId: after.observationId,
      afterJson: sanitizedObservationSnapshot(after),
      sourceEventIds: parsed.sourceEventIds
    });
  }
}
