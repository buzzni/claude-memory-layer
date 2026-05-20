import { sqliteAll, type SQLiteDatabase } from '../sqlite-wrapper.js';
import type { NodeType, RelationType } from '../types.js';

export type GraphPathDirection = 'outgoing' | 'incoming' | 'both';

export interface GraphNodeRef {
  type: NodeType;
  id: string;
}

export interface GraphPathNode extends GraphNodeRef {
  name: string;
}

export interface GraphPathStep {
  edgeId: string;
  relationType: RelationType;
  direction: 'outgoing' | 'incoming';
  from: GraphPathNode;
  to: GraphPathNode;
  weight: number;
  cost: number;
  scoreContribution: number;
}

export interface GraphPathResult {
  target: GraphPathNode;
  hops: number;
  totalCost: number;
  scoreContribution: number;
  steps: GraphPathStep[];
}

export interface GraphPathExpandInput {
  startNodes: GraphNodeRef[];
  maxHops?: number;
  maxResults?: number;
  direction?: GraphPathDirection;
}

export interface GraphPathExpandResult {
  startNodes: GraphPathNode[];
  effectiveMaxHops: number;
  paths: GraphPathResult[];
}

interface EdgeRow {
  edge_id: string;
  src_type: string;
  src_id: string;
  rel_type: string;
  dst_type: string;
  dst_id: string;
  meta_json: string | null;
}

interface EntityLabelRow {
  entity_id: string;
  title: string;
}

interface TraversalEdge {
  toKey: string;
  step: GraphPathStep;
}

interface PathState {
  key: string;
  hops: number;
  totalCost: number;
  steps: GraphPathStep[];
  visited: Set<string>;
}

interface BestPath {
  hops: number;
  totalCost: number;
  signature: string;
  steps: GraphPathStep[];
}

const DEFAULT_WEIGHT = 0.5;
const MAX_HOPS = 2;
const DEFAULT_MAX_RESULTS = 20;
const MAX_RESULTS = 100;

export class GraphPathService {
  constructor(private db: SQLiteDatabase) {}

  expand(input: GraphPathExpandInput): GraphPathExpandResult {
    const graph = this.loadGraph(input.direction ?? 'both');
    const effectiveMaxHops = normalizeMaxHops(input.maxHops);
    const maxResults = normalizeMaxResults(input.maxResults);
    const startNodes = input.startNodes.map(node => graph.node(node));
    const startKeys = new Set(input.startNodes.map(nodeKey));
    const bestByTarget = new Map<string, BestPath>();
    const queue: PathState[] = startNodes.map(node => ({
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
          queue.push({
            key: edge.toKey,
            hops: nextHops,
            totalCost: nextTotalCost,
            steps: nextSteps,
            visited: nextVisited
          });
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

    return { startNodes, effectiveMaxHops, paths };
  }

  private loadGraph(direction: GraphPathDirection): { adjacency: Map<string, TraversalEdge[]>; node: (node: GraphNodeRef) => GraphPathNode } {
    const entityLabels = new Map(
      sqliteAll<EntityLabelRow>(this.db, `SELECT entity_id, title FROM entities WHERE status = 'active'`)
        .map(row => [row.entity_id, row.title] as const)
    );
    const labelNode = (node: GraphNodeRef): GraphPathNode => ({
      ...node,
      name: node.type === 'entity' ? entityLabels.get(node.id) ?? node.id : node.id
    });
    const adjacency = new Map<string, TraversalEdge[]>();
    const edges = sqliteAll<EdgeRow>(
      this.db,
      `SELECT edge_id, src_type, src_id, rel_type, dst_type, dst_id, meta_json FROM edges`
    );

    for (const edge of edges) {
      const src = labelNode({ type: edge.src_type as NodeType, id: edge.src_id });
      const dst = labelNode({ type: edge.dst_type as NodeType, id: edge.dst_id });
      const weight = edgeWeight(edge.meta_json);
      const cost = 1 / weight;
      const baseStep = {
        edgeId: edge.edge_id,
        relationType: edge.rel_type as RelationType,
        from: src,
        to: dst,
        weight,
        cost,
        scoreContribution: weight
      };

      if (direction === 'outgoing' || direction === 'both') {
        addTraversal(adjacency, nodeKey(src), {
          toKey: nodeKey(dst),
          step: { ...baseStep, direction: 'outgoing' }
        });
      }
      if (direction === 'incoming' || direction === 'both') {
        addTraversal(adjacency, nodeKey(dst), {
          toKey: nodeKey(src),
          step: { ...baseStep, direction: 'incoming' }
        });
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

function pathSignature(steps: GraphPathStep[]): string {
  return steps
    .map(step => `${step.edgeId}:${step.direction}:${nodeKey(step.from)}>${nodeKey(step.to)}`)
    .join('|');
}

function edgeWeight(metaJson: string | null): number {
  const meta = parseMeta(metaJson);
  const raw = meta.weight;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_WEIGHT;
}

function parseMeta(metaJson: string | null): Record<string, unknown> {
  if (!metaJson) return {};
  try {
    const parsed = JSON.parse(metaJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function nodeKey(node: GraphNodeRef): string {
  return `${node.type}:${node.id}`;
}

function nodeFromKey(key: string): GraphNodeRef {
  const index = key.indexOf(':');
  if (index === -1) return { type: 'entity', id: key };
  return { type: key.slice(0, index) as NodeType, id: key.slice(index + 1) };
}
