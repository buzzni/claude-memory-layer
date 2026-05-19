import { z } from 'zod';

import {
  sqliteAll,
  toDateFromSQLite,
  type SQLiteDatabase
} from '../sqlite-wrapper.js';
import { MemoryActionStatusSchema, type MemoryAction, type MemoryActionStatus } from './actions.js';

const NonEmptyStringSchema = z.string().transform((value) => value.trim()).pipe(z.string().min(1));

export const FrontierRankInputSchema = z.object({
  projectHash: NonEmptyStringSchema,
  includeBlocked: z.boolean().default(false),
  limit: z.number().int().positive().max(500).default(50),
  now: z.union([z.date(), z.string().datetime()]).transform((value) => value instanceof Date ? value : new Date(value)).optional()
});
export type FrontierRankInput = z.infer<typeof FrontierRankInputSchema>;

export interface FrontierItem {
  action: MemoryAction;
  score: number;
  reasons: string[];
  sourceRefs: string[];
}

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
  src_action_id: string;
  rel_type: string;
  dst_type: string;
  dst_id: string;
  confidence: number;
}

interface MemoryLeaseRow {
  target_id: string;
  holder: string;
}

interface MemoryFacetRow {
  target_id: string;
  dimension: string;
  value: string;
  confidence: number;
  evidence_event_ids: string;
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

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
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

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

function terminalStatus(status: MemoryActionStatus): boolean {
  return status === 'done' || status === 'cancelled';
}

export class FrontierService {
  constructor(private readonly db: SQLiteDatabase) {}

  async rank(input: unknown): Promise<FrontierItem[]> {
    const parsed = FrontierRankInputSchema.parse(input);
    const now = parsed.now ?? new Date();
    const actions = this.listCandidateActions(parsed.projectHash);
    if (actions.length === 0) return [];

    const actionIds = actions.map((action) => action.actionId);
    const edgesByAction = this.edgesByAction(actionIds);
    const actionStatusById = this.actionStatusesById(parsed.projectHash, this.actionStatusIds(actionIds, edgesByAction));
    const activeLeases = this.activeLeasesByAction(actionIds, now);
    const facetsByAction = this.qualityFacetsByAction(parsed.projectHash, actionIds);

    return actions
      .map((action) => this.scoreAction({
        action,
        now,
        includeBlocked: parsed.includeBlocked,
        edges: edgesByAction.get(action.actionId) ?? [],
        actionStatusById,
        activeLease: activeLeases.get(action.actionId),
        qualityFacets: facetsByAction.get(action.actionId) ?? []
      }))
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return right.action.updatedAt.getTime() - left.action.updatedAt.getTime();
      })
      .slice(0, parsed.limit);
  }

  private listCandidateActions(projectHash: string): MemoryAction[] {
    const rows = sqliteAll<MemoryActionRow>(
      this.db,
      `SELECT * FROM memory_actions
       WHERE project_hash = ? AND status NOT IN ('done', 'cancelled')
       ORDER BY updated_at DESC
       LIMIT ?`,
      [projectHash, 500]
    );
    return rows.map(rowToAction);
  }

  private edgesByAction(actionIds: string[]): Map<string, MemoryActionEdgeRow[]> {
    if (actionIds.length === 0) return new Map();
    const rows = sqliteAll<MemoryActionEdgeRow>(
      this.db,
      `SELECT src_action_id, rel_type, dst_type, dst_id, confidence
       FROM memory_action_edges
       WHERE src_action_id IN (${placeholders(actionIds)})`,
      actionIds
    );
    const grouped = new Map<string, MemoryActionEdgeRow[]>();
    for (const row of rows) {
      const current = grouped.get(row.src_action_id) ?? [];
      current.push(row);
      grouped.set(row.src_action_id, current);
    }
    return grouped;
  }

  private actionStatusIds(actionIds: string[], edgesByAction: Map<string, MemoryActionEdgeRow[]>): string[] {
    const ids = new Set(actionIds);
    for (const edges of Array.from(edgesByAction.values())) {
      for (const edge of edges) {
        if (edge.dst_type === 'action') ids.add(edge.dst_id);
      }
    }
    return Array.from(ids);
  }

  private actionStatusesById(projectHash: string, actionIds: string[]): Map<string, MemoryActionStatus> {
    if (actionIds.length === 0) return new Map();
    const rows = sqliteAll<{ action_id: string; status: string }>(
      this.db,
      `SELECT action_id, status
       FROM memory_actions
       WHERE project_hash = ? AND action_id IN (${placeholders(actionIds)})`,
      [projectHash, ...actionIds]
    );
    return new Map(rows.map((row) => [row.action_id, MemoryActionStatusSchema.parse(row.status)]));
  }

  private activeLeasesByAction(actionIds: string[], now: Date): Map<string, MemoryLeaseRow> {
    if (actionIds.length === 0) return new Map();
    const rows = sqliteAll<MemoryLeaseRow>(
      this.db,
      `SELECT target_id, holder
       FROM memory_leases
       WHERE target_type = 'action'
         AND released_at IS NULL
         AND expires_at > ?
         AND target_id IN (${placeholders(actionIds)})`,
      [now.toISOString(), ...actionIds]
    );
    return new Map(rows.map((row) => [row.target_id, row]));
  }

  private qualityFacetsByAction(projectHash: string, actionIds: string[]): Map<string, MemoryFacetRow[]> {
    if (actionIds.length === 0) return new Map();
    const rows = sqliteAll<MemoryFacetRow>(
      this.db,
      `SELECT target_id, dimension, value, confidence, evidence_event_ids
       FROM memory_facets
       WHERE project_hash = ?
         AND target_type = 'action'
         AND dimension = 'quality'
         AND value IN ('verified', 'high-quality', 'high_quality', 'high')
         AND target_id IN (${placeholders(actionIds)})`,
      [projectHash, ...actionIds]
    );
    const grouped = new Map<string, MemoryFacetRow[]>();
    for (const row of rows) {
      const current = grouped.get(row.target_id) ?? [];
      current.push(row);
      grouped.set(row.target_id, current);
    }
    return grouped;
  }

  private scoreAction(input: {
    action: MemoryAction;
    now: Date;
    includeBlocked: boolean;
    edges: MemoryActionEdgeRow[];
    actionStatusById: Map<string, MemoryActionStatus>;
    activeLease?: MemoryLeaseRow;
    qualityFacets: MemoryFacetRow[];
  }): FrontierItem {
    const { action, now, includeBlocked, edges, actionStatusById, activeLease, qualityFacets } = input;
    let score = action.priority * 5;
    const reasons: string[] = [`priority:${action.priority}`];
    const sourceRefs: string[] = [...action.sourceEventIds];

    if (action.status === 'in_progress') {
      score += 15;
      reasons.push('status:in_progress');
    } else if (action.status === 'pending') {
      score += 5;
      reasons.push('status:pending');
    } else if (action.status === 'blocked') {
      if (includeBlocked) {
        reasons.push('status:blocked_included');
      } else {
        score -= 500;
        reasons.push('status:blocked_penalty');
      }
    }

    const ageMs = Math.max(0, now.getTime() - action.updatedAt.getTime());
    const ageDays = ageMs / 86_400_000;
    const recencyScore = Math.max(0, 10 - ageDays * 2);
    if (recencyScore > 0) {
      score += recencyScore;
      reasons.push('recent_update');
    }

    if (activeLease) {
      score -= 100;
      reasons.push(`active_lease:${activeLease.holder}`);
    } else {
      score += 5;
      reasons.push('no_active_lease');
    }

    for (const edge of edges) {
      if (edge.dst_type === 'event' || edge.dst_type === 'source_ref') {
        sourceRefs.push(edge.dst_id);
      }
      if (this.isBlockingEdge(edge, actionStatusById)) {
        score -= Math.round(100 * Number(edge.confidence));
        reasons.push(`blocked_by:${edge.dst_type}`);
      }
    }

    for (const facet of qualityFacets) {
      const confidence = Math.max(0, Math.min(1, Number(facet.confidence)));
      score += Math.round(80 * confidence);
      reasons.push(`quality:${facet.value}`);
      sourceRefs.push(...parseStringArray(facet.evidence_event_ids));
    }

    return {
      action,
      score: Math.round(score * 1000) / 1000,
      reasons: unique(reasons),
      sourceRefs: unique(sourceRefs)
    };
  }

  private isBlockingEdge(edge: MemoryActionEdgeRow, actionStatusById: Map<string, MemoryActionStatus>): boolean {
    if (edge.rel_type !== 'depends_on') return false;
    if (edge.dst_type !== 'action') return true;
    const dstStatus = actionStatusById.get(edge.dst_id);
    return dstStatus === undefined || !terminalStatus(dstStatus);
  }
}
