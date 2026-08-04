/**
 * Bounded weighted traversal over `edge_history` for a given point in time
 * (Zep/Graphiti-inspired asOf/knownAt queries), see
 * docs/graph-temporal-edge-spike.md. Mirrors GraphPathService's traversal
 * shape over the current-state `edges` table; kept as a separate service so
 * current-graph retrieval (GraphPathService) stays untouched and fast.
 */

import { sqliteAll, type SQLiteDatabase } from '../sqlite-wrapper.js';
import type { NodeType, RelationType } from '../types.js';
import { hasEdgeHistoryTable } from './edge-history-repo.js';

export type TemporalGraphDirection = 'outgoing' | 'incoming' | 'both';

export interface TemporalGraphNodeRef {
  type: NodeType;
  id: string;
}

export interface TemporalGraphNode extends TemporalGraphNodeRef {
  name: string;
}

export interface TemporalGraphStep {
  historyId: string;
  edgeKey: string;
  relationType: RelationType;
  direction: 'outgoing' | 'incoming';
  from: TemporalGraphNode;
  to: TemporalGraphNode;
  weight: number;
  cost: number;
  scoreContribution: number;
  validFrom?: string;
  validTo?: string;
  committedAt: string;
}

export interface TemporalGraphPathResult {
  target: TemporalGraphNode;
  hops: number;
  totalCost: number;
  scoreContribution: number;
  steps: TemporalGraphStep[];
}

export interface TemporalGraphQueryInput {
  startNodes: TemporalGraphNodeRef[];
  asOf?: Date;
  knownAt?: Date;
  maxHops?: number;
  maxResults?: number;
  direction?: TemporalGraphDirection;
}

export interface TemporalGraphExpandResult {
  startNodes: TemporalGraphNode[];
  asOf: string;
  knownAt: string;
  effectiveMaxHops: number;
  supported: boolean;
  paths: TemporalGraphPathResult[];
}

interface EdgeHistoryEdgeRow {
  history_id: string;
  edge_key: string;
  src_type: string;
  src_id: string;
  rel_type: string;
  dst_type: string;
  dst_id: string;
  weight: number;
  valid_from: string | null;
  valid_to: string | null;
  committed_at: string;
}

interface EntityLabelRow {
  entity_id: string;
  title: string;
}

interface TraversalEdge {
  toKey: string;
  step: TemporalGraphStep;
}

interface PathState {
  key: string;
  hops: number;
  totalCost: number;
  steps: TemporalGraphStep[];
  visited: Set<string>;
}

interface BestPath {
  hops: number;
  totalCost: number;
  signature: string;
  steps: TemporalGraphStep[];
}

const MAX_HOPS = 2;
const DEFAULT_MAX_RESULTS = 20;
const MAX_RESULTS = 100;

export class TemporalGraphService {
  constructor(private readonly db: SQLiteDatabase) {}

  expand(input: TemporalGraphQueryInput): TemporalGraphExpandResult {
    const asOf = input.asOf ?? new Date();
    const knownAt = input.knownAt ?? new Date();

    if (!hasEdgeHistoryTable(this.db)) {
      return {
        startNodes: input.startNodes.map((node) => ({ ...node, name: node.id })),
        asOf: asOf.toISOString(),
        knownAt: knownAt.toISOString(),
        effectiveMaxHops: normalizeMaxHops(input.maxHops),
        supported: false,
        paths: []
      };
    }

    const graph = this.loadGraph(input.direction ?? 'both', asOf, knownAt);
    const effectiveMaxHops = normalizeMaxHops(input.maxHops);
    const maxResults = normalizeMaxResults(input.maxResults);
    const startNodes = input.startNodes.map((node) => graph.node(node));
    const startKeys = new Set(input.startNodes.map(nodeKey));
    const bestByTarget = new Map<string, BestPath>();
    const queue: PathState[] = startNodes.map((node) => ({
      key: nodeKey(node),
      hops: 0,
      totalCost: 0,
      steps: [],
      visited: new Set([nodeKey(node)])
    }));

    while (queue.length > 0) {
      queue.sort((a, b) => a.totalCost - b.totalCost || a.hops - b.hops || a.key.localeCompare(b.key));
      const current = queue.shift()!;
      if (current.hops >= effectiveMaxHops) continue;

      for (const edge of graph.adjacency.get(current.key) ?? []) {
        if (current.visited.has(edge.toKey)) continue;
        const nextHops = current.hops + 1;
        const nextTotalCost = current.totalCost + edge.step.cost;
        const nextSteps = [...current.steps, edge.step];
        const nextSignature = pathSignature(nextSteps);
        const existing = bestByTarget.get(edge.toKey);

        if (!existing || isBetterPath(nextTotalCost, nextHops, nextSignature, existing)) {
          if (!startKeys.has(edge.toKey)) {
            bestByTarget.set(edge.toKey, { hops: nextHops, totalCost: nextTotalCost, signature: nextSignature, steps: nextSteps });
          }
          const nextVisited = new Set(current.visited);
          nextVisited.add(edge.toKey);
          queue.push({ key: edge.toKey, hops: nextHops, totalCost: nextTotalCost, steps: nextSteps, visited: nextVisited });
        }
      }
    }

    const paths = Array.from(bestByTarget.entries())
      .map(([key, path]) => ({
        target: graph.node(nodeFromKey(key)),
        hops: path.hops,
        totalCost: path.totalCost,
        scoreContribution: path.totalCost > 0 ? 1 / path.totalCost : 0,
        steps: path.steps
      }))
      .sort((a, b) => b.scoreContribution - a.scoreContribution || a.hops - b.hops || a.target.name.localeCompare(b.target.name))
      .slice(0, maxResults);

    return { startNodes, asOf: asOf.toISOString(), knownAt: knownAt.toISOString(), effectiveMaxHops, supported: true, paths };
  }

  /**
   * One row per edge_key: the version valid at `asOf` as known at `knownAt`.
   * Mirrors EdgeHistoryRepo.selectAsOf but batched across all keys, and
   * excludes edges touching a non-active entity the same way GraphPathService
   * does for current-state traversal (a superseded entity is stale, whether
   * queried via the current graph or a past asOf).
   */
  private loadGraph(
    direction: TemporalGraphDirection,
    asOf: Date,
    knownAt: Date
  ): { adjacency: Map<string, TraversalEdge[]>; node: (node: TemporalGraphNodeRef) => TemporalGraphNode } {
    const entityLabels = new Map(
      sqliteAll<EntityLabelRow>(this.db, `SELECT entity_id, title FROM entities WHERE status = 'active'`)
        .map((row) => [row.entity_id, row.title] as const)
    );
    const labelNode = (node: TemporalGraphNodeRef): TemporalGraphNode => ({
      ...node,
      name: node.type === 'entity' ? entityLabels.get(node.id) ?? node.id : node.id
    });

    const asOfIso = asOf.toISOString();
    const knownAtIso = knownAt.toISOString();
    const candidateRows = sqliteAll<EdgeHistoryEdgeRow>(
      this.db,
      `SELECT history_id, edge_key, src_type, src_id, rel_type, dst_type, dst_id, weight, valid_from, valid_to, committed_at
       FROM edge_history
       WHERE status NOT IN ('tombstoned', 'quarantined')
         AND committed_at <= ?
         AND (valid_from IS NULL OR valid_from <= ?)
         AND (valid_to IS NULL OR valid_to > ?)`,
      [knownAtIso, asOfIso, asOfIso]
    );

    const byEdgeKey = new Map<string, EdgeHistoryEdgeRow>();
    for (const row of candidateRows) {
      const existing = byEdgeKey.get(row.edge_key);
      if (!existing || row.committed_at > existing.committed_at
        || (row.committed_at === existing.committed_at && row.history_id > existing.history_id)) {
        byEdgeKey.set(row.edge_key, row);
      }
    }

    const adjacency = new Map<string, TraversalEdge[]>();
    for (const row of byEdgeKey.values()) {
      if (row.src_type === 'entity' && !entityLabels.has(row.src_id)) continue;
      if (row.dst_type === 'entity' && !entityLabels.has(row.dst_id)) continue;

      const src = labelNode({ type: row.src_type as NodeType, id: row.src_id });
      const dst = labelNode({ type: row.dst_type as NodeType, id: row.dst_id });
      const weight = row.weight > 0 ? row.weight : 0.5;
      const cost = 1 / weight;
      const baseStep = {
        historyId: row.history_id,
        edgeKey: row.edge_key,
        relationType: row.rel_type as RelationType,
        from: src,
        to: dst,
        weight,
        cost,
        scoreContribution: weight,
        validFrom: row.valid_from ?? undefined,
        validTo: row.valid_to ?? undefined,
        committedAt: row.committed_at
      };

      if (direction === 'outgoing' || direction === 'both') {
        addTraversal(adjacency, nodeKey(src), { toKey: nodeKey(dst), step: { ...baseStep, direction: 'outgoing' } });
      }
      if (direction === 'incoming' || direction === 'both') {
        addTraversal(adjacency, nodeKey(dst), { toKey: nodeKey(src), step: { ...baseStep, direction: 'incoming' } });
      }
    }

    return { adjacency, node: labelNode };
  }
}

function addTraversal(adjacency: Map<string, TraversalEdge[]>, fromKey: string, edge: TraversalEdge): void {
  const edges = adjacency.get(fromKey) ?? [];
  edges.push(edge);
  adjacency.set(fromKey, edges);
}

function normalizeMaxHops(maxHops?: number): number {
  if (maxHops === undefined) return 1;
  if (!Number.isFinite(maxHops)) return MAX_HOPS;
  return Math.min(Math.max(0, Math.trunc(maxHops)), MAX_HOPS);
}

function normalizeMaxResults(maxResults?: number): number {
  if (maxResults === undefined) return DEFAULT_MAX_RESULTS;
  if (!Number.isFinite(maxResults)) return DEFAULT_MAX_RESULTS;
  return Math.min(Math.max(0, Math.trunc(maxResults)), MAX_RESULTS);
}

function isBetterPath(totalCost: number, hops: number, signature: string, existing: BestPath): boolean {
  return totalCost < existing.totalCost
    || (totalCost === existing.totalCost && hops < existing.hops)
    || (totalCost === existing.totalCost && hops === existing.hops && signature < existing.signature);
}

function pathSignature(steps: TemporalGraphStep[]): string {
  return steps.map((step) => `${step.historyId}:${step.direction}:${nodeKey(step.from)}>${nodeKey(step.to)}`).join('|');
}

function nodeKey(node: TemporalGraphNodeRef): string {
  return `${node.type}:${node.id}`;
}

function nodeFromKey(key: string): TemporalGraphNodeRef {
  const index = key.indexOf(':');
  if (index === -1) return { type: 'entity', id: key };
  return { type: key.slice(0, index) as NodeType, id: key.slice(index + 1) };
}
