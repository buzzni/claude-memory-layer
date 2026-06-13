/**
 * Memory Retriever - Unified retrieval interface
 * Combines vector search, keyword search, scoped filtering, and matching
 */

import { EventStore } from './event-store.js';
import { VectorStore, SearchResult } from './vector-store.js';
import { Embedder } from './embedder.js';
import { Matcher } from './matcher.js';
import { SharedStore } from './shared-store.js';
import { SharedVectorStore } from './shared-vector-store.js';
import { GraduationPipeline } from './graduation.js';
import { FacetRepository } from './operations/facet-repository.js';
import { FacetDimensionSchema, type FacetDimension } from './operations/facets.js';
import {
  GraphPathService,
  type GraphPathResult
} from './operations/graph-path-service.js';
import { QueryEntityExtractor } from './operations/query-entity-extractor.js';
import type { SQLiteDatabase } from './sqlite-wrapper.js';
import {
  hasTechnicalTermOverlap,
  isCommandArtifactQuery,
  isCurrentStateQuery,
  isLowConfidenceContextFallbackQuery,
  isLowSignalContextContent,
  isStaleOrSupersededContent,
  buildRetrievalQualityQuery,
  hasDiscriminativeTermOverlap,
  shouldApplyTechnicalGuard
} from './retrieval-quality.js';
import {
  normalizeRetrievalDebugLanes,
  type RetrievalDebugLane
} from './retrieval-debug-lanes.js';
import type { MemoryEvent, MatchResult, NodeType, SharedTroubleshootingEntry } from './types.js';

export type { RetrievalDebugLane, RetrievalDebugLaneName } from './retrieval-debug-lanes.js';

export interface RetrievalScope {
  sessionId?: string;
  eventTypes?: MemoryEvent['eventType'][];
  metadata?: Record<string, unknown>;
  canonicalKeyPrefix?: string;
  sessionIdPrefix?: string;
  contentIncludes?: string[];
}

export type RetrievalStrategy = 'auto' | 'fast' | 'deep';
export type RetrievalMode = 'event' | 'session-event-hybrid';
export type ProjectScopeMode = 'strict' | 'prefer' | 'global';
type DecayPolicy = NonNullable<RetrievalOptions['decayPolicy']>;
type GraphHopOptions = NonNullable<RetrievalOptions['graphHop']>;

export interface RetrievalFacetFilter {
  dimension: FacetDimension;
  value: string;
}

export interface RetrievalDebugDetail {
  eventId: string;
  score: number;
  semanticScore?: number;
  lexicalScore?: number;
  recencyScore?: number;
  facetMatches?: RetrievalFacetFilter[];
  graphPaths?: RetrievalGraphPathDebug[];
  lanes?: RetrievalDebugLane[];
}

export interface RetrievalGraphPathDebug {
  startEntityId: string;
  startEntityTitle?: string;
  targetId: string;
  targetType: NodeType;
  hops: number;
  relationPath: string[];
}

type DebuggableSearchResult = SearchResult & {
  semanticScore?: number;
  lexicalScore?: number;
  recencyScore?: number;
  facetMatches?: RetrievalFacetFilter[];
  graphPaths?: RetrievalGraphPathDebug[];
  lanes?: RetrievalDebugLane[];
};

export interface RetrievalOptions {
  topK: number;
  minScore: number;
  sessionId?: string;
  maxTokens: number;
  includeSessionContext: boolean;
  scope?: RetrievalScope;
  strategy?: RetrievalStrategy;
  rerankWithKeyword?: boolean;
  rerankWeights?: {
    semantic?: number;
    lexical?: number;
    recency?: number;
  };
  decayPolicy?: {
    enabled?: boolean;
    windowDays?: number;
    maxPenalty?: number;
  };
  intentRewrite?: boolean;
  graphHop?: {
    enabled?: boolean;
    maxHops?: number;
    hopPenalty?: number;
  };
  /**
   * event: return only directly retrieved events.
   * session-event-hybrid: also rescue query-relevant sibling events from sessions
   * that direct retrieval already hit. This is the production form of the
   * LongMemEval-inspired session+turn hybrid retrieval pattern.
   */
  retrievalMode?: RetrievalMode;
  projectScopeMode?: ProjectScopeMode;
  projectHash?: string;
  allowedProjectHashes?: string[];
  facets?: RetrievalFacetFilter[];
}

export interface RetrievalResult {
  memories: MemoryWithContext[];
  matchResult: MatchResult;
  totalTokens: number;
  context: string;
  fallbackTrace?: string[];
  selectedDebug?: RetrievalDebugDetail[];
  candidateDebug?: RetrievalDebugDetail[];
  rawQueryText?: string;
  effectiveQueryText?: string;
  queryRewriteKind?: string;
}

export interface MemoryWithContext {
  event: MemoryEvent;
  score: number;
  sessionContext?: string;
}

export interface UnifiedRetrievalOptions extends RetrievalOptions {
  includeShared?: boolean;
  projectHash?: string;
}

export interface UnifiedRetrievalResult extends RetrievalResult {
  sharedMemories?: SharedTroubleshootingEntry[];
}

const DEFAULT_OPTIONS: RetrievalOptions = {
  topK: 5,
  minScore: 0.7,
  maxTokens: 2000,
  includeSessionContext: true,
  strategy: 'auto',
  rerankWithKeyword: true,
  decayPolicy: {
    enabled: true,
    windowDays: 30,
    maxPenalty: 0.15
  },
  graphHop: {
    enabled: true,
    maxHops: 1,
    hopPenalty: 0.08
  },
  projectScopeMode: 'global'
};

export interface SharedStoreOptions {
  sharedStore?: SharedStore;
  sharedVectorStore?: SharedVectorStore;
  queryGraphExpansionEnabled?: boolean;
}

type EventStoreLike = EventStore & {
  keywordSearch?: (query: string, limit?: number) => Promise<Array<{ event: MemoryEvent; rank: number }>>;
  getDatabase?: () => SQLiteDatabase;
};

export class Retriever {
  private readonly eventStore: EventStoreLike;
  private readonly vectorStore: VectorStore;
  private readonly embedder: Embedder;
  private readonly matcher: Matcher;
  private sharedStore?: SharedStore;
  private sharedVectorStore?: SharedVectorStore;
  private graduation?: GraduationPipeline;
  private queryRewriter?: (query: string) => Promise<string | null>;
  private readonly queryGraphExpansionEnabled: boolean;

  constructor(
    eventStore: EventStore,
    vectorStore: VectorStore,
    embedder: Embedder,
    matcher: Matcher,
    sharedOptions?: SharedStoreOptions
  ) {
    this.eventStore = eventStore as EventStoreLike;
    this.vectorStore = vectorStore;
    this.embedder = embedder;
    this.matcher = matcher;
    this.sharedStore = sharedOptions?.sharedStore;
    this.sharedVectorStore = sharedOptions?.sharedVectorStore;
    this.queryGraphExpansionEnabled = sharedOptions?.queryGraphExpansionEnabled === true;
  }

  setGraduationPipeline(graduation: GraduationPipeline): void {
    this.graduation = graduation;
  }

  setSharedStores(sharedStore: SharedStore, sharedVectorStore: SharedVectorStore): void {
    this.sharedStore = sharedStore;
    this.sharedVectorStore = sharedVectorStore;
  }

  setQueryRewriter(rewriter: (query: string) => Promise<string | null>): void {
    this.queryRewriter = rewriter;
  }

  async retrieve(
    query: string,
    options: Partial<RetrievalOptions> = {}
  ): Promise<RetrievalResult> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const retrievalMode: RetrievalMode = options.retrievalMode
      ?? ((options.strategy ?? DEFAULT_OPTIONS.strategy) === 'auto' ? 'session-event-hybrid' : 'event');
    const sessionFilter = opts.scope?.sessionId ?? opts.sessionId;
    const fallbackTrace: string[] = [];
    const qualityQuery = buildRetrievalQualityQuery(query);

    if (isCommandArtifactQuery(query)) {
      fallbackTrace.push('guard:command-artifact-query');
      const emptyMatch = this.matcher.matchSearchResults([], () => 0);
      return {
        memories: [],
        matchResult: emptyMatch,
        totalTokens: 0,
        context: '',
        fallbackTrace,
        selectedDebug: [],
        candidateDebug: []
      };
    }

    const fallbackEnabled = (opts.strategy ?? 'auto') === 'auto';

    // Stage 1: primary retrieval
    const primaryStrategy: RetrievalStrategy = opts.strategy === 'auto' ? 'fast' : (opts.strategy || 'fast');
    let current = await this.runStage(query, {
      qualityQuery,
      strategy: primaryStrategy,
      topK: opts.topK,
      minScore: opts.minScore,
      sessionId: sessionFilter,
      scope: opts.scope,
      rerankWithKeyword: opts.rerankWithKeyword !== false,
      rerankWeights: opts.rerankWeights,
      decayPolicy: opts.decayPolicy,
      intentRewrite: opts.intentRewrite === true,
      graphHop: opts.graphHop,
      retrievalMode,
      projectScopeMode: opts.projectScopeMode,
      projectHash: opts.projectHash,
      allowedProjectHashes: opts.allowedProjectHashes,
      facets: opts.facets
    });
    fallbackTrace.push(`stage:primary:${primaryStrategy}`);

    // Stage 2: deep fallback
    if (fallbackEnabled && this.shouldFallback(current.matchResult, current.results) && primaryStrategy !== 'deep') {
      current = await this.runStage(query, {
        qualityQuery,
        strategy: 'deep',
        topK: opts.topK,
        minScore: opts.minScore,
        sessionId: sessionFilter,
        scope: opts.scope,
        rerankWithKeyword: opts.rerankWithKeyword !== false,
        rerankWeights: opts.rerankWeights,
        decayPolicy: opts.decayPolicy,
        graphHop: opts.graphHop,
        retrievalMode,
        projectScopeMode: opts.projectScopeMode,
        projectHash: opts.projectHash,
        allowedProjectHashes: opts.allowedProjectHashes,
        facets: opts.facets
      });
      fallbackTrace.push('fallback:deep');
    }

    // Stage 3: scope-expanded deep fallback
    if (fallbackEnabled && this.shouldFallback(current.matchResult, current.results)) {
      current = await this.runStage(query, {
        qualityQuery,
        strategy: 'deep',
        topK: opts.topK,
        minScore: Math.max(0.5, opts.minScore - 0.15),
        sessionId: undefined,
        scope: undefined,
        rerankWithKeyword: true,
        rerankWeights: opts.rerankWeights,
        decayPolicy: opts.decayPolicy,
        graphHop: opts.graphHop,
        retrievalMode,
        projectScopeMode: opts.projectScopeMode,
        projectHash: opts.projectHash,
        allowedProjectHashes: opts.allowedProjectHashes,
        facets: opts.facets
      });
      fallbackTrace.push('fallback:scope-expanded');
    }

    // Stage 4: summary fallback
    if (fallbackEnabled && this.shouldFallback(current.matchResult, current.results)) {
      const summary = await this.buildSummaryFallback(qualityQuery, opts.topK);
      const scopedSummary = await this.applyScopeFilters(summary, {
        scope: opts.scope,
        projectScopeMode: opts.projectScopeMode,
        projectHash: opts.projectHash,
        allowedProjectHashes: opts.allowedProjectHashes,
        facets: opts.facets
      });
      const filteredSummary = this.applyQualityFilters(scopedSummary, {
        query,
        minScore: opts.minScore
      });
      const expandedSummary = retrievalMode === 'session-event-hybrid'
        ? await this.expandSessionEventHybrid(filteredSummary, {
            query: qualityQuery,
            currentStateQuery: query,
            limit: opts.topK * 4
          })
        : filteredSummary;
      const scopedExpandedSummary = retrievalMode === 'session-event-hybrid'
        ? await this.applyScopeFilters(expandedSummary, {
            scope: opts.scope,
            projectScopeMode: opts.projectScopeMode,
            projectHash: opts.projectHash,
            allowedProjectHashes: opts.allowedProjectHashes,
            facets: opts.facets
          })
        : expandedSummary;
      const finalSummary = retrievalMode === 'session-event-hybrid'
        ? this.applyQualityFilters(scopedExpandedSummary, {
            query,
            minScore: opts.minScore
          })
        : scopedExpandedSummary;
      current = {
        results: finalSummary,
        candidateResults: finalSummary,
        matchResult: this.matcher.matchSearchResults(finalSummary, () => 0)
      };
      fallbackTrace.push('fallback:summary');
    }

    const selectedResults = current.results.slice(0, opts.topK).filter((result) => {
      if (current.matchResult.confidence !== 'none') return true;
      if (isLowConfidenceContextFallbackQuery(query)) {
        return (result.semanticScore ?? result.score) >= 0.5 || result.score >= 0.5;
      }
      return (result.semanticScore ?? result.score) >= 0.62 || result.score >= 0.62;
    });
    const memories = await this.enrichResults(selectedResults, opts as RetrievalOptions, query);
    const context = this.buildContext(memories, opts.maxTokens);

    return {
      memories,
      matchResult: current.matchResult,
      totalTokens: this.estimateTokens(context),
      context,
      fallbackTrace,
      selectedDebug: selectedResults.map((r: DebuggableSearchResult) => this.debugDetailForResult(r)),
      candidateDebug: (current.candidateResults || []).slice(0, Math.max(opts.topK * 3, 20)).map((r: DebuggableSearchResult) => this.debugDetailForResult(r)),
      rawQueryText: current.queryRewriteKind ? query : undefined,
      effectiveQueryText: current.effectiveQueryText,
      queryRewriteKind: current.queryRewriteKind
    };
  }

  async retrieveUnified(
    query: string,
    options: Partial<UnifiedRetrievalOptions> = {}
  ): Promise<UnifiedRetrievalResult> {
    const projectResult = await this.retrieve(query, options);

    if (!options.includeShared || !this.sharedStore || !this.sharedVectorStore) {
      return projectResult;
    }

    try {
      const queryEmbedding = await this.embedder.embed(query);
      const sharedVectorResults = await this.sharedVectorStore.search(queryEmbedding.vector, {
        limit: options.topK || 5,
        minScore: options.minScore || 0.7,
        excludeProjectHash: options.projectHash
      });

      const sharedMemories: SharedTroubleshootingEntry[] = [];
      for (const result of sharedVectorResults) {
        const entry = await this.sharedStore.get(result.entryId);
        if (!entry) continue;
        if (!options.projectHash || entry.sourceProjectHash !== options.projectHash) {
          sharedMemories.push(entry);
          await this.sharedStore.recordUsage(entry.entryId);
        }
      }

      const unifiedContext = this.buildUnifiedContext(projectResult, sharedMemories);
      return {
        ...projectResult,
        context: unifiedContext,
        totalTokens: this.estimateTokens(unifiedContext),
        sharedMemories
      };
    } catch (error) {
      console.error('Shared search failed:', error);
      return projectResult;
    }
  }

  private async runStage(
    query: string,
    input: {
      qualityQuery?: string;
      strategy: RetrievalStrategy;
      topK: number;
      minScore: number;
      sessionId?: string;
      scope?: RetrievalScope;
      rerankWithKeyword?: boolean;
      rerankWeights?: {
        semantic?: number;
        lexical?: number;
        recency?: number;
      };
      decayPolicy?: DecayPolicy;
      intentRewrite?: boolean;
      graphHop?: GraphHopOptions;
      retrievalMode: RetrievalMode;
      projectScopeMode?: ProjectScopeMode;
      projectHash?: string;
      allowedProjectHashes?: string[];
      facets?: RetrievalFacetFilter[];
    }
  ): Promise<{
    results: DebuggableSearchResult[];
    candidateResults: DebuggableSearchResult[];
    matchResult: MatchResult;
    effectiveQueryText?: string;
    queryRewriteKind?: string;
  }> {
    const searchQuery = input.qualityQuery ?? query;
    let rerankQuery = searchQuery;
    let effectiveQueryText: string | undefined;
    let queryRewriteKind: string | undefined;
    let initialResults = await this.searchByStrategy(searchQuery, {
      strategy: input.strategy,
      topK: input.topK,
      minScore: input.minScore,
      sessionId: input.sessionId
    });

    if (input.intentRewrite && input.strategy === 'deep' && this.queryRewriter) {
      const rewritten = (await this.queryRewriter(query))?.trim();
      const normalizedQuery = query.trim();
      if (rewritten && rewritten !== normalizedQuery) {
        effectiveQueryText = `${normalizedQuery} ${rewritten}`.trim();
        queryRewriteKind = 'intent-rewrite';
        rerankQuery = buildRetrievalQualityQuery(effectiveQueryText);
        const rewrittenResults = await this.searchByStrategy(buildRetrievalQualityQuery(rewritten), {
          strategy: 'deep',
          topK: input.topK,
          minScore: Math.max(0.5, input.minScore - 0.1),
          sessionId: input.sessionId
        });
        initialResults = this.mergeResults(initialResults, rewrittenResults, input.topK * 3);
      }
    }

    const graphExpandedResults = input.graphHop?.enabled === false
      ? initialResults
      : await this.expandGraphHops(initialResults, {
          query,
          queryGraphEnabled: this.queryGraphExpansionEnabled,
          maxHops: clampGraphHops(input.graphHop?.maxHops ?? 1),
          hopPenalty: Math.max(0, input.graphHop?.hopPenalty ?? 0.08),
          limit: input.topK * 4,
        });

    const expandedResults = input.retrievalMode === 'session-event-hybrid'
      ? await this.expandSessionEventHybrid(graphExpandedResults, {
          query: rerankQuery,
          currentStateQuery: query,
          limit: input.topK * 4
        })
      : graphExpandedResults;

    const rerankedResults = input.rerankWithKeyword
      ? this.rerankByKeywordOverlap(expandedResults, rerankQuery, input.rerankWeights, input.decayPolicy)
      : expandedResults;

    const filtered = await this.applyScopeFilters(rerankedResults, {
      scope: input.scope,
      projectScopeMode: input.projectScopeMode,
      projectHash: input.projectHash,
      allowedProjectHashes: input.allowedProjectHashes,
      facets: input.facets
    });
    const qualityFiltered = this.applyQualityFilters(filtered, {
      query,
      minScore: input.minScore
    });
    const top = qualityFiltered.slice(0, input.topK);
    const matchResult = this.matcher.matchSearchResults(top, () => 0);

    return { results: top, candidateResults: qualityFiltered, matchResult, effectiveQueryText, queryRewriteKind };
  }

  private applyQualityFilters(
    results: DebuggableSearchResult[],
    options: { query: string; minScore: number }
  ): DebuggableSearchResult[] {
    let filtered = [...results];

    if (isCurrentStateQuery(options.query)) {
      filtered = filtered.filter((result) => !isStaleOrSupersededContent(result.content));
    }

    filtered = filtered.filter((result) => !isLowSignalContextContent(result.content));

    filtered = filtered.filter((result) =>
      this.isGraphPathResult(result) || hasDiscriminativeTermOverlap(options.query, result.content)
    );

    if (shouldApplyTechnicalGuard(options.query)) {
      filtered = filtered.filter((result) =>
        this.isGraphPathResult(result) || hasTechnicalTermOverlap(options.query, result.content)
      );
    }

    if (filtered.length <= 2) return filtered;

    const topScore = filtered[0].score;
    if (topScore < 0.8) return filtered;

    const cliffThreshold = Math.max(options.minScore, topScore - 0.25);
    return filtered.filter((result) => result.score >= cliffThreshold);
  }

  private mergeResults(primary: SearchResult[], secondary: SearchResult[], limit: number): SearchResult[] {
    const byId = new Map<string, SearchResult>();
    for (const row of primary) byId.set(row.eventId, row);
    for (const row of secondary) {
      const prev = byId.get(row.eventId);
      if (!prev || row.score > prev.score) {
        byId.set(row.eventId, row);
      }
    }
    return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private async expandSessionEventHybrid(
    seeds: DebuggableSearchResult[],
    opts: { query: string; currentStateQuery: string; limit: number }
  ): Promise<DebuggableSearchResult[]> {
    if (seeds.length === 0 || opts.limit <= seeds.length) return seeds;

    const queryTokens = this.tokenize(opts.query);
    if (queryTokens.length === 0) return seeds;

    const byId = new Map<string, DebuggableSearchResult>();
    for (const seed of seeds) byId.set(seed.eventId, seed);

    const bestSeedBySession = new Map<string, DebuggableSearchResult>();
    for (const seed of [...seeds].sort((a, b) => b.score - a.score || compareStable(a.eventId, b.eventId))) {
      if (!seed.sessionId || bestSeedBySession.has(seed.sessionId)) continue;
      bestSeedBySession.set(seed.sessionId, seed);
    }

    const suppressStaleState = isCurrentStateQuery(opts.currentStateQuery);

    for (const [sessionId, seed] of bestSeedBySession) {
      const sessionEvents = await this.eventStore.getSessionEvents(sessionId);
      for (const event of [...sessionEvents].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())) {
        if (byId.has(event.id)) continue;
        if (isLowSignalContextContent(event.content)) continue;
        if (suppressStaleState && isStaleOrSupersededContent(event.content)) continue;

        const lexicalScore = this.keywordOverlap(queryTokens, this.tokenize(event.content));
        if (lexicalScore <= 0) continue;
        if (shouldApplyTechnicalGuard(opts.query) && !hasTechnicalTermOverlap(opts.query, event.content)) continue;

        const score = Math.min(0.95, Math.max(0.35, seed.score * 0.72 + lexicalScore * 0.28));
        const row: DebuggableSearchResult = withRetrievalLane({
          id: `session-event-${seed.eventId}-${event.id}`,
          eventId: event.id,
          content: event.content,
          score,
          sessionId: event.sessionId,
          eventType: event.eventType,
          timestamp: event.timestamp.toISOString(),
          semanticScore: seed.semanticScore ?? seed.score,
          lexicalScore,
          recencyScore: seed.recencyScore
        }, { lane: 'session_event', reason: `same_session:${seed.eventId}`, score });

        byId.set(row.eventId, row);
        if (byId.size >= opts.limit) break;
      }
      if (byId.size >= opts.limit) break;
    }

    return [...byId.values()]
      .sort((a, b) => b.score - a.score || compareStable(a.eventId, b.eventId))
      .slice(0, opts.limit);
  }

  private async expandGraphHops(
    seeds: SearchResult[],
    opts: { query: string; queryGraphEnabled: boolean; maxHops: number; hopPenalty: number; limit: number }
  ): Promise<DebuggableSearchResult[]> {
    const byId = new Map<string, DebuggableSearchResult>();
    for (const s of seeds) byId.set(s.eventId, s);

    let frontier = seeds.map((s) => ({ row: s, hop: 0 }));

    for (let hop = 1; hop <= opts.maxHops; hop += 1) {
      const next: Array<{ row: SearchResult; hop: number }> = [];

      for (const f of frontier) {
        const ev = await this.eventStore.getEvent(f.row.eventId);
        if (!ev) continue;
        const rel = ((ev.metadata as Record<string, unknown> | undefined)?.relatedEventIds ?? []) as unknown;
        const relatedIds = Array.isArray(rel)
          ? rel.filter((x): x is string => typeof x === 'string')
          : [];

        for (const rid of relatedIds) {
          if (byId.has(rid)) continue;
          const target = await this.eventStore.getEvent(rid);
          if (!target) continue;

          const score = Math.max(0, f.row.score - opts.hopPenalty * hop);
          const row: DebuggableSearchResult = {
            id: `hop-${hop}-${rid}`,
            eventId: target.id,
            content: target.content,
            score,
            sessionId: target.sessionId,
            eventType: target.eventType,
            timestamp: target.timestamp.toISOString(),
            lanes: [{ lane: 'graph_path', reason: 'relatedEventIds', score }]
          };

          byId.set(row.eventId, row);
          next.push({ row, hop });
          if (byId.size >= opts.limit) break;
        }
        if (byId.size >= opts.limit) break;
      }

      frontier = next;
      if (frontier.length === 0 || byId.size >= opts.limit) break;
    }

    if (opts.queryGraphEnabled) {
      await this.expandQueryGraphPaths(opts.query, byId, opts);
    }

    return [...byId.values()]
      .sort((a, b) => b.score - a.score || compareStable(a.eventId, b.eventId))
      .slice(0, opts.limit);
  }

  private async expandQueryGraphPaths(
    query: string,
    byId: Map<string, DebuggableSearchResult>,
    opts: { maxHops: number; hopPenalty: number; limit: number }
  ): Promise<void> {
    if (!query.trim() || !this.eventStore.getDatabase) return;

    try {
      const db = this.eventStore.getDatabase();
      const extraction = new QueryEntityExtractor(db).extract(query, {
        maxCandidates: Math.min(8, opts.limit),
        includeAliases: true
      });
      const startCandidates = extraction.candidates
        .filter((candidate) => candidate.entityId)
        .slice(0, 8);
      const startNodes = uniqueEntityStartNodes(startCandidates);
      if (startNodes.length === 0) return;

      const expansion = new GraphPathService(db).expand({
        startNodes: startNodes.map((node) => ({ type: 'entity' as const, id: node.entityId })),
        maxHops: opts.maxHops,
        maxResults: opts.limit,
        direction: 'both'
      });
      const titleByEntityId = new Map(startNodes.map((node) => [node.entityId, node.title] as const));

      for (const path of expansion.paths) {
        if (path.target.type !== 'event') continue;
        const target = await this.eventStore.getEvent(path.target.id);
        if (!target) continue;

        const graphPath = toRetrievalGraphPathDebug(path, titleByEntityId);
        const score = graphPathScore(path, opts.hopPenalty);
        const existing = byId.get(target.id);
        const graphPaths = mergeGraphPaths(existing?.graphPaths ?? [], [graphPath]);
        const graphLane: RetrievalDebugLane = {
          lane: 'graph_path',
          reason: `query_graph_path:${graphPath.relationPath.join('>') || 'linked'}`,
          score
        };
        const row: DebuggableSearchResult = {
          id: existing?.id ?? `graph-path-${path.hops}-${target.id}`,
          eventId: target.id,
          content: target.content,
          score: Math.max(existing?.score ?? 0, score),
          sessionId: target.sessionId,
          eventType: target.eventType,
          timestamp: target.timestamp.toISOString(),
          semanticScore: existing?.semanticScore,
          lexicalScore: existing?.lexicalScore,
          recencyScore: existing?.recencyScore,
          facetMatches: existing?.facetMatches,
          graphPaths,
          lanes: mergeRetrievalLanes(existing?.lanes ?? [], [graphLane])
        };
        byId.set(row.eventId, row);
        if (byId.size >= opts.limit) break;
      }
    } catch {
      // Legacy SQLite stores may not have operations graph tables yet. Retrieval
      // must remain available even when graph expansion cannot run.
    }
  }

  private shouldFallback(matchResult: MatchResult, results: SearchResult[]): boolean {
    if (results.length === 0) return true;
    if (matchResult.confidence === 'none') return true;
    return false;
  }

  private async buildSummaryFallback(query: string, topK: number): Promise<DebuggableSearchResult[]> {
    const recent = await this.eventStore.getRecentEvents(Math.max(topK * 6, 20));
    const q = this.tokenize(query);

    const ranked = recent
      .map((e) => ({ e, overlap: this.keywordOverlap(q, this.tokenize(e.content)) }))
      .filter((r) => r.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, topK)
      .map((row, idx) => {
        const score = Math.max(0.25, 0.6 - idx * 0.05);
        return withRetrievalLane({
          id: `summary-${row.e.id}`,
          eventId: row.e.id,
          content: row.e.content,
          score,
          sessionId: row.e.sessionId,
          eventType: row.e.eventType,
          timestamp: row.e.timestamp.toISOString()
        }, { lane: 'session_summary', reason: 'summary_fallback', score });
      });

    return ranked;
  }

  private async searchByStrategy(
    query: string,
    input: { strategy: RetrievalStrategy; topK: number; minScore: number; sessionId?: string }
  ): Promise<DebuggableSearchResult[]> {
    const strategy = input.strategy === 'auto' ? 'deep' : input.strategy;

    if (strategy === 'fast') {
      const keyword = await this.searchByKeyword(query, {
        limit: Math.max(5, input.topK * 3),
        sessionId: input.sessionId
      });
      return keyword;
    }

    const queryEmbedding = await this.embedder.embed(query);
    const vectorResults = await this.vectorStore.search(queryEmbedding.vector, {
      limit: Math.max(5, input.topK * 3),
      minScore: input.minScore,
      sessionId: input.sessionId
    });
    return vectorResults.map((result) => withRetrievalLane(result, {
      lane: 'raw_event',
      reason: 'vector_search',
      score: result.score
    }));
  }

  private async searchByKeyword(
    query: string,
    input: { limit: number; sessionId?: string }
  ): Promise<DebuggableSearchResult[]> {
    if (this.eventStore.keywordSearch) {
      const rows = await this.eventStore.keywordSearch(query, input.limit);
      const filtered = input.sessionId ? rows.filter((r) => r.event.sessionId === input.sessionId) : rows;
      return filtered.map((row, idx) => {
        const score = Math.max(0.4, 1 - idx * 0.04);
        return withRetrievalLane({
          id: `kw-${row.event.id}`,
          eventId: row.event.id,
          content: row.event.content,
          score,
          sessionId: row.event.sessionId,
          eventType: row.event.eventType,
          timestamp: row.event.timestamp.toISOString()
        }, { lane: 'raw_event', reason: 'keyword_search', score });
      });
    }

    const recent = await this.eventStore.getRecentEvents(input.limit * 4);
    const tokens = this.tokenize(query);
    const filtered = recent
      .filter((e) => (input.sessionId ? e.sessionId === input.sessionId : true))
      .map((e) => ({ e, overlap: this.keywordOverlap(tokens, this.tokenize(e.content)) }))
      .filter((r) => r.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, input.limit);

    return filtered.map((row, idx) => {
      const score = Math.max(0.3, 0.9 - idx * 0.05);
      return withRetrievalLane({
        id: `kw-fallback-${row.e.id}`,
        eventId: row.e.id,
        content: row.e.content,
        score,
        sessionId: row.e.sessionId,
        eventType: row.e.eventType,
        timestamp: row.e.timestamp.toISOString()
      }, { lane: 'raw_event', reason: 'keyword_fallback', score });
    });
  }

  private rerankByKeywordOverlap(
    results: SearchResult[],
    query: string,
    weights?: { semantic?: number; lexical?: number; recency?: number },
    decayPolicy?: { enabled?: boolean; windowDays?: number; maxPenalty?: number }
  ): SearchResult[] {
    const q = this.tokenize(query);
    const now = Date.now();

    const sw = Math.max(0, weights?.semantic ?? 0.7);
    const lw = Math.max(0, weights?.lexical ?? 0.2);
    const rw = Math.max(0, weights?.recency ?? 0.1);
    const total = sw + lw + rw || 1;

    const decayEnabled = decayPolicy?.enabled !== false;
    const decayWindow = Math.max(1, decayPolicy?.windowDays ?? 30);
    const decayMaxPenalty = Math.max(0, decayPolicy?.maxPenalty ?? 0.15);

    return [...results]
      .map((r) => {
        const overlap = this.keywordOverlap(q, this.tokenize(r.content));
        const recencyDays = Math.max(0, (now - new Date(r.timestamp).getTime()) / (1000 * 60 * 60 * 24));
        const recency = Math.max(0, 1 - recencyDays / decayWindow);
        let blended = (r.score * sw + overlap * lw + recency * rw) / total;

        if (decayEnabled && recencyDays > decayWindow && overlap < 0.5) {
          const ageFactor = Math.min(1, (recencyDays - decayWindow) / decayWindow);
          blended -= decayMaxPenalty * ageFactor;
        }

        return { ...r, score: Math.max(0, blended), semanticScore: r.score, lexicalScore: overlap, recencyScore: recency };
      })
      .sort((a, b) => b.score - a.score);
  }

  private async applyScopeFilters(
    results: DebuggableSearchResult[],
    options?: {
      scope?: RetrievalScope;
      projectScopeMode?: ProjectScopeMode;
      projectHash?: string;
      allowedProjectHashes?: string[];
      facets?: RetrievalFacetFilter[];
    }
  ): Promise<DebuggableSearchResult[]> {
    const scope = options?.scope;
    const projectScopeMode = options?.projectScopeMode ?? 'global';
    const facetFilters = this.normalizeFacetFilters(options?.facets);
    const allowedProjectHashes = new Set(
      [options?.projectHash, ...(options?.allowedProjectHashes || [])].filter(
        (value): value is string => typeof value === 'string' && value.length > 0
      )
    );

    if (!scope && projectScopeMode === 'global' && facetFilters === null) return results;

    const normalizedIncludes = (scope?.contentIncludes || []).map((s) => s.toLowerCase());
    const filtered: Array<{ result: DebuggableSearchResult; projectHash?: string }> = [];

    for (const result of results) {
      if (scope?.sessionId && result.sessionId !== scope.sessionId) continue;
      if (scope?.sessionIdPrefix && !result.sessionId.startsWith(scope.sessionIdPrefix)) continue;
      if (scope?.eventTypes && scope.eventTypes.length > 0 && !scope.eventTypes.includes(result.eventType as MemoryEvent['eventType'])) continue;

      const event = await this.eventStore.getEvent(result.eventId);
      if (!event) continue;

      if (scope?.canonicalKeyPrefix && !event.canonicalKey.startsWith(scope.canonicalKeyPrefix)) continue;
      if (normalizedIncludes.length > 0) {
        const lc = event.content.toLowerCase();
        if (!normalizedIncludes.some((needle) => lc.includes(needle))) continue;
      }
      if (scope?.metadata && !this.matchesMetadataScope(event.metadata, scope.metadata)) continue;

      const projectHash = this.extractProjectHash(event.metadata);
      filtered.push({ result, projectHash });
    }

    let scopedResults: DebuggableSearchResult[];
    if (projectScopeMode === 'global' || allowedProjectHashes.size === 0) {
      scopedResults = filtered.map((x) => x.result);
    } else {
      const projectMatched = filtered.filter((x) => x.projectHash && allowedProjectHashes.has(x.projectHash));
      scopedResults = projectScopeMode === 'strict'
        ? projectMatched.map((x) => x.result)
        : (projectMatched.length > 0 ? projectMatched : filtered).map((x) => x.result);
    }

    return this.applyFacetFilters(scopedResults, {
      facets: facetFilters,
      projectHash: options?.projectHash
    });
  }

  private normalizeFacetFilters(facets: RetrievalFacetFilter[] | undefined): RetrievalFacetFilter[] | null {
    if (!facets || facets.length === 0) return null;

    const normalized: RetrievalFacetFilter[] = [];
    for (const facet of facets) {
      const parsedDimension = FacetDimensionSchema.safeParse(facet.dimension);
      const value = typeof facet.value === 'string' ? facet.value.trim() : '';
      if (!parsedDimension.success || !value) return [];
      normalized.push({ dimension: parsedDimension.data, value });
    }

    return normalized;
  }

  private async applyFacetFilters(
    results: DebuggableSearchResult[],
    options: { facets: RetrievalFacetFilter[] | null; projectHash?: string }
  ): Promise<DebuggableSearchResult[]> {
    if (options.facets === null) return results;
    if (options.facets.length === 0) return [];
    if (!options.projectHash) return [];
    if (!this.eventStore.getDatabase) return [];

    const repo = new FacetRepository(this.eventStore.getDatabase());
    const filtered: DebuggableSearchResult[] = [];

    for (const result of results) {
      const matches: RetrievalFacetFilter[] = [];
      let matchedAll = true;
      for (const facet of options.facets) {
        const rows = await repo.query({
          targetType: 'event',
          targetId: result.eventId,
          dimension: facet.dimension,
          value: facet.value,
          projectHash: options.projectHash
        });
        if (rows.length === 0) {
          matchedAll = false;
          break;
        }
        matches.push(facet);
      }

      if (matchedAll) {
        const facetLanes: RetrievalDebugLane[] = matches.map((match) => ({
          lane: 'facet_match',
          reason: `${match.dimension}=${match.value}`
        }));
        filtered.push({
          ...result,
          facetMatches: matches,
          lanes: mergeRetrievalLanes(result.lanes ?? [], facetLanes)
        });
      }
    }

    return filtered;
  }

  private debugDetailForResult(result: DebuggableSearchResult): RetrievalDebugDetail {
    const detail: RetrievalDebugDetail = {
      eventId: result.eventId,
      score: result.score,
      semanticScore: result.semanticScore,
      lexicalScore: result.lexicalScore,
      recencyScore: result.recencyScore
    };
    if (result.facetMatches && result.facetMatches.length > 0) {
      detail.facetMatches = result.facetMatches;
    }
    if (result.graphPaths && result.graphPaths.length > 0) {
      detail.graphPaths = result.graphPaths;
    }
    if (result.lanes && result.lanes.length > 0) {
      detail.lanes = result.lanes;
    }
    return detail;
  }

  private isGraphPathResult(result: DebuggableSearchResult): boolean {
    return (result.graphPaths || []).length > 0;
  }

  private extractProjectHash(metadata: Record<string, unknown> | undefined): string | undefined {
    if (!metadata || typeof metadata !== 'object') return undefined;
    const scope = metadata.scope;
    if (!scope || typeof scope !== 'object') return undefined;
    const project = (scope as Record<string, unknown>).project;
    if (!project || typeof project !== 'object') return undefined;
    const hash = (project as Record<string, unknown>).hash;
    return typeof hash === 'string' && hash.length > 0 ? hash : undefined;
  }

  async retrieveFromSession(sessionId: string): Promise<MemoryEvent[]> {
    return this.eventStore.getSessionEvents(sessionId);
  }

  async retrieveRecent(limit: number = 100): Promise<MemoryEvent[]> {
    return this.eventStore.getRecentEvents(limit);
  }

  private async enrichResults(results: SearchResult[], options: RetrievalOptions, query: string): Promise<MemoryWithContext[]> {
    const memories: MemoryWithContext[] = [];

    for (const result of results) {
      const event = await this.eventStore.getEvent(result.eventId);
      if (!event) continue;

      if (this.graduation) {
        this.graduation.recordAccess(event.id, options.sessionId || 'unknown', result.score);
      }

      let sessionContext: string | undefined;
      if (options.includeSessionContext) {
        sessionContext = await this.getSessionContext(event.sessionId, event.id, query);
      }

      memories.push({ event, score: result.score, sessionContext });
    }

    return memories;
  }

  private async getSessionContext(sessionId: string, eventId: string, query: string): Promise<string | undefined> {
    const sessionEvents = await this.eventStore.getSessionEvents(sessionId);
    const eventIndex = sessionEvents.findIndex(e => e.id === eventId);
    if (eventIndex === -1) return undefined;

    const start = Math.max(0, eventIndex - 1);
    const end = Math.min(sessionEvents.length, eventIndex + 2);
    const contextEvents = sessionEvents.slice(start, end);
    if (contextEvents.length <= 1) return undefined;

    const suppressStaleState = isCurrentStateQuery(query);
    const contextLines = contextEvents
      .filter(e => e.id !== eventId)
      .filter(e => !isLowSignalContextContent(e.content))
      .filter(e => !(suppressStaleState && isStaleOrSupersededContent(e.content)))
      .map(e => `[${e.eventType}]: ${e.content.slice(0, 200)}...`);

    return contextLines.length > 0 ? contextLines.join('\n') : undefined;
  }

  private buildUnifiedContext(projectResult: RetrievalResult, sharedMemories: SharedTroubleshootingEntry[]): string {
    let context = projectResult.context;
    if (sharedMemories.length === 0) return context;

    context += '\n\n## Cross-Project Knowledge\n\n';
    for (const memory of sharedMemories.slice(0, 3)) {
      context += `### ${memory.title}\n`;
      if (memory.symptoms.length > 0) context += `**Symptoms:** ${memory.symptoms.join(', ')}\n`;
      context += `**Root Cause:** ${memory.rootCause}\n`;
      context += `**Solution:** ${memory.solution}\n`;
      if (memory.technologies && memory.technologies.length > 0) context += `**Technologies:** ${memory.technologies.join(', ')}\n`;
      context += `_Confidence: ${(memory.confidence * 100).toFixed(0)}%_\n\n`;
    }

    return context;
  }

  private buildContext(memories: MemoryWithContext[], maxTokens: number): string {
    const parts: string[] = [];
    let currentTokens = 0;

    for (const memory of memories) {
      const memoryText = this.formatMemory(memory);
      const memoryTokens = this.estimateTokens(memoryText);
      if (currentTokens + memoryTokens > maxTokens) break;
      parts.push(memoryText);
      currentTokens += memoryTokens;
    }

    if (parts.length === 0) return '';
    return `## Relevant Memories\n\n${parts.join('\n\n---\n\n')}`;
  }

  private formatMemory(memory: MemoryWithContext): string {
    const { event, score, sessionContext } = memory;
    const date = event.timestamp.toISOString().split('T')[0];

    let text = `**${event.eventType}** (${date}, score: ${score.toFixed(2)})\n${event.content}`;
    if (sessionContext) text += `\n\n_Context:_ ${sessionContext}`;
    return text;
  }

  private matchesMetadataScope(
    metadata: Record<string, unknown> | undefined,
    expected: Record<string, unknown>
  ): boolean {
    if (!metadata) return false;

    return Object.entries(expected).every(([path, value]) => {
      const actual = path.split('.').reduce<unknown>((acc, key) => {
        if (typeof acc !== 'object' || acc === null) return undefined;
        return (acc as Record<string, unknown>)[key];
      }, metadata);

      return actual === value;
    });
  }

  private tokenize(text: string): string[] {
    return text
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .map((token) => this.normalizeToken(token))
      .filter((t) => t.length >= 2)
      .slice(0, 64);
  }

  private normalizeToken(token: string): string {
    if (token === 'apis') return 'api';
    if (token === 'ids') return 'id';
    if (token === 'does') return token;
    if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
    if (
      token.length > 3 &&
      token.endsWith('s') &&
      !token.endsWith('ss') &&
      !token.endsWith('us') &&
      !token.endsWith('is') &&
      !token.endsWith('ps')
    ) {
      return token.slice(0, -1);
    }
    return token;
  }

  private keywordOverlap(a: string[], b: string[]): number {
    if (a.length === 0 || b.length === 0) return 0;
    const bs = new Set(b);
    let hit = 0;
    for (const t of a) if (bs.has(t)) hit += 1;
    return hit / a.length;
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

function withRetrievalLane(result: DebuggableSearchResult, lane: RetrievalDebugLane): DebuggableSearchResult {
  const existing = (result as DebuggableSearchResult).lanes ?? [];
  return {
    ...result,
    lanes: mergeRetrievalLanes(existing, [lane])
  };
}

function mergeRetrievalLanes(
  existing: RetrievalDebugLane[],
  incoming: RetrievalDebugLane[]
): RetrievalDebugLane[] {
  return normalizeRetrievalDebugLanes([...existing, ...incoming]);
}

function uniqueEntityStartNodes(
  candidates: Array<{ entityId?: string; text: string }>
): Array<{ entityId: string; title: string }> {
  const seen = new Set<string>();
  const nodes: Array<{ entityId: string; title: string }> = [];
  for (const candidate of candidates) {
    if (!candidate.entityId || seen.has(candidate.entityId)) continue;
    seen.add(candidate.entityId);
    nodes.push({ entityId: candidate.entityId, title: candidate.text });
  }
  return nodes;
}

function toRetrievalGraphPathDebug(
  path: GraphPathResult,
  titleByEntityId: Map<string, string>
): RetrievalGraphPathDebug {
  const firstStep = path.steps[0];
  const startNode = firstStep?.direction === 'incoming'
    ? firstStep.to
    : firstStep?.from;
  const startEntityId = startNode?.type === 'entity' ? startNode.id : '';

  return {
    startEntityId,
    startEntityTitle: titleByEntityId.get(startEntityId) ?? startNode?.name,
    targetId: path.target.id,
    targetType: path.target.type,
    hops: path.hops,
    relationPath: path.steps.map((step) => step.relationType)
  };
}

function graphPathScore(path: GraphPathResult, hopPenalty: number): number {
  const base = Math.min(0.95, Math.max(0, path.scoreContribution));
  return Math.max(0.05, base - hopPenalty * Math.max(0, path.hops - 1));
}

function clampGraphHops(maxHops: number): number {
  if (!Number.isFinite(maxHops)) return 2;
  return Math.min(Math.max(0, Math.trunc(maxHops)), 2);
}

function mergeGraphPaths(
  existing: RetrievalGraphPathDebug[],
  incoming: RetrievalGraphPathDebug[]
): RetrievalGraphPathDebug[] {
  const byKey = new Map<string, RetrievalGraphPathDebug>();
  for (const path of [...existing, ...incoming]) {
    const key = [path.startEntityId, path.targetType, path.targetId, path.hops, ...path.relationPath].join('\u0000');
    if (!byKey.has(key)) byKey.set(key, path);
  }
  return [...byKey.values()]
    .sort((a, b) => a.hops - b.hops || compareStable(graphPathSignature(a), graphPathSignature(b)))
    .slice(0, 3);
}

function graphPathSignature(path: RetrievalGraphPathDebug): string {
  return [path.startEntityId, path.targetType, path.targetId, path.hops, ...path.relationPath].join('|');
}

function compareStable(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function createRetriever(
  eventStore: EventStore,
  vectorStore: VectorStore,
  embedder: Embedder,
  matcher: Matcher,
  sharedOptions?: SharedStoreOptions
): Retriever {
  return new Retriever(eventStore, vectorStore, embedder, matcher, sharedOptions);
}
