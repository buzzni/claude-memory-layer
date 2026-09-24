import { createHash } from 'crypto';
import { z } from 'zod';

import {
  sqliteAll,
  sqliteGet,
  sqliteRun,
  type SQLiteDatabase
} from '../sqlite-wrapper.js';
import { ActionRepository } from './action-repository.js';
import {
  MemoryActionStatusSchema,
  type MemoryAction,
  type MemoryActionStatus
} from './actions.js';

const NonEmptyStringSchema = z.string().transform((value) => value.trim()).pipe(z.string().min(1));

export const ProjectTaskActionsInputSchema = z.object({
  projectHash: NonEmptyStringSchema,
  project: NonEmptyStringSchema.optional(),
  actor: NonEmptyStringSchema.optional(),
  limit: z.number().int().positive().max(500).default(100)
});
export type ProjectTaskActionsInput = z.infer<typeof ProjectTaskActionsInputSchema>;

export interface ProjectTaskActionsResult {
  scanned: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  actions: MemoryAction[];
}

interface TaskEntityRow {
  entity_id: string;
  title: string;
  current_json: string;
}

interface EntityEdgeRow {
  rel_type: string;
  dst_type: string;
  dst_id: string;
  meta_json: string | null;
}

interface MemoryActionEdgeRow {
  edge_id: string;
  dst_type: string;
  dst_id: string;
}

interface EntityProjectRow {
  entity_type: string;
  current_json: string;
}

const TASK_EVENT_TYPES = [
  'task_created',
  'task_status_changed',
  'task_priority_changed',
  'task_blockers_set',
  'task_transition_rejected'
] as const;

const PRIORITY_SCORE: Record<string, number> = {
  low: 25,
  medium: 50,
  high: 75,
  critical: 100
};

export class TaskActionProjector {
  constructor(
    private readonly db: SQLiteDatabase,
    private readonly actions: ActionRepository = new ActionRepository(db)
  ) {}

  async project(input: unknown): Promise<ProjectTaskActionsResult> {
    const parsed = ProjectTaskActionsInputSchema.parse(input);
    const empty = (): ProjectTaskActionsResult => ({
      scanned: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      actions: []
    });

    if (!parsed.project || !this.tableExists('entities')) return empty();
    const scopedInput = { ...parsed, project: parsed.project };

    const rows = this.listTaskEntities(scopedInput.project, scopedInput.limit);
    const result = empty();
    result.scanned = rows.length;

    for (const row of rows) {
      const projected = await this.projectTaskRow(row, scopedInput);
      if (!projected) {
        result.skipped += 1;
        continue;
      }
      result[projected.kind] += 1;
      result.actions.push(projected.action);
    }

    return result;
  }

  private async projectTaskRow(
    row: TaskEntityRow,
    input: ProjectTaskActionsInput & { project: string }
  ): Promise<{ kind: 'created' | 'updated' | 'unchanged'; action: MemoryAction } | null> {
    const current = parseJsonObject(row.current_json);
    if (!current) return null;
    if (current.project !== input.project) return null;

    const actionId = actionIdForTaskEntity(row.entity_id);
    const before = this.actions.get(actionId);
    if (before && before.projectHash !== input.projectHash) return null;

    const desired = {
      actionId,
      projectHash: input.projectHash,
      title: row.title,
      status: parseActionStatus(current.status),
      priority: priorityToScore(current.priority),
      sourceEventIds: this.existingEventIds(uniqueStrings([
        ...extractStringArray(current.sourceEventIds),
        ...this.sourceTaskEventIds(row.entity_id)
      ])),
      relatedEntityIds: [row.entity_id],
      actor: input.actor ?? 'cml-core'
    };

    let action: MemoryAction;
    let kind: 'created' | 'updated' | 'unchanged';
    if (!before) {
      action = await this.actions.upsert(desired);
      kind = 'created';
    } else if (actionMatchesDesired(before, desired)) {
      action = before;
      kind = 'unchanged';
    } else {
      action = await this.actions.update(desired);
      kind = 'updated';
    }

    await this.syncBlockerEdges({ actionId: action.actionId, entityId: row.entity_id, project: input.project });
    return { kind, action };
  }

  private tableExists(tableName: string): boolean {
    const row = sqliteGet<{ name: string }>(
      this.db,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      [tableName]
    );
    return Boolean(row);
  }

  private listTaskEntities(project: string, limit: number): TaskEntityRow[] {
    return sqliteAll<TaskEntityRow>(
      this.db,
      `SELECT entity_id, title, current_json
       FROM entities
       WHERE entity_type = 'task'
         AND status = 'active'
         AND CASE
           WHEN json_valid(current_json) THEN json_extract(current_json, '$.project')
           ELSE NULL
         END = ?
       ORDER BY updated_at DESC
       LIMIT ?`,
      [project, limit]
    );
  }

  private sourceTaskEventIds(taskId: string): string[] {
    const keys = TASK_EVENT_TYPES.map((eventType) => `task_event:${eventType}:${taskId}`);
    if (keys.length === 0) return [];
    const rows = sqliteAll<{ id: string }>(
      this.db,
      `SELECT id FROM events WHERE canonical_key IN (?, ?, ?, ?, ?) ORDER BY timestamp ASC`,
      keys
    );
    return rows.map((row) => row.id);
  }

  private existingEventIds(eventIds: string[]): string[] {
    if (eventIds.length === 0) return [];
    const placeholders = eventIds.map(() => '?').join(', ');
    const rows = sqliteAll<{ id: string }>(
      this.db,
      'SELECT id FROM events WHERE id IN (' + placeholders + ')',
      eventIds
    );
    const existing = new Set(rows.map((row) => row.id));
    return eventIds.filter((eventId) => existing.has(eventId));
  }

  private async syncBlockerEdges(input: { actionId: string; entityId: string; project: string }): Promise<void> {
    const rows = sqliteAll<EntityEdgeRow>(
      this.db,
      `SELECT rel_type, dst_type, dst_id, meta_json
       FROM edges
       WHERE src_type = 'entity'
         AND src_id = ?
         AND rel_type IN ('blocked_by', 'blocked_by_suggested')`,
      [input.entityId]
    );

    const desiredEdges = rows.map((row) => {
      const dst = this.actionEdgeDestination(row, input.project);
      return {
        dstType: dst.dstType,
        dstId: dst.dstId,
        confidence: edgeConfidence(row),
        key: `${dst.dstType}:${dst.dstId}`
      };
    });
    const desiredKeys = new Set(desiredEdges.map((edge) => edge.key));
    const existingEdges = sqliteAll<MemoryActionEdgeRow>(
      this.db,
      `SELECT edge_id, dst_type, dst_id
       FROM memory_action_edges
       WHERE src_action_id = ?
         AND rel_type = 'depends_on'
         AND dst_type IN ('action', 'entity')
         AND source = 'task_projector'`,
      [input.actionId]
    );
    for (const existing of existingEdges) {
      if (!desiredKeys.has(`${existing.dst_type}:${existing.dst_id}`)) {
        sqliteRun(this.db, `DELETE FROM memory_action_edges WHERE edge_id = ?`, [existing.edge_id]);
      }
    }

    for (const edge of desiredEdges) {
      await this.actions.addEdge({
        srcActionId: input.actionId,
        relType: 'depends_on',
        dstType: edge.dstType,
        dstId: edge.dstId,
        confidence: edge.confidence,
        source: 'task_projector'
      });
    }
  }

  private actionEdgeDestination(row: EntityEdgeRow, project: string): { dstType: 'action' | 'entity'; dstId: string } {
    if (row.dst_type !== 'entity') return { dstType: 'entity', dstId: row.dst_id };
    const dstEntity = sqliteGet<EntityProjectRow>(
      this.db,
      `SELECT entity_type, current_json FROM entities WHERE entity_id = ?`,
      [row.dst_id]
    );
    if (!dstEntity || dstEntity.entity_type !== 'task') return { dstType: 'entity', dstId: row.dst_id };
    const current = parseJsonObject(dstEntity.current_json);
    if (!current || current.project !== project) return { dstType: 'entity', dstId: row.dst_id };
    return { dstType: 'action', dstId: actionIdForTaskEntity(row.dst_id) };
  }
}

export function actionIdForTaskEntity(entityId: string): string {
  const bytes = createHash('sha256').update(`memory-action:task:${entityId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join('-');
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function parseActionStatus(value: unknown): MemoryActionStatus {
  const parsed = MemoryActionStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : 'pending';
}

function priorityToScore(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(100, Math.round(value)));
  }
  if (typeof value !== 'string') return PRIORITY_SCORE.medium;
  return PRIORITY_SCORE[value] ?? PRIORITY_SCORE.medium;
}

function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}

function actionMatchesDesired(
  action: MemoryAction,
  desired: {
    title: string;
    status: MemoryActionStatus;
    priority: number;
    sourceEventIds: string[];
    relatedEntityIds: string[];
  }
): boolean {
  return action.title === desired.title
    && action.status === desired.status
    && action.priority === desired.priority
    && arraysEqual(action.sourceEventIds, desired.sourceEventIds)
    && arraysEqual(action.relatedEntityIds, desired.relatedEntityIds);
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function edgeConfidence(row: EntityEdgeRow): number {
  const meta = parseJsonObject(row.meta_json);
  const confidence = typeof meta?.confidence === 'number' ? meta.confidence : row.rel_type === 'blocked_by_suggested' ? 0.5 : 1;
  return Math.max(0, Math.min(1, confidence));
}
