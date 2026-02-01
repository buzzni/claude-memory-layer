/**
 * Memory Retriever - Unified retrieval interface
 * Combines vector search, event store lookups, and matching
 */

import { EventStore } from './event-store.js';
import { VectorStore, SearchResult } from './vector-store.js';
import { Embedder } from './embedder.js';
import { Matcher } from './matcher.js';
import { SharedStore } from './shared-store.js';
import { SharedVectorStore } from './shared-vector-store.js';
import type { MemoryEvent, MatchResult, Config, SharedTroubleshootingEntry } from './types.js';

export interface RetrievalOptions {
  topK: number;
  minScore: number;
  sessionId?: string;
  maxTokens: number;
  includeSessionContext: boolean;
}

export interface RetrievalResult {
  memories: MemoryWithContext[];
  matchResult: MatchResult;
  totalTokens: number;
  context: string;
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
  includeSessionContext: true
};

export interface SharedStoreOptions {
  sharedStore?: SharedStore;
  sharedVectorStore?: SharedVectorStore;
}

export class Retriever {
  private readonly eventStore: EventStore;
  private readonly vectorStore: VectorStore;
  private readonly embedder: Embedder;
  private readonly matcher: Matcher;
  private sharedStore?: SharedStore;
  private sharedVectorStore?: SharedVectorStore;

  constructor(
    eventStore: EventStore,
    vectorStore: VectorStore,
    embedder: Embedder,
    matcher: Matcher,
    sharedOptions?: SharedStoreOptions
  ) {
    this.eventStore = eventStore;
    this.vectorStore = vectorStore;
    this.embedder = embedder;
    this.matcher = matcher;
    this.sharedStore = sharedOptions?.sharedStore;
    this.sharedVectorStore = sharedOptions?.sharedVectorStore;
  }

  /**
   * Set shared stores after construction
   */
  setSharedStores(sharedStore: SharedStore, sharedVectorStore: SharedVectorStore): void {
    this.sharedStore = sharedStore;
    this.sharedVectorStore = sharedVectorStore;
  }

  /**
   * Retrieve relevant memories for a query
   */
  async retrieve(
    query: string,
    options: Partial<RetrievalOptions> = {}
  ): Promise<RetrievalResult> {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    // Generate query embedding
    const queryEmbedding = await this.embedder.embed(query);

    // Search vector store
    const searchResults = await this.vectorStore.search(queryEmbedding.vector, {
      limit: opts.topK * 2, // Get extra for filtering
      minScore: opts.minScore,
      sessionId: opts.sessionId
    });

    // Get match result using AXIOMMIND matcher
    const matchResult = this.matcher.matchSearchResults(
      searchResults,
      (eventId) => this.getEventAgeDays(eventId)
    );

    // Enrich results with full event data and session context
    const memories = await this.enrichResults(searchResults.slice(0, opts.topK), opts);

    // Build context string
    const context = this.buildContext(memories, opts.maxTokens);

    return {
      memories,
      matchResult,
      totalTokens: this.estimateTokens(context),
      context
    };
  }

  /**
   * Retrieve with unified search (project + shared)
   */
  async retrieveUnified(
    query: string,
    options: Partial<UnifiedRetrievalOptions> = {}
  ): Promise<UnifiedRetrievalResult> {
    // Get project-local results first
    const projectResult = await this.retrieve(query, options);

    // If shared search is not requested or stores not available, return project results only
    if (!options.includeShared || !this.sharedStore || !this.sharedVectorStore) {
      return projectResult;
    }

    try {
      // Generate query embedding (reuse if possible)
      const queryEmbedding = await this.embedder.embed(query);

      // Vector search in shared store
      const sharedVectorResults = await this.sharedVectorStore.search(
        queryEmbedding.vector,
        {
          limit: options.topK || 5,
          minScore: options.minScore || 0.7,
          excludeProjectHash: options.projectHash
        }
      );

      // Get full entries from shared store
      const sharedMemories: SharedTroubleshootingEntry[] = [];
      for (const result of sharedVectorResults) {
        const entry = await this.sharedStore.get(result.entryId);
        if (entry) {
          // Exclude entries from current project if specified
          if (!options.projectHash || entry.sourceProjectHash !== options.projectHash) {
            sharedMemories.push(entry);
            // Record usage for ranking
            await this.sharedStore.recordUsage(entry.entryId);
          }
        }
      }

      // Build unified context
      const unifiedContext = this.buildUnifiedContext(projectResult, sharedMemories);

      return {
        ...projectResult,
        context: unifiedContext,
        totalTokens: this.estimateTokens(unifiedContext),
        sharedMemories
      };
    } catch (error) {
      // If shared search fails, return project results only
      console.error('Shared search failed:', error);
      return projectResult;
    }
  }

  /**
   * Build unified context combining project and shared memories
   */
  private buildUnifiedContext(
    projectResult: RetrievalResult,
    sharedMemories: SharedTroubleshootingEntry[]
  ): string {
    let context = projectResult.context;

    if (sharedMemories.length > 0) {
      context += '\n\n## Cross-Project Knowledge\n\n';
      for (const memory of sharedMemories.slice(0, 3)) {
        context += `### ${memory.title}\n`;
        if (memory.symptoms.length > 0) {
          context += `**Symptoms:** ${memory.symptoms.join(', ')}\n`;
        }
        context += `**Root Cause:** ${memory.rootCause}\n`;
        context += `**Solution:** ${memory.solution}\n`;
        if (memory.technologies && memory.technologies.length > 0) {
          context += `**Technologies:** ${memory.technologies.join(', ')}\n`;
        }
        context += `_Confidence: ${(memory.confidence * 100).toFixed(0)}%_\n\n`;
      }
    }

    return context;
  }

  /**
   * Retrieve memories from a specific session
   */
  async retrieveFromSession(sessionId: string): Promise<MemoryEvent[]> {
    return this.eventStore.getSessionEvents(sessionId);
  }

  /**
   * Get recent memories across all sessions
   */
  async retrieveRecent(limit: number = 100): Promise<MemoryEvent[]> {
    return this.eventStore.getRecentEvents(limit);
  }

  /**
   * Enrich search results with full event data
   */
  private async enrichResults(
    results: SearchResult[],
    options: RetrievalOptions
  ): Promise<MemoryWithContext[]> {
    const memories: MemoryWithContext[] = [];

    for (const result of results) {
      const event = await this.eventStore.getEvent(result.eventId);
      if (!event) continue;

      let sessionContext: string | undefined;
      if (options.includeSessionContext) {
        sessionContext = await this.getSessionContext(event.sessionId, event.id);
      }

      memories.push({
        event,
        score: result.score,
        sessionContext
      });
    }

    return memories;
  }

  /**
   * Get surrounding context from the same session
   */
  private async getSessionContext(
    sessionId: string,
    eventId: string
  ): Promise<string | undefined> {
    const sessionEvents = await this.eventStore.getSessionEvents(sessionId);

    // Find the event index
    const eventIndex = sessionEvents.findIndex(e => e.id === eventId);
    if (eventIndex === -1) return undefined;

    // Get 1 event before and after for context
    const start = Math.max(0, eventIndex - 1);
    const end = Math.min(sessionEvents.length, eventIndex + 2);
    const contextEvents = sessionEvents.slice(start, end);

    if (contextEvents.length <= 1) return undefined;

    return contextEvents
      .filter(e => e.id !== eventId)
      .map(e => `[${e.eventType}]: ${e.content.slice(0, 200)}...`)
      .join('\n');
  }

  /**
   * Build context string from memories (respecting token limit)
   */
  private buildContext(memories: MemoryWithContext[], maxTokens: number): string {
    const parts: string[] = [];
    let currentTokens = 0;

    for (const memory of memories) {
      const memoryText = this.formatMemory(memory);
      const memoryTokens = this.estimateTokens(memoryText);

      if (currentTokens + memoryTokens > maxTokens) {
        break;
      }

      parts.push(memoryText);
      currentTokens += memoryTokens;
    }

    if (parts.length === 0) {
      return '';
    }

    return `## Relevant Memories\n\n${parts.join('\n\n---\n\n')}`;
  }

  /**
   * Format a single memory for context
   */
  private formatMemory(memory: MemoryWithContext): string {
    const { event, score, sessionContext } = memory;
    const date = event.timestamp.toISOString().split('T')[0];

    let text = `**${event.eventType}** (${date}, score: ${score.toFixed(2)})\n${event.content}`;

    if (sessionContext) {
      text += `\n\n_Context:_ ${sessionContext}`;
    }

    return text;
  }

  /**
   * Estimate token count (rough approximation)
   */
  private estimateTokens(text: string): number {
    // Rough estimate: ~4 characters per token
    return Math.ceil(text.length / 4);
  }

  /**
   * Get event age in days (for recency scoring)
   */
  private getEventAgeDays(eventId: string): number {
    // This would ideally cache event timestamps
    // For now, return 0 (assume recent)
    return 0;
  }
}

/**
 * Create a retriever with default components
 */
export function createRetriever(
  eventStore: EventStore,
  vectorStore: VectorStore,
  embedder: Embedder,
  matcher: Matcher
): Retriever {
  return new Retriever(eventStore, vectorStore, embedder, matcher);
}
