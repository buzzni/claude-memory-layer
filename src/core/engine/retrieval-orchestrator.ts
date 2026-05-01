/**
 * Retrieval Orchestrator
 *
 * Coordinates MemoryService-level retrieval concerns around the lower-level
 * Retriever: initialization, rerank policy, project/shared scoping, optional
 * intent rewriting, and non-blocking retrieval trace telemetry.
 */

import {
  Retriever,
  type ProjectScopeMode,
  type RetrievalResult,
  type RetrievalStrategy,
  type UnifiedRetrievalResult
} from '../retriever.js';

export interface RetrieveMemoriesOptions {
  topK?: number;
  minScore?: number;
  sessionId?: string;
  includeShared?: boolean;
  adaptiveRerank?: boolean;
  intentRewrite?: boolean;
  projectScopeMode?: ProjectScopeMode;
  allowedProjectHashes?: string[];
  strategy?: RetrievalStrategy;
}

export interface RecordQueryTraceInput {
  sessionId: string;
  queryText: string;
  strategy: string;
  candidateEventIds: string[];
  selectedEventIds: string[];
  confidence: string;
}

interface HelpfulnessStats {
  avgScore: number;
  totalEvaluated: number;
  totalRetrievals: number;
  helpful: number;
  neutral: number;
  unhelpful: number;
}

type RerankWeights = {
  semantic: number;
  lexical: number;
  recency: number;
};

interface RetrievalTraceDetail {
  eventId: string;
  score: number;
  semanticScore?: number;
  lexicalScore?: number;
  recencyScore?: number;
}

export interface RetrievalTraceStore {
  getHelpfulnessStats(): Promise<HelpfulnessStats>;
  recordRetrievalTrace(input: {
    sessionId?: string;
    projectHash?: string;
    queryText: string;
    strategy?: string;
    candidateEventIds: string[];
    selectedEventIds: string[];
    candidateDetails?: RetrievalTraceDetail[];
    selectedDetails?: RetrievalTraceDetail[];
    confidence?: string;
    fallbackTrace?: string[];
  }): Promise<void>;
}

export interface RetrievalAccessStore {
  incrementAccessCount(eventIds: string[]): Promise<void>;
  recordRetrieval(eventId: string, sessionId: string, score: number, query: string): Promise<void>;
}

export interface RetrievalOrchestratorDeps {
  initialize: () => Promise<void>;
  retriever: Retriever;
  traceStore: RetrievalTraceStore;
  accessStore: RetrievalAccessStore;
  getProjectHash: () => string | null;
  hasSharedStore: () => boolean;
}

export class RetrievalOrchestrator {
  constructor(private readonly deps: RetrievalOrchestratorDeps) {
    this.deps.retriever.setQueryRewriter((query) => this.rewriteQueryIntent(query));
  }

  /**
   * Retrieve relevant memories for a query.
   */
  async retrieveMemories(
    query: string,
    options?: RetrieveMemoriesOptions
  ): Promise<UnifiedRetrievalResult> {
    await this.deps.initialize();

    // Note: Pending embeddings are processed by the background worker.
    // Don't block retrieval - search with whatever vectors are available.
    const rerankWeights = await this.getRerankWeights(options?.adaptiveRerank === true);
    const projectHash = this.deps.getProjectHash();
    const projectScopeMode = options?.projectScopeMode ?? (projectHash ? 'strict' : 'global');

    let result: UnifiedRetrievalResult;

    if (options?.includeShared && this.deps.hasSharedStore()) {
      result = await this.deps.retriever.retrieveUnified(query, {
        ...options,
        intentRewrite: options.intentRewrite === true,
        rerankWeights,
        includeShared: true,
        projectHash: projectHash || undefined,
        projectScopeMode,
        allowedProjectHashes: options.allowedProjectHashes
      });
    } else {
      result = await this.deps.retriever.retrieve(query, {
        ...options,
        intentRewrite: options?.intentRewrite === true,
        rerankWeights,
        projectHash: projectHash || undefined,
        projectScopeMode,
        allowedProjectHashes: options?.allowedProjectHashes
      });
    }

    try {
      await this.recordAutomaticTrace(query, result, options, projectHash);
    } catch {
      // Non-blocking telemetry.
    }

    return result;
  }

  /**
   * Format retrieval results as context for Claude.
   */
  formatAsContext(result: RetrievalResult): string {
    if (!result.context) {
      return '';
    }

    const confidence = result.matchResult.confidence;
    let header = '';

    if (confidence === 'high') {
      header = '🎯 **High-confidence memory match found:**\n\n';
    } else if (confidence === 'suggested') {
      header = '💡 **Suggested memories (may be relevant):**\n\n';
    }

    return header + result.context;
  }

  /**
   * Record a query-level retrieval trace used by hooks and dashboard stats.
   */
  async recordQueryTrace(input: RecordQueryTraceInput): Promise<void> {
    await this.deps.initialize();
    await this.deps.traceStore.recordRetrievalTrace({
      ...input,
      projectHash: this.deps.getProjectHash() || undefined,
      candidateDetails: [],
      selectedDetails: [],
      fallbackTrace: [],
    });
  }

  /**
   * Increment access count for memories that were injected into prompts.
   *
   * Access count writes are intentionally store-scoped: the SQLite access store
   * initializes itself and no-ops in read-only mode, so this avoids triggering
   * the heavier retrieval/vector initialization path for prompt telemetry.
   */
  async incrementMemoryAccess(eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return;

    await this.deps.accessStore.incrementAccessCount(eventIds);
  }

  /**
   * Record a selected retrieval for helpfulness analytics.
   */
  async recordRetrieval(
    eventId: string,
    sessionId: string,
    score: number,
    query: string
  ): Promise<void> {
    await this.deps.initialize();
    await this.deps.accessStore.recordRetrieval(eventId, sessionId, score, query);
  }

  private async recordAutomaticTrace(
    query: string,
    result: UnifiedRetrievalResult,
    options: RetrieveMemoriesOptions | undefined,
    projectHash: string | null
  ): Promise<void> {
    const selectedEventIds = result.memories.map((memory) => memory.event.id);
    const selectedDetails = (result.selectedDebug || []).map((detail) => ({
      eventId: detail.eventId,
      score: detail.score,
      semanticScore: detail.semanticScore,
      lexicalScore: detail.lexicalScore,
      recencyScore: detail.recencyScore,
    }));
    const candidateDetails = (result.candidateDebug || []).map((detail) => ({
      eventId: detail.eventId,
      score: detail.score,
      semanticScore: detail.semanticScore,
      lexicalScore: detail.lexicalScore,
      recencyScore: detail.recencyScore,
    }));
    const candidateEventIds = candidateDetails.length > 0
      ? candidateDetails.map((detail) => detail.eventId)
      : selectedEventIds;

    await this.deps.traceStore.recordRetrievalTrace({
      sessionId: options?.sessionId,
      projectHash: projectHash || undefined,
      queryText: query,
      strategy: options?.strategy || 'auto',
      candidateEventIds,
      selectedEventIds,
      candidateDetails,
      selectedDetails,
      confidence: result.matchResult.confidence,
      fallbackTrace: result.fallbackTrace || []
    });
  }

  private getConfiguredRerankWeights(): RerankWeights | undefined {
    const semantic = Number(process.env.MEMORY_RERANK_WEIGHT_SEMANTIC ?? '');
    const lexical = Number(process.env.MEMORY_RERANK_WEIGHT_LEXICAL ?? '');
    const recency = Number(process.env.MEMORY_RERANK_WEIGHT_RECENCY ?? '');

    const allFinite = [semantic, lexical, recency].every((value) => Number.isFinite(value));
    if (!allFinite) return undefined;

    const nonNegative = [semantic, lexical, recency].every((value) => value >= 0);
    const total = semantic + lexical + recency;
    if (!nonNegative || total <= 0) return undefined;

    return {
      semantic: semantic / total,
      lexical: lexical / total,
      recency: recency / total,
    };
  }

  private async getRerankWeights(adaptive: boolean): Promise<RerankWeights | undefined> {
    const configured = this.getConfiguredRerankWeights();
    if (configured) return configured;
    if (adaptive) return this.getAdaptiveRerankWeights();
    return undefined;
  }

  private async getAdaptiveRerankWeights(): Promise<RerankWeights | undefined> {
    try {
      const stats = await this.deps.traceStore.getHelpfulnessStats();
      if (stats.totalEvaluated < 20) return undefined;

      // Base weights.
      let semantic = 0.7;
      let lexical = 0.2;
      let recency = 0.1;

      if (stats.avgScore < 0.45) {
        semantic -= 0.1;
        lexical += 0.1;
      } else if (stats.avgScore > 0.75) {
        semantic += 0.05;
        lexical -= 0.05;
      }

      if (stats.unhelpful > stats.helpful) {
        recency += 0.05;
        semantic -= 0.03;
        lexical -= 0.02;
      }

      return { semantic, lexical, recency };
    } catch {
      return undefined;
    }
  }

  private async rewriteQueryIntent(query: string): Promise<string | null> {
    if (process.env.MEMORY_INTENT_REWRITE_ENABLED !== '1') return null;

    const apiUrl = process.env.COMPANY_STOCK_API_URL || process.env.COMPANY_INT_API_URL;
    if (!apiUrl) return null;

    const controller = new AbortController();
    const timeoutMs = Number(process.env.MEMORY_INTENT_REWRITE_TIMEOUT_MS || 5000);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const prompt = [
        'Rewrite user query for memory retrieval intent expansion.',
        'Return plain text only, one line, no markdown.',
        `Query: ${query}`,
      ].join('\n');

      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: '*/*',
          Origin: process.env.COMPANY_INT_ORIGIN || 'http://company-int.aplusai.ai',
          Referer: process.env.COMPANY_INT_REFERER || 'http://company-int.aplusai.ai/',
        },
        body: JSON.stringify({
          question: prompt,
          company_name: null,
          conversation_id: null,
        }),
        signal: controller.signal,
      });

      const text = (await res.text()).trim();
      if (!text) return null;

      const oneLine = text
        .replace(/^data:\s*/gm, '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .join(' ')
        .slice(0, 240);

      if (!oneLine || oneLine.toLowerCase() === query.toLowerCase()) return null;
      return oneLine;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createRetrievalOrchestrator(
  deps: RetrievalOrchestratorDeps
): RetrievalOrchestrator {
  return new RetrievalOrchestrator(deps);
}
