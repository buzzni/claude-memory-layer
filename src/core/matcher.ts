/**
 * AXIOMMIND Matcher - Weighted scoring with confidence classification
 * Implements matching thresholds: high (≥0.92), suggested (≥0.75), none (<0.75)
 */

import type {
  MemoryEvent,
  MemoryMatch,
  MatchResult,
  MatchConfidence,
  MATCH_THRESHOLDS
} from './types.js';
import { SearchResult } from './vector-store.js';

export interface MatchWeights {
  semanticSimilarity: number;
  ftsScore: number;
  recencyBonus: number;
  statusWeight: number;
}

export interface MatcherConfig {
  weights: MatchWeights;
  minCombinedScore: number;
  minGap: number;
  suggestionThreshold: number;
}

const DEFAULT_CONFIG: MatcherConfig = {
  weights: {
    semanticSimilarity: 0.4,
    ftsScore: 0.25,
    recencyBonus: 0.2,
    statusWeight: 0.15
  },
  minCombinedScore: 0.92,
  minGap: 0.03,
  suggestionThreshold: 0.75
};

export class Matcher {
  private readonly config: MatcherConfig;

  constructor(config: Partial<MatcherConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      weights: { ...DEFAULT_CONFIG.weights, ...config.weights }
    };
  }

  /**
   * Calculate combined score using AXIOMMIND weighted formula
   */
  calculateCombinedScore(
    semanticScore: number,
    ftsScore: number = 0,
    recencyDays: number = 0,
    isActive: boolean = true
  ): number {
    const { weights } = this.config;

    // Recency bonus: decays over 30 days
    const recencyBonus = Math.max(0, 1 - recencyDays / 30);

    // Status weight: active events get full weight
    const statusMultiplier = isActive ? 1.0 : 0.7;

    const combinedScore =
      weights.semanticSimilarity * semanticScore +
      weights.ftsScore * ftsScore +
      weights.recencyBonus * recencyBonus +
      weights.statusWeight * statusMultiplier;

    return Math.min(1.0, combinedScore);
  }

  /**
   * Classify match confidence based on AXIOMMIND thresholds
   */
  classifyConfidence(
    topScore: number,
    secondScore: number | null
  ): MatchConfidence {
    const { minCombinedScore, minGap, suggestionThreshold } = this.config;

    // Calculate gap (infinity if no second match)
    const gap = secondScore !== null ? topScore - secondScore : Infinity;

    // High confidence: score ≥ 0.92 AND gap ≥ 0.03
    if (topScore >= minCombinedScore && gap >= minGap) {
      return 'high';
    }

    // Suggested: score ≥ 0.75
    if (topScore >= suggestionThreshold) {
      return 'suggested';
    }

    // No match
    return 'none';
  }

  /**
   * Match search results to find best memory
   */
  matchSearchResults(
    results: SearchResult[],
    getEventAge: (eventId: string) => number
  ): MatchResult {
    if (results.length === 0) {
      return {
        match: null,
        confidence: 'none'
      };
    }

    // Calculate combined scores
    const scoredResults = results.map(result => {
      const ageDays = getEventAge(result.eventId);
      const combinedScore = this.calculateCombinedScore(
        result.score,
        0, // FTS score - would need to be passed in
        ageDays,
        true // Assume active
      );

      return {
        result,
        combinedScore
      };
    });

    // Sort by combined score
    scoredResults.sort((a, b) => b.combinedScore - a.combinedScore);

    const topResult = scoredResults[0];
    const secondScore = scoredResults.length > 1 ? scoredResults[1].combinedScore : null;

    // Classify confidence
    const confidence = this.classifyConfidence(topResult.combinedScore, secondScore);

    // Build match result
    const match: MemoryMatch = {
      event: {
        id: topResult.result.eventId,
        eventType: topResult.result.eventType as 'user_prompt' | 'agent_response' | 'session_summary',
        sessionId: topResult.result.sessionId,
        timestamp: new Date(topResult.result.timestamp),
        content: topResult.result.content,
        canonicalKey: '', // Would need to be fetched
        dedupeKey: ''     // Would need to be fetched
      },
      score: topResult.combinedScore
    };

    const gap = secondScore !== null ? topResult.combinedScore - secondScore : undefined;

    // Build alternatives for suggested matches
    const alternatives = confidence === 'suggested'
      ? scoredResults.slice(1, 4).map(sr => ({
          event: {
            id: sr.result.eventId,
            eventType: sr.result.eventType as 'user_prompt' | 'agent_response' | 'session_summary',
            sessionId: sr.result.sessionId,
            timestamp: new Date(sr.result.timestamp),
            content: sr.result.content,
            canonicalKey: '',
            dedupeKey: ''
          },
          score: sr.combinedScore
        }))
      : undefined;

    return {
      match: confidence !== 'none' ? match : null,
      confidence,
      gap,
      alternatives
    };
  }

  /**
   * Calculate days between two dates
   */
  static calculateAgeDays(timestamp: Date): number {
    const now = new Date();
    const diffMs = now.getTime() - timestamp.getTime();
    return diffMs / (1000 * 60 * 60 * 24);
  }

  /**
   * Get current configuration
   */
  getConfig(): Readonly<MatcherConfig> {
    return { ...this.config };
  }
}

/**
 * Default matcher instance
 */
let defaultMatcher: Matcher | null = null;

export function getDefaultMatcher(): Matcher {
  if (!defaultMatcher) {
    defaultMatcher = new Matcher();
  }
  return defaultMatcher;
}
