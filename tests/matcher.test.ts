/**
 * Tests for AXIOMMIND Matcher
 */

import { describe, it, expect } from 'vitest';
import { Matcher } from '../src/core/matcher.js';

describe('Matcher', () => {
  const matcher = new Matcher();

  describe('calculateCombinedScore', () => {
    it('should calculate weighted score', () => {
      const score = matcher.calculateCombinedScore(0.9, 0.8, 0, true);
      // 0.4*0.9 + 0.25*0.8 + 0.2*1.0 + 0.15*1.0 = 0.36 + 0.2 + 0.2 + 0.15 = 0.91
      expect(score).toBeCloseTo(0.91, 2);
    });

    it('should apply recency decay', () => {
      const recentScore = matcher.calculateCombinedScore(0.9, 0.8, 0, true);
      const oldScore = matcher.calculateCombinedScore(0.9, 0.8, 30, true);

      expect(recentScore).toBeGreaterThan(oldScore);
    });

    it('should penalize inactive events', () => {
      const activeScore = matcher.calculateCombinedScore(0.9, 0.8, 0, true);
      const inactiveScore = matcher.calculateCombinedScore(0.9, 0.8, 0, false);

      expect(activeScore).toBeGreaterThan(inactiveScore);
    });

    it('should cap score at 1.0', () => {
      const score = matcher.calculateCombinedScore(1.0, 1.0, 0, true);
      expect(score).toBeLessThanOrEqual(1.0);
    });
  });

  describe('classifyConfidence', () => {
    it('should return "high" for score >= 0.92 and gap >= 0.03', () => {
      expect(matcher.classifyConfidence(0.95, 0.90)).toBe('high');
      expect(matcher.classifyConfidence(0.92, 0.85)).toBe('high');
    });

    it('should return "suggested" for score >= 0.75 but not high', () => {
      expect(matcher.classifyConfidence(0.85, 0.83)).toBe('suggested'); // gap too small
      expect(matcher.classifyConfidence(0.75, null)).toBe('suggested');
    });

    it('should return "none" for score < 0.75', () => {
      expect(matcher.classifyConfidence(0.70, null)).toBe('none');
      expect(matcher.classifyConfidence(0.50, 0.30)).toBe('none');
    });

    it('should handle null second score', () => {
      expect(matcher.classifyConfidence(0.95, null)).toBe('high');
    });
  });

  describe('matchSearchResults', () => {
    it('should return "none" confidence for empty results', () => {
      const result = matcher.matchSearchResults([], () => 0);
      expect(result.confidence).toBe('none');
      expect(result.match).toBeNull();
    });

    it('should return match with calculated score', () => {
      const results = [
        {
          id: 'vec1',
          eventId: 'event1',
          content: 'test content',
          score: 0.95,
          sessionId: 'session1',
          eventType: 'user_prompt',
          timestamp: new Date().toISOString()
        }
      ];

      const result = matcher.matchSearchResults(results, () => 0);
      expect(result.match).not.toBeNull();
      expect(result.match?.event.id).toBe('event1');
    });
  });

  describe('custom config', () => {
    it('should use custom thresholds', () => {
      const customMatcher = new Matcher({
        minCombinedScore: 0.8,
        minGap: 0.05,
        suggestionThreshold: 0.6
      });

      // With custom thresholds, 0.85 should be high confidence
      expect(customMatcher.classifyConfidence(0.85, 0.75)).toBe('high');
    });

    it('should use custom weights', () => {
      const customMatcher = new Matcher({
        weights: {
          semanticSimilarity: 0.6,
          ftsScore: 0.2,
          recencyBonus: 0.1,
          statusWeight: 0.1
        }
      });

      const score = customMatcher.calculateCombinedScore(0.9, 0.5, 0, true);
      // 0.6*0.9 + 0.2*0.5 + 0.1*1.0 + 0.1*1.0 = 0.54 + 0.1 + 0.1 + 0.1 = 0.84
      expect(score).toBeCloseTo(0.84, 2);
    });
  });
});
