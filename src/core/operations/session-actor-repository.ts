import {
  sqliteAll,
  sqliteGet,
  sqliteRun,
  toDateFromSQLite,
  type SQLiteDatabase
} from '../sqlite-wrapper.js';
import {
  ListSessionActorsInputSchema,
  SessionActorSchema,
  SetSessionActorObservationPolicyInputSchema,
  UpsertSessionActorInputSchema,
  type SessionActor
} from '../types.js';
import { sanitizeGovernanceAuditValue } from './governance-audit.js';

interface SessionActorRow {
  project_hash: string;
  session_id: string;
  actor_id: string;
  role_in_session: string;
  observe_self: number;
  observe_others: number;
  joined_at: string;
  left_at: string | null;
  metadata_json: string | null;
}

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

function sanitizeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  return sanitizeGovernanceAuditValue(metadata) as Record<string, unknown>;
}

function rowToSessionActor(row: SessionActorRow): SessionActor {
  return SessionActorSchema.parse({
    projectHash: projectHashFromStorage(row.project_hash),
    sessionId: row.session_id,
    actorId: row.actor_id,
    roleInSession: row.role_in_session,
    observeSelf: Number(row.observe_self) === 1,
    observeOthers: Number(row.observe_others) === 1,
    joinedAt: toDateFromSQLite(row.joined_at),
    leftAt: row.left_at ? toDateFromSQLite(row.left_at) : undefined,
    metadata: parseJsonRecord(row.metadata_json)
  });
}

export class SessionActorRepository {
  constructor(private readonly db: SQLiteDatabase) {}

  async upsertMembership(input: unknown): Promise<SessionActor> {
    const parsed = UpsertSessionActorInputSchema.parse(input);
    const projectHash = projectHashToStorage(parsed.projectHash);
    const existing = this.get(projectHash, parsed.sessionId, parsed.actorId);
    const joinedAt = parsed.joinedAt?.toISOString() ?? existing?.joinedAt.toISOString() ?? new Date().toISOString();
    const leftAt = parsed.leftAt?.toISOString() ?? (existing?.leftAt ? existing.leftAt.toISOString() : null);
    const metadata = sanitizeMetadata(parsed.metadata);

    if (existing) {
      sqliteRun(
        this.db,
        `UPDATE session_actors
         SET role_in_session = ?, observe_self = ?, observe_others = ?, joined_at = ?, left_at = ?, metadata_json = ?
         WHERE project_hash = ? AND session_id = ? AND actor_id = ?`,
        [
          parsed.roleInSession,
          parsed.observeSelf ? 1 : 0,
          parsed.observeOthers ? 1 : 0,
          joinedAt,
          leftAt,
          metadata ? JSON.stringify(metadata) : null,
          projectHash,
          parsed.sessionId,
          parsed.actorId
        ]
      );
    } else {
      sqliteRun(
        this.db,
        `INSERT INTO session_actors (
          project_hash, session_id, actor_id, role_in_session, observe_self,
          observe_others, joined_at, left_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          projectHash,
          parsed.sessionId,
          parsed.actorId,
          parsed.roleInSession,
          parsed.observeSelf ? 1 : 0,
          parsed.observeOthers ? 1 : 0,
          joinedAt,
          leftAt,
          metadata ? JSON.stringify(metadata) : null
        ]
      );
    }

    const saved = this.get(projectHash, parsed.sessionId, parsed.actorId);
    if (!saved) throw new Error('session actor membership was not saved');
    return saved;
  }

  async listBySession(input: unknown): Promise<SessionActor[]> {
    const parsed = ListSessionActorsInputSchema.parse(input);
    const rows = sqliteAll<SessionActorRow>(
      this.db,
      `SELECT * FROM session_actors
       WHERE project_hash = ? AND session_id = ?
       ORDER BY role_in_session ASC, joined_at ASC
       LIMIT ?`,
      [projectHashToStorage(parsed.projectHash), parsed.sessionId, parsed.limit]
    );
    return rows.map(rowToSessionActor);
  }

  async setObservationPolicy(input: unknown): Promise<SessionActor> {
    const parsed = SetSessionActorObservationPolicyInputSchema.parse(input);
    const projectHash = projectHashToStorage(parsed.projectHash);
    const existing = this.get(projectHash, parsed.sessionId, parsed.actorId);
    if (!existing) {
      throw new Error('session actor membership not found');
    }
    sqliteRun(
      this.db,
      `UPDATE session_actors
       SET observe_self = ?, observe_others = ?
       WHERE project_hash = ? AND session_id = ? AND actor_id = ?`,
      [
        parsed.observeSelf ? 1 : 0,
        parsed.observeOthers ? 1 : 0,
        projectHash,
        parsed.sessionId,
        parsed.actorId
      ]
    );
    const saved = this.get(projectHash, parsed.sessionId, parsed.actorId);
    if (!saved) throw new Error('session actor membership not found after update');
    return saved;
  }

  private get(projectHash: string, sessionId: string, actorId: string): SessionActor | null {
    const row = sqliteGet<SessionActorRow>(
      this.db,
      `SELECT * FROM session_actors WHERE project_hash = ? AND session_id = ? AND actor_id = ?`,
      [projectHash, sessionId, actorId]
    );
    return row ? rowToSessionActor(row) : null;
  }
}
