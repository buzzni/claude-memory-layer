import { randomUUID } from 'crypto';

import {
  sqliteAll,
  sqliteGet,
  sqliteRun,
  toDateFromSQLite,
  type SQLiteDatabase
} from '../sqlite-wrapper.js';
import {
  ActionEdgeInputSchema,
  MemoryActionEdgeDstTypeSchema,
  MemoryActionEdgeRelTypeSchema,
  MemoryActionStatusSchema,
  ListActionsInputSchema,
  UpsertActionInputSchema,
  UpdateActionInputSchema,
  type ActionEdgeInput,
  type MemoryAction,
  type MemoryActionEdge,
  type UpsertActionInput,
  type UpdateActionInput
} from './actions.js';
import { writeGovernanceAuditEntry } from './governance-audit.js';

interface MemoryActionRow {
  action_id: string;
  project_hash: string;
  title: string;
  status: string;
  priority: number;
  source_event_ids: string;
  related_entity_ids: string;
  current_checkpoint_id: string | null;
  lease_id: string | null;
  created_at: string;
  updated_at: string;
}

interface MemoryActionEdgeRow {
  edge_id: string;
  src_action_id: string;
  rel_type: string;
  dst_type: string;
  dst_id: string;
  confidence: number;
  created_at: string;
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
  } catch {
    return [];
  }
}

function rowToAction(row: MemoryActionRow): MemoryAction {
  return {
    actionId: row.action_id,
    projectHash: row.project_hash,
    title: row.title,
    status: MemoryActionStatusSchema.parse(row.status),
    priority: Number(row.priority),
    sourceEventIds: parseStringArray(row.source_event_ids),
    relatedEntityIds: parseStringArray(row.related_entity_ids),
    currentCheckpointId: row.current_checkpoint_id ?? undefined,
    leaseId: row.lease_id ?? undefined,
    createdAt: toDateFromSQLite(row.created_at),
    updatedAt: toDateFromSQLite(row.updated_at)
  };
}

function rowToEdge(row: MemoryActionEdgeRow): MemoryActionEdge {
  return {
    edgeId: row.edge_id,
    srcActionId: row.src_action_id,
    relType: MemoryActionEdgeRelTypeSchema.parse(row.rel_type),
    dstType: MemoryActionEdgeDstTypeSchema.parse(row.dst_type),
    dstId: row.dst_id,
    confidence: Number(row.confidence),
    createdAt: toDateFromSQLite(row.created_at)
  };
}

function actionToAuditJson(action: MemoryAction): Record<string, unknown> {
  return {
    actionId: action.actionId,
    projectHash: action.projectHash,
    title: action.title,
    status: action.status,
    priority: action.priority,
    sourceEventIds: action.sourceEventIds,
    relatedEntityIds: action.relatedEntityIds,
    currentCheckpointId: action.currentCheckpointId,
    leaseId: action.leaseId,
    createdAt: action.createdAt.toISOString(),
    updatedAt: action.updatedAt.toISOString()
  };
}

export class ActionRepository {
  constructor(private readonly db: SQLiteDatabase) {}

  async upsert(input: unknown): Promise<MemoryAction> {
    const parsed = UpsertActionInputSchema.parse(input);
    const before = parsed.actionId ? this.get(parsed.actionId) : null;
    const now = new Date().toISOString();

    if (before) {
      if (before.projectHash !== parsed.projectHash) {
        throw new Error('action projectHash mismatch');
      }
      return this.update({
        actionId: before.actionId,
        projectHash: parsed.projectHash,
        title: parsed.title,
        status: parsed.status,
        priority: parsed.priority,
        sourceEventIds: parsed.sourceEventIds,
        relatedEntityIds: parsed.relatedEntityIds,
        currentCheckpointId: parsed.currentCheckpointId,
        leaseId: parsed.leaseId,
        actor: parsed.actor
      });
    }

    const actionId = parsed.actionId ?? randomUUID();
    sqliteRun(
      this.db,
      `INSERT INTO memory_actions (
        action_id, project_hash, title, status, priority, source_event_ids,
        related_entity_ids, current_checkpoint_id, lease_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        actionId,
        parsed.projectHash,
        parsed.title,
        parsed.status,
        parsed.priority,
        JSON.stringify(parsed.sourceEventIds),
        JSON.stringify(parsed.relatedEntityIds),
        parsed.currentCheckpointId ?? null,
        parsed.leaseId ?? null,
        now,
        now
      ]
    );

    const saved = this.require(actionId);
    await this.auditActionUpdate(parsed, null, saved);
    return saved;
  }

  async update(input: unknown): Promise<MemoryAction> {
    const parsed = UpdateActionInputSchema.parse(input);
    const before = this.require(parsed.actionId);
    if (before.projectHash !== parsed.projectHash) {
      throw new Error('action projectHash mismatch');
    }
    const updated: MemoryAction = {
      ...before,
      title: parsed.title ?? before.title,
      status: parsed.status ?? before.status,
      priority: parsed.priority ?? before.priority,
      sourceEventIds: parsed.sourceEventIds ?? before.sourceEventIds,
      relatedEntityIds: parsed.relatedEntityIds ?? before.relatedEntityIds,
      currentCheckpointId: parsed.currentCheckpointId === undefined ? before.currentCheckpointId : parsed.currentCheckpointId ?? undefined,
      leaseId: parsed.leaseId === undefined ? before.leaseId : parsed.leaseId ?? undefined,
      updatedAt: new Date()
    };

    sqliteRun(
      this.db,
      `UPDATE memory_actions
       SET title = ?, status = ?, priority = ?, source_event_ids = ?, related_entity_ids = ?,
           current_checkpoint_id = ?, lease_id = ?, updated_at = ?
       WHERE action_id = ? AND project_hash = ?`,
      [
        updated.title,
        updated.status,
        updated.priority,
        JSON.stringify(updated.sourceEventIds),
        JSON.stringify(updated.relatedEntityIds),
        updated.currentCheckpointId ?? null,
        updated.leaseId ?? null,
        updated.updatedAt.toISOString(),
        updated.actionId,
        updated.projectHash
      ]
    );

    const saved = this.require(parsed.actionId);
    await this.auditActionUpdate(parsed, before, saved);
    return saved;
  }

  get(actionId: string): MemoryAction | null {
    const row = sqliteGet<MemoryActionRow>(this.db, `SELECT * FROM memory_actions WHERE action_id = ?`, [actionId]);
    return row ? rowToAction(row) : null;
  }

  async list(input: unknown): Promise<MemoryAction[]> {
    const parsed = ListActionsInputSchema.parse(input);
    const clauses = ['project_hash = ?'];
    const params: unknown[] = [parsed.projectHash];
    if (parsed.status) {
      clauses.push('status = ?');
      params.push(parsed.status);
    } else if (!parsed.includeTerminal) {
      clauses.push(`status NOT IN ('done', 'cancelled')`);
    }
    params.push(parsed.limit);
    const whereClause = clauses.join(' AND ');
    const sql = 'SELECT * FROM memory_actions WHERE ' + whereClause + ' ORDER BY priority DESC, updated_at DESC LIMIT ?';
    return sqliteAll<MemoryActionRow>(this.db, sql, params).map(rowToAction);
  }

  async addEdge(input: unknown): Promise<MemoryActionEdge> {
    const parsed = ActionEdgeInputSchema.parse(input);
    const existing = this.findEdge(parsed);
    if (existing) {
      sqliteRun(this.db, `UPDATE memory_action_edges SET confidence = ? WHERE edge_id = ?`, [parsed.confidence, existing.edgeId]);
      return this.requireEdge(existing.edgeId);
    }

    const edgeId = randomUUID();
    sqliteRun(
      this.db,
      `INSERT INTO memory_action_edges (edge_id, src_action_id, rel_type, dst_type, dst_id, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [edgeId, parsed.srcActionId, parsed.relType, parsed.dstType, parsed.dstId, parsed.confidence, new Date().toISOString()]
    );
    return this.requireEdge(edgeId);
  }

  private require(actionId: string): MemoryAction {
    const action = this.get(actionId);
    if (!action) throw new Error(`Memory action not found: ${actionId}`);
    return action;
  }

  private requireEdge(edgeId: string): MemoryActionEdge {
    const row = sqliteGet<MemoryActionEdgeRow>(this.db, `SELECT * FROM memory_action_edges WHERE edge_id = ?`, [edgeId]);
    if (!row) throw new Error(`Memory action edge not found: ${edgeId}`);
    return rowToEdge(row);
  }

  private findEdge(input: ActionEdgeInput): MemoryActionEdge | null {
    const row = sqliteGet<MemoryActionEdgeRow>(
      this.db,
      `SELECT * FROM memory_action_edges WHERE src_action_id = ? AND rel_type = ? AND dst_type = ? AND dst_id = ?`,
      [input.srcActionId, input.relType, input.dstType, input.dstId]
    );
    return row ? rowToEdge(row) : null;
  }

  private async auditActionUpdate(
    input: UpsertActionInput | UpdateActionInput,
    before: MemoryAction | null,
    after: MemoryAction
  ): Promise<void> {
    await writeGovernanceAuditEntry(this.db, {
      operation: 'action_update',
      actor: input.actor ?? 'cml-core',
      projectHash: after.projectHash,
      targetType: 'action',
      targetId: after.actionId,
      beforeJson: before ? actionToAuditJson(before) : undefined,
      afterJson: actionToAuditJson(after),
      sourceEventIds: 'sourceEventIds' in input ? input.sourceEventIds : []
    });
  }
}
