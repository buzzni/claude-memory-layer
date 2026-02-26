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
import type { MemoryEvent, MatchResult, SharedTroubleshootingEntry } from './types.js';

export interface RetrievalScope {
  sessionId?: string;
  eventTypes?: MemoryEvent['eventType'][];
  metadata?: Record<string, unknown>;
  canonicalKeyPrefix?: string;
  sessionIdPrefix?: string;
  contentIncludes?: string[];
}

export type RetrievalStrategy = 'auto' | 'fast' | 'deep';
export type ProjectScopeMode = 'strict' | 'prefer' | 'global';

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
  projectScopeMode?: ProjectScopeMode;
  projectHash?: string;
  allowedProjectHashes?: string[];
}

export interface RetrievalResult {
  memories: MemoryWithContext[];
  matchResult: MatchResult;
  totalTokens: number;
  context: string;
  fallbackTrace?: string[];
  selectedDebug?: Array<{
    eventId: string;
    score: number;
    semanticScore?: number;
    lexicalScore?: number;
    recencyScore?: number;
  }>;
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
}

type EventStoreLike = EventStore & {
  keywordSearch?: (query: string, limit?: number) => Promise<Array<{ event: MemoryEvent; rank: number }>>;
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
    const sessionFilter = opts.scope?.sessionId ?? opts.sessionId;
    const fallbackTrace: string[] = [];

    const fallbackEnabled = (opts.strategy ?? 'auto') === 'auto';

    // Stage 1: primary retrieval
    const primaryStrategy: RetrievalStrategy = opts.strategy === 'auto' ? 'fast' : (opts.strategy || 'fast');
    let current = await this.runStage(query, {
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
      projectScopeMode: opts.projectScopeMode,
      projectHash: opts.projectHash,
      allowedProjectHashes: opts.allowedProjectHashes
    });
    fallbackTrace.push(`stage:primary:${primaryStrategy}`);

    // Stage 2: deep fallback
    if (fallbackEnabled && this.shouldFallback(current.matchResult, current.results) && primaryStrategy !== 'deep') {
      current = await this.runStage(query, {
        strategy: 'deep',
        topK: opts.topK,
        minScore: opts.minScore,
        sessionId: sessionFilter,
        scope: opts.scope,
        rerankWithKeyword: opts.rerankWithKeyword !== false,
        rerankWeights: opts.rerankWeights,
        decayPolicy: opts.decayPolicy,
        graphHop: opts.graphHop,
        projectScopeMode: opts.projectScopeMode,
        projectHash: opts.projectHash,
        allowedProjectHashes: opts.allowedProjectHashes
      });
      fallbackTrace.push('fallback:deep');
    }

    // Stage 3: scope-expanded deep fallback
    if (fallbackEnabled && this.shouldFallback(current.matchResult, current.results)) {
      current = await this.runStage(query, {
        strategy: 'deep',
        topK: opts.topK,
        minScore: Math.max(0.5, opts.minScore - 0.15),
        sessionId: undefined,
        scope: undefined,
        rerankWithKeyword: true,
        rerankWeights: opts.rerankWeights,
        decayPolicy: opts.decayPolicy,
        graphHop: opts.graphHop,
        projectScopeMode: opts.projectScopeMode,
        projectHash: opts.projectHash,
        allowedProjectHashes: opts.allowedProjectHashes
      });
      fallbackTrace.push('fallback:scope-expanded');
    }

    // Stage 4: summary fallback
    if (fallbackEnabled && this.shouldFallback(current.matchResult, current.results)) {
      const summary = await this.buildSummaryFallback(query, opts.topK);
      current = {
        results: summary,
        matchResult: this.matcher.matchSearchResults(summary, () => 0)
      };
      fallbackTrace.push('fallback:summary');
    }

    const memories = await this.enrichResults(current.results.slice(0, opts.topK), opts as RetrievalOptions);
    const context = this.buildContext(memories, opts.maxTokens);

    return {
      memories,
      matchResult: current.matchResult,
      totalTokens: this.estimateTokens(context),
      context,
      fallbackTrace,
      selectedDebug: current.results.slice(0, opts.topK).map((r: SearchResult & { semanticScore?: number; lexicalScore?: number; recencyScore?: number }) => ({
        eventId: r.eventId,
        score: r.score,
        semanticScore: r.semanticScore,
        lexicalScore: r.lexicalScore,
        recencyScore: r.recencyScore,
      }))
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
      strategy: RetrievalStrategy;
      topK: number;
      minScore: number;
      sessionId?: string;
      scope?: RetrievalScope;
      rerankWithKeyword: boolean;
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
      projectScopeMode?: ProjectScopeMode;
      projectHash?: string;
      allowedProjectHashes?: string[];
    }
  ): Promise<{ results: SearchResult[]; matchResult: MatchResult }> {
    let initialResults = await this.searchByStrategy(query, {
      strategy: input.strategy,
      topK: input.topK,
      minScore: input.minScore,
      sessionId: input.sessionId
    });

    if (input.intentRewrite && input.strategy === 'deep' && this.queryRewriter) {
      const rewritten = (await this.queryRewriter(query))?.trim();
      if (rewritten && rewritten !== query) {
        const rewrittenResults = await this.searchByStrategy(rewritten, {
          strategy: 'deep',
          topK: input.topK,
          minScore: Math.max(0.5, input.minScore - 0.1),
          sessionId: input.sessionId
        });
        initialResults = this.mergeResults(initialResults, rewrittenResults, input.topK * 3);
      }
    }

    const expandedResults = input.graphHop?.enabled === false
      ? initialResults
      : await this.expandGraphHops(initialResults, {
          maxHops: Math.max(1, input.graphHop?.maxHops ?? 1),
          hopPenalty: Math.max(0, input.graphHop?.hopPenalty ?? 0.08),
          limit: input.topK * 4,
        });

    const rerankedResults = input.rerankWithKeyword
      ? this.rerankByKeywordOverlap(expandedResults, query, input.rerankWeights, input.decayPolicy)
      : expandedResults;

    const filtered = await this.applyScopeFilters(rerankedResults, {
      scope: input.scope,
      projectScopeMode: input.projectScopeMode,
      projectHash: input.projectHash,
      allowedProjectHashes: input.allowedProjectHashes
    });
    const top = filtered.slice(0, input.topK);
    const matchResult = this.matcher.matchSearchResults(top, () => 0);

    return { results: top, matchResult };
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

  private async expandGraphHops(
    seeds: SearchResult[],
    opts: { maxHops: number; hopPenalty: number; limit: number }
  ): Promise<SearchResult[]> {
    const byId = new Map<string, SearchResult>();
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
          const row: SearchResult = {
            id: `hop-${hop}-${rid}`,
            eventId: target.id,
            content: target.content,
            score,
            sessionId: target.sessionId,
            eventType: target.eventType,
            timestamp: target.timestamp.toISOString(),
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

    return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, opts.limit);
  }

  private shouldFallback(matchResult: MatchResult, results: SearchResult[]): boolean {
    if (results.length === 0) return true;
    if (matchResult.confidence === 'none') return true;
    return false;
  }

  private async buildSummaryFallback(query: string, topK: number): Promise<SearchResult[]> {
    const recent = await this.eventStore.getRecentEvents(Math.max(topK * 6, 20));
    const q = this.tokenize(query);

    const ranked = recent
      .map((e) => ({ e, overlap: this.keywordOverlap(q, this.tokenize(e.content)) }))
      .filter((r) => r.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, topK)
      .map((row, idx) => ({
        id: `summary-${row.e.id}`,
        eventId: row.e.id,
        content: row.e.content,
        score: Math.max(0.25, 0.6 - idx * 0.05),
        sessionId: row.e.sessionId,
        eventType: row.e.eventType,
        timestamp: row.e.timestamp.toISOString()
      }));

    return ranked;
  }

  private async searchByStrategy(
    query: string,
    input: { strategy: RetrievalStrategy; topK: number; minScore: number; sessionId?: string }
  ): Promise<SearchResult[]> {
    const strategy = input.strategy === 'auto' ? 'deep' : input.strategy;

    if (strategy === 'fast') {
      const keyword = await this.searchByKeyword(query, {
        limit: Math.max(5, input.topK * 3),
        sessionId: input.sessionId
      });
      return keyword;
    }

    const queryEmbedding = await this.embedder.embed(query);
    return this.vectorStore.search(queryEmbedding.vector, {
      limit: Math.max(5, input.topK * 3),
      minScore: input.minScore,
      sessionId: input.sessionId
    });
  }

  private async searchByKeyword(
    query: string,
    input: { limit: number; sessionId?: string }
  ): Promise<SearchResult[]> {
    if (this.eventStore.keywordSearch) {
      const rows = await this.eventStore.keywordSearch(query, input.limit);
      const filtered = input.sessionId ? rows.filter((r) => r.event.sessionId === input.sessionId) : rows;
      return filtered.map((row, idx) => ({
        id: `kw-${row.event.id}`,
        eventId: row.event.id,
        content: row.event.content,
        score: Math.max(0.4, 1 - idx * 0.04),
        sessionId: row.event.sessionId,
        eventType: row.event.eventType,
        timestamp: row.event.timestamp.toISOString()
      }));
    }

    const recent = await this.eventStore.getRecentEvents(input.limit * 4);
    const tokens = this.tokenize(query);
    const filtered = recent
      .filter((e) => (input.sessionId ? e.sessionId === input.sessionId : true))
      .map((e) => ({ e, overlap: this.keywordOverlap(tokens, this.tokenize(e.content)) }))
      .filter((r) => r.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, input.limit);

    return filtered.map((row, idx) => ({
      id: `kw-fallback-${row.e.id}`,
      eventId: row.e.id,
      content: row.e.content,
      score: Math.max(0.3, 0.9 - idx * 0.05),
      sessionId: row.e.sessionId,
      eventType: row.e.eventType,
      timestamp: row.e.timestamp.toISOString()
    }));
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
    results: SearchResult[],
    options?: {
      scope?: RetrievalScope;
      projectScopeMode?: ProjectScopeMode;
      projectHash?: string;
      allowedProjectHashes?: string[];
    }
  ): Promise<SearchResult[]> {
    const scope = options?.scope;
    const projectScopeMode = options?.projectScopeMode ?? 'global';
    const allowedProjectHashes = new Set(
      [options?.projectHash, ...(options?.allowedProjectHashes || [])].filter(
        (value): value is string => typeof value === 'string' && value.length > 0
      )
    );

    if (!scope && projectScopeMode === 'global') return results;

    const normalizedIncludes = (scope?.contentIncludes || []).map((s) => s.toLowerCase());
    const filtered: Array<{ result: SearchResult; projectHash?: string }> = [];

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

    if (projectScopeMode === 'global' || allowedProjectHashes.size === 0) {
      return filtered.map((x) => x.result);
    }

    const projectMatched = filtered.filter((x) => x.projectHash && allowedProjectHashes.has(x.projectHash));

    if (projectScopeMode === 'strict') {
      return projectMatched.map((x) => x.result);
    }

    return (projectMatched.length > 0 ? projectMatched : filtered).map((x) => x.result);
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

  private async enrichResults(results: SearchResult[], options: RetrievalOptions): Promise<MemoryWithContext[]> {
    const memories: MemoryWithContext[] = [];

    for (const result of results) {
      const event = await this.eventStore.getEvent(result.eventId);
      if (!event) continue;

      if (this.graduation) {
        this.graduation.recordAccess(event.id, options.sessionId || 'unknown', result.score);
      }

      let sessionContext: string | undefined;
      if (options.includeSessionContext) {
        sessionContext = await this.getSessionContext(event.sessionId, event.id);
      }

      memories.push({ event, score: result.score, sessionContext });
    }

    return memories;
  }

  private async getSessionContext(sessionId: string, eventId: string): Promise<string | undefined> {
    const sessionEvents = await this.eventStore.getSessionEvents(sessionId);
    const eventIndex = sessionEvents.findIndex(e => e.id === eventId);
    if (eventIndex === -1) return undefined;

    const start = Math.max(0, eventIndex - 1);
    const end = Math.min(sessionEvents.length, eventIndex + 2);
    const contextEvents = sessionEvents.slice(start, end);
    if (contextEvents.length <= 1) return undefined;

    return contextEvents
      .filter(e => e.id !== eventId)
      .map(e => `[${e.eventType}]: ${e.content.slice(0, 200)}...`)
      .join('\n');
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
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2)
      .slice(0, 64);
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

export function createRetriever(
  eventStore: EventStore,
  vectorStore: VectorStore,
  embedder: Embedder,
  matcher: Matcher
): Retriever {
  return new Retriever(eventStore, vectorStore, embedder, matcher);
}
