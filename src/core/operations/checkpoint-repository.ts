import { randomUUID } from 'crypto';

import {
  sqliteAll,
  sqliteGet,
  sqliteRun,
  toDateFromSQLite,
  type SQLiteDatabase
} from '../sqlite-wrapper.js';
import {
  CreateCheckpointInputSchema,
  ListCheckpointsInputSchema,
  type MemoryCheckpoint
} from './actions.js';
import { sanitizeGovernanceAuditValue, writeGovernanceAuditEntry } from './governance-audit.js';

interface MemoryCheckpointRow {
  checkpoint_id: string;
  project_hash: string;
  action_id: string | null;
  session_id: string | null;
  title: string;
  summary: string;
  state_json: string;
  source_event_ids: string;
  created_at: string;
  expires_at: string | null;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
  } catch {
    return [];
  }
}

function rowToCheckpoint(row: MemoryCheckpointRow): MemoryCheckpoint {
  return {
    checkpointId: row.checkpoint_id,
    projectHash: row.project_hash,
    actionId: row.action_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    title: row.title,
    summary: row.summary,
    stateJson: parseJsonObject(row.state_json),
    sourceEventIds: parseStringArray(row.source_event_ids),
    createdAt: toDateFromSQLite(row.created_at),
    expiresAt: row.expires_at ? toDateFromSQLite(row.expires_at) : undefined
  };
}

function checkpointToAuditJson(checkpoint: MemoryCheckpoint): Record<string, unknown> {
  return {
    checkpointId: checkpoint.checkpointId,
    projectHash: checkpoint.projectHash,
    actionId: checkpoint.actionId,
    sessionId: checkpoint.sessionId,
    title: checkpoint.title,
    summary: checkpoint.summary,
    stateJson: checkpoint.stateJson,
    sourceEventIds: checkpoint.sourceEventIds,
    createdAt: checkpoint.createdAt.toISOString(),
    expiresAt: checkpoint.expiresAt?.toISOString()
  };
}

export class CheckpointRepository {
  constructor(private readonly db: SQLiteDatabase) {}

  async create(input: unknown): Promise<MemoryCheckpoint> {
    const parsed = CreateCheckpointInputSchema.parse(input);
    const checkpointId = parsed.checkpointId ?? randomUUID();
    const now = new Date().toISOString();
    const stateJson = sanitizeGovernanceAuditValue(parsed.stateJson) as Record<string, unknown>;

    sqliteRun(
      this.db,
      `INSERT INTO memory_checkpoints (
        checkpoint_id, project_hash, action_id, session_id, title, summary,
        state_json, source_event_ids, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        checkpointId,
        parsed.projectHash,
        parsed.actionId ?? null,
        parsed.sessionId ?? null,
        parsed.title,
        parsed.summary,
        JSON.stringify(stateJson),
        JSON.stringify(parsed.sourceEventIds),
        now,
        parsed.expiresAt?.toISOString() ?? null
      ]
    );

    const saved = this.require(checkpointId);
    await writeGovernanceAuditEntry(this.db, {
      operation: 'checkpoint_create',
      actor: parsed.actor ?? 'cml-core',
      projectHash: saved.projectHash,
      targetType: 'checkpoint',
      targetId: saved.checkpointId,
      afterJson: checkpointToAuditJson(saved),
      sourceEventIds: saved.sourceEventIds
    });
    return saved;
  }

  async list(input: unknown): Promise<MemoryCheckpoint[]> {
    const parsed = ListCheckpointsInputSchema.parse(input);
    const clauses = ['project_hash = ?'];
    const params: unknown[] = [parsed.projectHash];
    if (parsed.actionId) {
      clauses.push('action_id = ?');
      params.push(parsed.actionId);
    }
    if (parsed.sessionId) {
      clauses.push('session_id = ?');
      params.push(parsed.sessionId);
    }
    params.push(parsed.limit);
    const whereClause = clauses.join(' AND ');
    const sql = 'SELECT * FROM memory_checkpoints WHERE ' + whereClause + ' ORDER BY created_at DESC LIMIT ?';
    return sqliteAll<MemoryCheckpointRow>(this.db, sql, params).map(rowToCheckpoint);
  }

  get(checkpointId: string): MemoryCheckpoint | null {
    const row = sqliteGet<MemoryCheckpointRow>(this.db, `SELECT * FROM memory_checkpoints WHERE checkpoint_id = ?`, [checkpointId]);
    return row ? rowToCheckpoint(row) : null;
  }

  private require(checkpointId: string): MemoryCheckpoint {
    const checkpoint = this.get(checkpointId);
    if (!checkpoint) throw new Error(`Memory checkpoint not found: ${checkpointId}`);
    return checkpoint;
  }
}
