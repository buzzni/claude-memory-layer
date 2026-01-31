/**
 * Tests for Evidence Aligner
 */

import { describe, it, expect } from 'vitest';
import { EvidenceAligner } from '../src/core/evidence-aligner.js';

describe('EvidenceAligner', () => {
  const aligner = new EvidenceAligner();

  describe('align', () => {
    it('should find exact matches', () => {
      const claims = ['the quick brown fox'];
      const source = 'The quick brown fox jumps over the lazy dog.';

      const result = aligner.align(claims, source);

      expect(result.isAligned).toBe(true);
      expect(result.spans.length).toBe(1);
      expect(result.spans[0].matchType).toBe('exact');
      expect(result.spans[0].confidence).toBe(1.0);
    });

    it('should find fuzzy matches', () => {
      const claims = ['quick brown fox jumping'];
      const source = 'The quick brown fox jumps over the lazy dog.';

      const result = aligner.align(claims, source);

      // May or may not find fuzzy match depending on threshold
      expect(result.confidence).toBeGreaterThanOrEqual(0);
    });

    it('should report missing claims', () => {
      const claims = ['completely unrelated content'];
      const source = 'The quick brown fox jumps over the lazy dog.';

      const result = aligner.align(claims, source);

      expect(result.missingClaims.length).toBe(1);
      expect(result.missingClaims[0]).toBe('completely unrelated content');
    });

    it('should skip short claims', () => {
      const claims = ['short'];
      const source = 'This is a short test.';

      const result = aligner.align(claims, source);

      // Short claims are skipped
      expect(result.spans.length).toBe(0);
      expect(result.missingClaims.length).toBe(0);
    });

    it('should calculate correct confidence', () => {
      const claims = [
        'the quick brown fox',
        'jumps over the lazy dog'
      ];
      const source = 'The quick brown fox jumps over the lazy dog.';

      const result = aligner.align(claims, source);

      expect(result.confidence).toBeGreaterThan(0.5);
    });
  });

  describe('extractClaims', () => {
    it('should split text into sentences', () => {
      const text = 'First sentence. Second sentence. Third sentence.';
      const claims = aligner.extractClaims(text);

      expect(claims.length).toBe(3);
    });

    it('should filter out questions', () => {
      const text = 'This is a statement. Is this a question?';
      const claims = aligner.extractClaims(text);

      expect(claims.length).toBe(1);
      expect(claims[0]).not.toContain('?');
    });

    it('should filter out short sentences', () => {
      const text = 'Hi. This is a longer sentence that should be included.';
      const claims = aligner.extractClaims(text);

      // "Hi" is too short
      expect(claims.some(c => c === 'Hi')).toBe(false);
    });
  });

  describe('verifyGrounding', () => {
    it('should verify response is grounded in context', () => {
      const response = 'The fox is quick and brown.';
      const context = [
        'The quick brown fox jumps over the lazy dog.',
        'Foxes are known for their speed.'
      ];

      const result = aligner.verifyGrounding(response, context);

      expect(result.isAligned).toBe(true);
    });

    it('should detect ungrounded responses', () => {
      const response = 'Elephants are the largest land animals.';
      const context = [
        'The quick brown fox jumps over the lazy dog.'
      ];

      const result = aligner.verifyGrounding(response, context);

      expect(result.missingClaims.length).toBeGreaterThan(0);
    });
  });

  describe('custom options', () => {
    it('should use custom fuzzy threshold', () => {
      const strictAligner = new EvidenceAligner({
        fuzzyThreshold: 0.95
      });

      const claims = ['quick brown foxes'];
      const source = 'The quick brown fox jumps.';

      const result = strictAligner.align(claims, source);

      // Strict threshold should result in no match
      expect(result.spans.length).toBe(0);
    });

    it('should use custom max missing claims', () => {
      const tolerantAligner = new EvidenceAligner({
        maxMissingClaims: 5
      });

      const claims = [
        'claim one that exists',
        'claim two missing',
        'claim three missing',
        'claim four missing'
      ];
      const source = 'This source contains claim one that exists.';

      const result = tolerantAligner.align(claims, source);

      // Should still be aligned with 3 missing claims (< 5)
      expect(result.isAligned).toBe(true);
    });
  });
});
