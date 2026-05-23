import { z } from 'zod';

import {
  sqliteAll,
  sqliteGet,
  sqliteRun,
  toDateFromSQLite,
  type SQLiteDatabase
} from '../sqlite-wrapper.js';
import {
  ListMemoryActorsInputSchema,
  MemoryActorSchema,
  UpsertMemoryActorInputSchema,
  type MemoryActor,
  type MemoryActorKind,
  type MemoryEvent
} from '../types.js';
import { sanitizeGovernanceAuditValue } from './governance-audit.js';

interface MemoryActorRow {
  actor_id: string;
  project_hash: string;
  kind: MemoryActorKind;
  display_name: string;
  source: string;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

type ParsedActorUpsert = z.output<typeof UpsertMemoryActorInputSchema>;

function projectHashToStorage(projectHash: string | undefined): string {
  return projectHash ?? '';
}

function projectHashFromStorage(projectHash: string): string | undefined {
  return projectHash.length > 0 ? projectHash : undefined;
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

function sanitizeString(value: string): string {
  return String(sanitizeGovernanceAuditValue(value)).trim();
}

function sanitizeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  return sanitizeGovernanceAuditValue(metadata) as Record<string, unknown>;
}

function slugActorPart(value: string): string {
  const slug = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9가-힣_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug.length > 0 ? slug : 'unknown';
}

function stableActorId(input: ParsedActorUpsert): string {
  if (input.actorId) return sanitizeString(input.actorId);
  const projectPart = input.projectHash ? `project:${slugActorPart(input.projectHash)}` : 'global';
  return [
    'actor',
    projectPart,
    slugActorPart(input.source),
    input.kind,
    slugActorPart(input.displayName)
  ].join(':');
}

function rowToActor(row: MemoryActorRow): MemoryActor {
  return MemoryActorSchema.parse({
    actorId: row.actor_id,
    projectHash: projectHashFromStorage(row.project_hash),
    kind: row.kind,
    displayName: row.display_name,
    source: row.source,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toDateFromSQLite(row.created_at),
    updatedAt: toDateFromSQLite(row.updated_at)
  });
}

function metadataString(metadata: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!metadata) return undefined;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function metadataRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export class ActorRepository {
  constructor(private readonly db: SQLiteDatabase) {}

  async upsert(input: unknown): Promise<MemoryActor> {
    const parsed = UpsertMemoryActorInputSchema.parse(input);
    const actorId = stableActorId(parsed);
    const projectHash = sanitizeString(projectHashToStorage(parsed.projectHash));
    const displayName = sanitizeString(parsed.displayName);
    const source = sanitizeString(parsed.source);
    const metadata = sanitizeMetadata(parsed.metadata);
    const existing = this.get(actorId);
    const now = new Date().toISOString();

    if (existing && projectHashToStorage(existing.projectHash) !== projectHash) {
      throw new Error('actor projectHash mismatch');
    }

    if (existing) {
      sqliteRun(
        this.db,
        `UPDATE memory_actors
         SET kind = ?, display_name = ?, source = ?, metadata_json = ?, updated_at = ?
         WHERE actor_id = ?`,
        [
          parsed.kind,
          displayName,
          source,
          metadata ? JSON.stringify(metadata) : null,
          now,
          actorId
        ]
      );
      return this.require(actorId);
    }

    sqliteRun(
      this.db,
      `INSERT INTO memory_actors (
        actor_id, project_hash, kind, display_name, source, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        actorId,
        projectHash,
        parsed.kind,
        displayName,
        source,
        metadata ? JSON.stringify(metadata) : null,
        now,
        now
      ]
    );
    return this.require(actorId);
  }

  get(actorId: string): MemoryActor | null {
    const row = sqliteGet<MemoryActorRow>(this.db, `SELECT * FROM memory_actors WHERE actor_id = ?`, [actorId]);
    return row ? rowToActor(row) : null;
  }

  require(actorId: string): MemoryActor {
    const actor = this.get(actorId);
    if (!actor) throw new Error(`Memory actor not found: ${actorId}`);
    return actor;
  }

  async list(input: unknown = {}): Promise<MemoryActor[]> {
    const parsed = ListMemoryActorsInputSchema.parse(input);
    const clauses = ['project_hash = ?'];
    const params: unknown[] = [projectHashToStorage(parsed.projectHash)];
    if (parsed.kind) {
      clauses.push('kind = ?');
      params.push(parsed.kind);
    }
    if (parsed.source) {
      clauses.push('source = ?');
      params.push(parsed.source);
    }
    params.push(parsed.limit);
    const rows = sqliteAll<MemoryActorRow>(
      this.db,
      `SELECT * FROM memory_actors WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC, display_name ASC LIMIT ?`,
      params
    );
    return rows.map(rowToActor);
  }

  async resolveFromEvent(event: MemoryEvent, options: { projectHash?: string } = {}): Promise<MemoryActor> {
    const metadata = metadataRecord(event.metadata);
    const source = metadataString(metadata, ['source', 'importSource', 'platform', 'provider']) ?? 'event';
    const model = metadataString(metadata, ['model', 'modelName']);

    if (event.eventType === 'user_prompt') {
      return this.upsert({
        projectHash: options.projectHash,
        kind: 'user',
        displayName: metadataString(metadata, ['displayName', 'userName', 'username', 'user_id', 'userId']) ?? 'User',
        source,
        metadata: { eventType: event.eventType, ...metadata }
      });
    }

    if (event.eventType === 'agent_response') {
      return this.upsert({
        projectHash: options.projectHash,
        kind: 'assistant',
        displayName: metadataString(metadata, ['displayName', 'agentName', 'assistantName']) ?? model ?? 'Assistant',
        source,
        metadata: { eventType: event.eventType, ...metadata }
      });
    }

    if (event.eventType === 'tool_observation') {
      return this.upsert({
        projectHash: options.projectHash,
        kind: 'tool',
        displayName: metadataString(metadata, ['toolName', 'tool_name', 'name']) ?? 'Tool',
        source,
        metadata: { eventType: event.eventType, ...metadata }
      });
    }

    return this.upsert({
      projectHash: options.projectHash,
      kind: 'system',
      displayName: metadataString(metadata, ['displayName', 'source']) ?? 'Session summary',
      source,
      metadata: { eventType: event.eventType, ...metadata }
    });
  }
}
