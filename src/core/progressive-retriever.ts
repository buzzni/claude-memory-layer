/**
 * Progressive Retriever
 * Implements 3-layer progressive disclosure for token-efficient search
 */

import type { EventStore } from './event-store.js';
import type { VectorStore } from './vector-store.js';
import type { Embedder } from './embedder.js';
import type {
  SearchIndexItem,
  TimelineItem,
  FullDetail,
  ProgressiveSearchResult,
  ProgressiveDisclosureConfig,
  MemoryEvent,
  Citation
} from './types.js';
import { generateCitationId } from './citation-generator.js';

export interface SmartSearchOptions {
  topK?: number;
  minScore?: number;
  maxTotalTokens?: number;
  filter?: {
    sessionId?: string;
    eventType?: string;
  };
}

interface ExpansionDecision {
  expand: boolean;
  expandTimeline?: boolean;
  expandDetails?: boolean;
  ids?: string[];
  reason: string;
}

const DEFAULT_CONFIG: ProgressiveDisclosureConfig = {
  enabled: true,
  layer1: {
    topK: 10,
    minScore: 0.7
  },
  autoExpand: {
    enabled: true,
    highConfidenceThreshold: 0.92,
    scoreGapThreshold: 0.1,
    maxAutoExpandCount: 3
  },
  tokenBudget: {
    maxTotalTokens: 2000,
    layer1PerItem: 50,
    layer2PerItem: 40,
    layer3PerItem: 500
  }
};

export class ProgressiveRetriever {
  private config: ProgressiveDisclosureConfig;

  constructor(
    private eventStore: EventStore,
    private vectorStore: VectorStore,
    private embedder: Embedder,
    config?: Partial<ProgressiveDisclosureConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Layer 1: Search Index (lightweight, ~50-100 tokens per result)
   */
  async searchIndex(
    query: string,
    options?: { topK?: number; filter?: SmartSearchOptions['filter'] }
  ): Promise<SearchIndexItem[]> {
    const topK = options?.topK ?? this.config.layer1.topK;

    // Generate query embedding
    const queryEmbedding = await this.embedder.embed(query);

    // Search vector store
    const vectorResults = await this.vectorStore.search(queryEmbedding.vector, {
      limit: topK,
      minScore: this.config.layer1.minScore,
      sessionId: options?.filter?.sessionId
    });

    // Convert to index items with summaries
    return vectorResults.map(r => ({
      id: r.eventId,
      summary: this.generateSummary(r.content),
      score: r.score,
      type: r.eventType as SearchIndexItem['type'],
      timestamp: new Date(r.timestamp),
      sessionId: r.sessionId
    }));
  }

  /**
   * Layer 2: Timeline (context around results, ~200 tokens)
   */
  async getTimeline(
    targetIds: string[],
    options?: { windowSize?: number }
  ): Promise<TimelineItem[]> {
    const windowSize = options?.windowSize ?? 3;
    const items: TimelineItem[] = [];
    const seenIds = new Set<string>();

    for (const targetId of targetIds) {
      const event = await this.eventStore.getEvent(targetId);
      if (!event) continue;

      // Get surrounding events from same session
      const sessionEvents = await this.eventStore.getSessionEvents(event.sessionId);
      const eventIndex = sessionEvents.findIndex(e => e.id === targetId);

      if (eventIndex === -1) continue;

      const start = Math.max(0, eventIndex - windowSize);
      const end = Math.min(sessionEvents.length, eventIndex + windowSize + 1);

      for (let i = start; i < end; i++) {
        const e = sessionEvents[i];
        if (seenIds.has(e.id)) continue;
        seenIds.add(e.id);

        items.push({
          id: e.id,
          timestamp: e.timestamp,
          type: e.eventType as TimelineItem['type'],
          preview: this.generatePreview(e.content),
          isTarget: e.id === targetId
        });
      }
    }

    // Sort by timestamp
    return items.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Layer 3: Full Details (complete content, ~500-1000 tokens per result)
   */
  async getDetails(ids: string[]): Promise<FullDetail[]> {
    const details: FullDetail[] = [];

    for (const id of ids) {
      const event = await this.eventStore.getEvent(id);
      if (!event) continue;

      const citationId = generateCitationId(event.id);

      details.push({
        id: event.id,
        content: event.content,
        type: event.eventType as FullDetail['type'],
        timestamp: event.timestamp,
        sessionId: event.sessionId,
        citationId,
        metadata: this.extractMetadata(event)
      });
    }

    return details;
  }

  /**
   * Smart Search: Progressive search with auto-expansion
   */
  async smartSearch(
    query: string,
    options?: SmartSearchOptions
  ): Promise<ProgressiveSearchResult> {
    const config = { ...this.config };
    if (options?.maxTotalTokens) {
      config.tokenBudget.maxTotalTokens = options.maxTotalTokens;
    }

    // Layer 1: Always execute
    const index = await this.searchIndex(query, {
      topK: options?.topK ?? config.layer1.topK,
      filter: options?.filter
    });

    const result: ProgressiveSearchResult = {
      index,
      meta: {
        totalMatches: index.length,
        expandedCount: 0,
        estimatedTokens: this.estimateTokens(index, 'layer1')
      }
    };

    // Auto-expansion decision
    if (config.autoExpand.enabled) {
      const decision = this.shouldAutoExpand(index, config);

      if (decision.expand && decision.ids) {
        // Expand timeline
        if (decision.expandTimeline) {
          result.timeline = await this.getTimeline(decision.ids);
          result.meta.estimatedTokens += this.estimateTokens(result.timeline, 'layer2');
        }

        // Expand details (if budget allows)
        if (decision.expandDetails) {
          const remainingBudget = config.tokenBudget.maxTotalTokens - result.meta.estimatedTokens;
          const idsToExpand = this.selectWithinBudget(
            decision.ids,
            remainingBudget,
            config.tokenBudget.layer3PerItem
          );

          if (idsToExpand.length > 0) {
            result.details = await this.getDetails(idsToExpand);
            result.meta.expandedCount = idsToExpand.length;
            result.meta.estimatedTokens += result.details.reduce(
              (sum, d) => sum + this.estimateTokensForText(d.content),
              0
            );
          }
        }

        result.meta.expansionReason = decision.reason;
      } else {
        result.meta.expansionReason = decision.reason;
      }
    }

    return result;
  }

  /**
   * Determine whether to auto-expand results
   */
  private shouldAutoExpand(
    results: SearchIndexItem[],
    config: ProgressiveDisclosureConfig
  ): ExpansionDecision {
    if (results.length === 0) {
      return { expand: false, reason: 'no_results' };
    }

    const topScore = results[0].score;

    // Rule 1: High confidence single result
    if (topScore >= config.autoExpand.highConfidenceThreshold && results.length === 1) {
      return {
        expand: true,
        expandTimeline: true,
        expandDetails: true,
        ids: [results[0].id],
        reason: 'high_confidence_single'
      };
    }

    // Rule 2: Clear winner with score gap
    if (results.length >= 2) {
      const gap = results[0].score - results[1].score;
      if (topScore >= 0.85 && gap >= config.autoExpand.scoreGapThreshold) {
        return {
          expand: true,
          expandTimeline: true,
          expandDetails: true,
          ids: [results[0].id],
          reason: 'clear_winner'
        };
      }
    }

    // Rule 3: Multiple high scores → timeline only
    const highScoreCount = results.filter(r => r.score >= 0.8).length;
    if (highScoreCount >= 3) {
      return {
        expand: true,
        expandTimeline: true,
        expandDetails: false,
        ids: results.slice(0, 3).map(r => r.id),
        reason: 'ambiguous_multiple_high'
      };
    }

    // Rule 4: Low confidence
    if (topScore < config.layer1.minScore) {
      return { expand: false, reason: 'low_confidence' };
    }

    return { expand: false, reason: 'no_expansion_rule_matched' };
  }

  /**
   * Select IDs that fit within token budget
   */
  private selectWithinBudget(
    ids: string[],
    budget: number,
    perItemTokens: number
  ): string[] {
    const maxItems = Math.floor(budget / perItemTokens);
    return ids.slice(0, Math.max(0, maxItems));
  }

  /**
   * Generate a short summary for Layer 1
   */
  private generateSummary(content: string, maxLength: number = 100): string {
    // Remove code blocks
    const withoutCode = content.replace(/```[\s\S]*?```/g, '[code]');

    // Extract first sentence
    const firstSentence = withoutCode.match(/^[^.!?]+[.!?]/)?.[0] || '';

    if (firstSentence.length <= maxLength) {
      return firstSentence.trim();
    }

    // Truncate at word boundary
    return withoutCode.slice(0, maxLength).replace(/\s+\S*$/, '') + '...';
  }

  /**
   * Generate a preview for Layer 2
   */
  private generatePreview(content: string, maxLength: number = 200): string {
    // Summarize code blocks
    const withCodeSummary = content.replace(
      /```(\w+)[\s\S]*?```/g,
      (_, lang) => `[${lang} code]`
    );

    // Collapse whitespace
    const singleLine = withCodeSummary.replace(/\n+/g, ' ').trim();

    if (singleLine.length <= maxLength) {
      return singleLine;
    }

    return singleLine.slice(0, maxLength).replace(/\s+\S*$/, '') + '...';
  }

  /**
   * Extract metadata from event
   */
  private extractMetadata(event: MemoryEvent): FullDetail['metadata'] {
    const content = event.content;

    return {
      tokenCount: this.estimateTokensForText(content),
      hasCode: /```[\s\S]*?```/.test(content),
      files: this.extractFiles(content),
      tools: this.extractTools(content)
    };
  }

  /**
   * Extract file paths from content
   */
  private extractFiles(content: string): string[] | undefined {
    const filePattern = /(?:\/[\w.-]+)+\.\w+/g;
    const matches = content.match(filePattern);
    return matches ? [...new Set(matches)] : undefined;
  }

  /**
   * Extract tool names from content
   */
  private extractTools(content: string): string[] | undefined {
    const toolPattern = /\b(Read|Write|Edit|Bash|Grep|Glob|WebFetch|WebSearch)\b/g;
    const matches = content.match(toolPattern);
    return matches ? [...new Set(matches)] : undefined;
  }

  /**
   * Estimate tokens for a layer
   */
  private estimateTokens(
    items: unknown[],
    layer: 'layer1' | 'layer2' | 'layer3'
  ): number {
    const config = this.config.tokenBudget;

    switch (layer) {
      case 'layer1':
        return items.length * config.layer1PerItem;
      case 'layer2':
        return items.length * config.layer2PerItem;
      case 'layer3':
        return (items as FullDetail[]).reduce(
          (sum, item) => sum + this.estimateTokensForText(item.content),
          0
        );
    }
  }

  /**
   * Estimate tokens for text (~4 chars per token)
   */
  private estimateTokensForText(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

/**
 * Create a progressive retriever instance
 */
export function createProgressiveRetriever(
  eventStore: EventStore,
  vectorStore: VectorStore,
  embedder: Embedder,
  config?: Partial<ProgressiveDisclosureConfig>
): ProgressiveRetriever {
  return new ProgressiveRetriever(eventStore, vectorStore, embedder, config);
}
