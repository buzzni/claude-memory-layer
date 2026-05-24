import {
  sqliteAll,
  sqliteGet,
  type SQLiteDatabase,
  toDateFromSQLite
} from '../sqlite-wrapper.js';
import type {
  EventType,
  MemoryActorKind,
  MemoryEvent,
  SessionActorRole,
  UpsertMemoryActorInput
} from '../types.js';
import {
  ActorRepository,
  buildMemoryActorId,
  projectMemoryActorFromEvent
} from './actor-repository.js';
import { SessionActorRepository } from './session-actor-repository.js';

interface EventBackfillRow {
  id: string;
  event_type: EventType;
  session_id: string;
  timestamp: string;
  content: string;
  canonical_key: string;
  dedupe_key: string;
  metadata: string | null;
}

export interface PerspectiveSessionActorBackfillOptions {
  projectHash?: string;
  dryRun?: boolean;
  sessionId?: string;
  limit?: number;
  sampleLimit?: number;
}

export interface PerspectiveSessionActorBackfillSample {
  action: 'would-create' | 'created' | 'exists';
  eventId: string;
  sessionId: string;
  eventType: EventType;
  actorKind: MemoryActorKind;
  roleInSession: SessionActorRole;
}

export interface PerspectiveSessionActorBackfillResult {
  dryRun: boolean;
  projectHash?: string;
  scannedEvents: number;
  scannedSessions: number;
  existingActors: number;
  actorsCreated: number;
  actorsWouldCreate: number;
  existingMemberships: number;
  membershipsCreated: number;
  membershipsWouldCreate: number;
  samples: PerspectiveSessionActorBackfillSample[];
}

const DEFAULT_EVENT_LIMIT = 10_000;
const DEFAULT_SAMPLE_LIMIT = 10;

export async function backfillPerspectiveSessionActors(
  db: SQLiteDatabase,
  options: PerspectiveSessionActorBackfillOptions = {}
): Promise<PerspectiveSessionActorBackfillResult> {
  const dryRun = options.dryRun !== false;
  const projectHash = normalizeOptionalString(options.projectHash);
  const sessionId = normalizeOptionalString(options.sessionId);
  const limit = clampInteger(options.limit, DEFAULT_EVENT_LIMIT, 1, 100_000);
  const sampleLimit = clampInteger(options.sampleLimit, DEFAULT_SAMPLE_LIMIT, 0, 100);
  const actors = new ActorRepository(db);
  const sessions = new SessionActorRepository(db);
  const rows = loadBackfillEvents(db, { projectHash, sessionId, limit });
  const scannedSessionIds = new Set<string>();
  const processedActorIds = new Set<string>();
  const processedMemberships = new Set<string>();
  const samples: PerspectiveSessionActorBackfillSample[] = [];

  let existingActors = 0;
  let actorsCreated = 0;
  let actorsWouldCreate = 0;
  let existingMemberships = 0;
  let membershipsCreated = 0;
  let membershipsWouldCreate = 0;

  for (const row of rows) {
    scannedSessionIds.add(row.session_id);
    const event = rowToMemoryEvent(row);
    const actorInput = projectMemoryActorFromEvent(event, { projectHash });
    const actorId = buildMemoryActorId(actorInput);
    const actorKind = normalizeActorKind(actorInput.kind);
    const roleInSession = roleForEvent(event.eventType);

    if (!processedActorIds.has(actorId)) {
      processedActorIds.add(actorId);
      const existingActor = actors.get(actorId);
      if (existingActor) {
        existingActors += 1;
      } else if (dryRun) {
        actorsWouldCreate += 1;
      } else {
        await actors.upsert(actorInput);
        actorsCreated += 1;
      }
    }

    const membershipKey = `${projectHash ?? ''}\u0000${event.sessionId}\u0000${actorId}`;
    if (processedMemberships.has(membershipKey)) continue;
    processedMemberships.add(membershipKey);

    const existingMembership = membershipExists(db, projectHash, event.sessionId, actorId);
    if (existingMembership) {
      existingMemberships += 1;
      pushSample(samples, sampleLimit, {
        action: 'exists',
        eventId: event.id,
        sessionId: event.sessionId,
        eventType: event.eventType,
        actorKind,
        roleInSession
      });
      continue;
    }

    if (dryRun) {
      membershipsWouldCreate += 1;
      pushSample(samples, sampleLimit, {
        action: 'would-create',
        eventId: event.id,
        sessionId: event.sessionId,
        eventType: event.eventType,
        actorKind,
        roleInSession
      });
      continue;
    }

    await sessions.upsertMembership({
      projectHash,
      sessionId: event.sessionId,
      actorId,
      roleInSession,
      ...observationPolicyForRole(roleInSession),
      joinedAt: event.timestamp,
      metadata: {
        source: 'perspective-session-actor-backfill',
        sourceEventType: event.eventType
      }
    });
    membershipsCreated += 1;
    pushSample(samples, sampleLimit, {
      action: 'created',
      eventId: event.id,
      sessionId: event.sessionId,
      eventType: event.eventType,
      actorKind,
      roleInSession
    });
  }

  return {
    dryRun,
    projectHash,
    scannedEvents: rows.length,
    scannedSessions: scannedSessionIds.size,
    existingActors,
    actorsCreated,
    actorsWouldCreate,
    existingMemberships,
    membershipsCreated,
    membershipsWouldCreate,
    samples
  };
}

function loadBackfillEvents(
  db: SQLiteDatabase,
  options: { projectHash?: string; sessionId?: string; limit: number }
): EventBackfillRow[] {
  const clauses: string[] = [
    `COALESCE(json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.quarantine.status'), '') != 'active'`
  ];
  const params: unknown[] = [];
  if (options.projectHash) {
    clauses.push(`COALESCE(json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.scope.project.hash'), '') IN ('', ?)`);
    params.push(options.projectHash);
  }
  if (options.sessionId) {
    clauses.push('session_id = ?');
    params.push(options.sessionId);
  }
  params.push(options.limit);
  return sqliteAll<EventBackfillRow>(
    db,
    `SELECT id, event_type, session_id, timestamp, content, canonical_key, dedupe_key, metadata
     FROM events
     ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY timestamp ASC, rowid ASC
     LIMIT ?`,
    params
  );
}

function rowToMemoryEvent(row: EventBackfillRow): MemoryEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    sessionId: row.session_id,
    timestamp: toDateFromSQLite(row.timestamp),
    content: row.content,
    canonicalKey: row.canonical_key,
    dedupeKey: row.dedupe_key,
    metadata: parseJsonRecord(row.metadata)
  };
}

function parseJsonRecord(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function membershipExists(
  db: SQLiteDatabase,
  projectHash: string | undefined,
  sessionId: string,
  actorId: string
): boolean {
  const row = sqliteGet<{ actor_id: string }>(
    db,
    `SELECT actor_id FROM session_actors WHERE project_hash = ? AND session_id = ? AND actor_id = ?`,
    [projectHash ?? '', sessionId, actorId]
  );
  return Boolean(row?.actor_id);
}

function roleForEvent(eventType: EventType): SessionActorRole {
  if (eventType === 'user_prompt') return 'speaker';
  if (eventType === 'agent_response') return 'assistant';
  if (eventType === 'tool_observation') return 'tool';
  if (eventType === 'session_summary') return 'system';
  return 'unknown';
}

function observationPolicyForRole(role: SessionActorRole): { observeSelf: boolean; observeOthers: boolean } {
  if (role === 'assistant' || role === 'observer') return { observeSelf: true, observeOthers: true };
  if (role === 'speaker') return { observeSelf: true, observeOthers: false };
  return { observeSelf: false, observeOthers: false };
}

function normalizeActorKind(kind: UpsertMemoryActorInput['kind']): MemoryActorKind {
  return kind ?? 'unknown';
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : undefined;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(Number(value))));
}

function pushSample(
  samples: PerspectiveSessionActorBackfillSample[],
  sampleLimit: number,
  sample: PerspectiveSessionActorBackfillSample
): void {
  if (samples.length >= sampleLimit) return;
  samples.push(sample);
}
