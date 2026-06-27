/**
 * Retrieval Analytics Service
 *
 * Owns retrieval telemetry read-model and helpfulness evaluation workflows so
 * MemoryService can remain a thin facade over focused engine services.
 */

import type { RetrievalDebugLane } from '../retrieval-debug-lanes.js';
import type { MemoryEvent } from '../types.js';

export interface RetrievalTraceStrategyStats {
  strategy: string;
  totalQueries: number;
  queriesWithSelection: number;
  rewrittenQueries: number;
  rewriteRate: number;
  totalCandidateCount: number;
  totalSelectedCount: number;
  avgCandidateCount: number;
  avgSelectedCount: number;
  selectionRate: number;
  queryYieldRate: number;
}

export interface RetrievalTraceStats {
  totalQueries: number;
  avgCandidateCount: number;
  avgSelectedCount: number;
  selectionRate: number;
  rewrittenQueries?: number;
  rewriteRate?: number;
  rewrittenQueriesWithSelection?: number;
  rawQueriesWithSelection?: number;
  rewrittenSelectionRate?: number;
  rawSelectionRate?: number;
  avgSelectedCountForRewrittenQueries?: number;
  avgSelectedCountForRawQueries?: number;
  strategyBreakdown?: RetrievalTraceStrategyStats[];
}

export interface HelpfulnessStats {
  avgScore: number;
  totalEvaluated: number;
  totalRetrievals: number;
  helpful: number;
  neutral: number;
  unhelpful: number;
}

export interface HelpfulMemory {
  eventId: string;
  summary: string;
  helpfulnessScore: number;
  accessCount: number;
  evaluationCount: number;
}

export interface RetrievalTraceDetail {
  eventId: string;
  score: number;
  semanticScore?: number;
  lexicalScore?: number;
  recencyScore?: number;
  lanes?: RetrievalDebugLane[];
}

export interface RetrievalTrace {
  traceId: string;
  sessionId?: string;
  projectHash?: string;
  queryText: string;
  rawQueryText?: string;
  queryRewriteKind?: string;
  strategy?: string;
  candidateEventIds: string[];
  selectedEventIds: string[];
  candidateDetails: RetrievalTraceDetail[];
  selectedDetails: RetrievalTraceDetail[];
  candidateCount: number;
  selectedCount: number;
  confidence?: string;
  fallbackTrace: string[];
  createdAt: Date;
}

export interface AccessedMemory {
  memoryId: string;
  summary: string;
  topics: string[];
  accessCount: number;
  lastAccessed: string | null;
  confidence: number;
  createdAt: Date;
}

type AccessedMemoryEvent = MemoryEvent & {
  access_count?: number;
  last_accessed_at?: string | null;
};

export interface RetrievalAnalyticsStore {
  getRetrievalTraceStats(): Promise<RetrievalTraceStats>;
  getRecentRetrievalTraces(limit?: number): Promise<RetrievalTrace[]>;
  getMostAccessed(limit?: number): Promise<AccessedMemoryEvent[]>;
  evaluateSessionHelpfulness(sessionId: string): Promise<void>;
  getUnevaluatedSessions(currentSessionId: string, limit?: number): Promise<string[]>;
  getHelpfulMemories(limit?: number): Promise<HelpfulMemory[]>;
  getHelpfulnessStats(since?: Date): Promise<HelpfulnessStats>;
}

export interface RetrievalAnalyticsServiceDeps {
  initialize: () => Promise<void>;
  retrievalStore: RetrievalAnalyticsStore;
}

export class RetrievalAnalyticsService {
  constructor(private readonly deps: RetrievalAnalyticsServiceDeps) {}

  async getRetrievalTraceStats(): Promise<RetrievalTraceStats> {
    await this.deps.initialize();
    return this.deps.retrievalStore.getRetrievalTraceStats();
  }

  async getRecentRetrievalTraces(limit: number = 50): Promise<RetrievalTrace[]> {
    await this.deps.initialize();
    return this.deps.retrievalStore.getRecentRetrievalTraces(limit);
  }

  async getMostAccessedMemories(limit: number = 10): Promise<AccessedMemory[]> {
    // Preserve the historical lightweight path: SQLiteEventStore.getMostAccessed()
    // initializes itself and no-ops safely in read-only scenarios, so dashboard
    // access summaries should not trigger vector/embedder/worker initialization.
    const events = await this.deps.retrievalStore.getMostAccessed(limit);

    return events.map((event) => ({
      memoryId: event.id,
      summary: event.content.substring(0, 200) + (event.content.length > 200 ? '...' : ''),
      topics: this.extractTopicsFromContent(event.content),
      accessCount: event.access_count || 0,
      lastAccessed: event.last_accessed_at || null,
      confidence: 1.0,
      createdAt: event.timestamp,
    }));
  }

  async evaluateSessionHelpfulness(sessionId: string): Promise<void> {
    await this.deps.initialize();
    await this.deps.retrievalStore.evaluateSessionHelpfulness(sessionId);
  }

  async evaluatePendingSessions(currentSessionId: string, limit: number = 5): Promise<void> {
    await this.deps.initialize();
    const sessions = await this.deps.retrievalStore.getUnevaluatedSessions(currentSessionId, limit);

    for (const sessionId of sessions) {
      try {
        await this.deps.retrievalStore.evaluateSessionHelpfulness(sessionId);
      } catch {
        // Best-effort backfill: one broken session should not block hook startup.
      }
    }
  }

  async getHelpfulMemories(limit: number = 10): Promise<HelpfulMemory[]> {
    await this.deps.initialize();
    return this.deps.retrievalStore.getHelpfulMemories(limit);
  }

  async getHelpfulnessStats(since?: Date): Promise<HelpfulnessStats> {
    await this.deps.initialize();
    return this.deps.retrievalStore.getHelpfulnessStats(since);
  }

  /**
   * Extract topic keywords from event content (markdown headings and key terms).
   */
  private extractTopicsFromContent(content: string): string[] {
    const topics: Set<string> = new Set();

    const headings = content.match(/^#{1,3}\s+(.+)$/gm);
    if (headings) {
      for (const heading of headings.slice(0, 5)) {
        const text = heading.replace(/^#+\s+/, '').replace(/[*_`#]/g, '').trim();
        if (text.length > 2 && text.length < 50) {
          topics.add(text);
        }
      }
    }

    const boldTerms = content.match(/\*\*([^*]+)\*\*/g);
    if (boldTerms) {
      for (const boldTerm of boldTerms.slice(0, 5)) {
        const text = boldTerm.replace(/\*\*/g, '').trim();
        if (text.length > 2 && text.length < 30) {
          topics.add(text);
        }
      }
    }

    return Array.from(topics).slice(0, 5);
  }
}

export function createRetrievalAnalyticsService(
  deps: RetrievalAnalyticsServiceDeps
): RetrievalAnalyticsService {
  return new RetrievalAnalyticsService(deps);
}
