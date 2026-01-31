/**
 * Evidence Aligner - AXIOMMIND Principle 4
 * Verifies that retrieved memories actually support claims
 * Detects hallucination by checking if evidence exists in source content
 */

import type { EvidenceSpan } from './types.js';

export interface AlignmentResult {
  isAligned: boolean;
  confidence: number;
  spans: EvidenceSpan[];
  missingClaims: string[];
}

export interface AlignmentOptions {
  minMatchLength: number;
  fuzzyThreshold: number;
  maxMissingClaims: number;
}

const DEFAULT_OPTIONS: AlignmentOptions = {
  minMatchLength: 10,
  fuzzyThreshold: 0.8,
  maxMissingClaims: 2
};

export class EvidenceAligner {
  private readonly options: AlignmentOptions;

  constructor(options: Partial<AlignmentOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Align claims against source content
   * Returns evidence spans showing where claims are supported
   */
  align(claims: string[], sourceContent: string): AlignmentResult {
    const spans: EvidenceSpan[] = [];
    const missingClaims: string[] = [];
    const normalizedSource = this.normalize(sourceContent);

    for (const claim of claims) {
      const normalizedClaim = this.normalize(claim);

      // Skip very short claims
      if (normalizedClaim.length < this.options.minMatchLength) {
        continue;
      }

      // Try exact match first
      const exactSpan = this.findExactMatch(normalizedClaim, normalizedSource, sourceContent);
      if (exactSpan) {
        spans.push(exactSpan);
        continue;
      }

      // Try fuzzy match
      const fuzzySpan = this.findFuzzyMatch(normalizedClaim, normalizedSource, sourceContent);
      if (fuzzySpan && fuzzySpan.confidence >= this.options.fuzzyThreshold) {
        spans.push(fuzzySpan);
        continue;
      }

      // Claim not found in source
      missingClaims.push(claim);
    }

    // Calculate overall alignment confidence
    const totalClaims = claims.length;
    const alignedClaims = spans.length;
    const confidence = totalClaims > 0 ? alignedClaims / totalClaims : 1.0;

    // Alignment is valid if missing claims are within threshold
    const isAligned = missingClaims.length <= this.options.maxMissingClaims;

    return {
      isAligned,
      confidence,
      spans,
      missingClaims
    };
  }

  /**
   * Find exact substring match
   */
  private findExactMatch(
    normalizedClaim: string,
    normalizedSource: string,
    originalSource: string
  ): EvidenceSpan | null {
    const index = normalizedSource.indexOf(normalizedClaim);

    if (index === -1) {
      return null;
    }

    return {
      start: index,
      end: index + normalizedClaim.length,
      confidence: 1.0,
      matchType: 'exact',
      originalQuote: originalSource.slice(index, index + normalizedClaim.length),
      alignedText: normalizedClaim
    };
  }

  /**
   * Find fuzzy match using sliding window
   */
  private findFuzzyMatch(
    normalizedClaim: string,
    normalizedSource: string,
    originalSource: string
  ): EvidenceSpan | null {
    const windowSize = normalizedClaim.length;
    let bestMatch: { index: number; similarity: number } | null = null;

    // Slide window across source
    for (let i = 0; i <= normalizedSource.length - windowSize; i++) {
      const window = normalizedSource.slice(i, i + windowSize);
      const similarity = this.calculateSimilarity(normalizedClaim, window);

      if (!bestMatch || similarity > bestMatch.similarity) {
        bestMatch = { index: i, similarity };
      }
    }

    if (!bestMatch || bestMatch.similarity < this.options.fuzzyThreshold) {
      return null;
    }

    return {
      start: bestMatch.index,
      end: bestMatch.index + windowSize,
      confidence: bestMatch.similarity,
      matchType: 'fuzzy',
      originalQuote: originalSource.slice(bestMatch.index, bestMatch.index + windowSize),
      alignedText: normalizedClaim
    };
  }

  /**
   * Calculate similarity between two strings using Jaccard coefficient
   */
  private calculateSimilarity(a: string, b: string): number {
    const setA = new Set(this.tokenize(a));
    const setB = new Set(this.tokenize(b));

    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);

    return intersection.size / union.size;
  }

  /**
   * Tokenize text into words
   */
  private tokenize(text: string): string[] {
    return text.toLowerCase().split(/\s+/).filter(t => t.length > 0);
  }

  /**
   * Normalize text for comparison
   */
  private normalize(text: string): string {
    return text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Extract claims from a response text
   * Splits on sentence boundaries and filters short sentences
   */
  extractClaims(text: string): string[] {
    // Split on sentence boundaries
    const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 0);

    // Filter out very short sentences and questions
    return sentences.filter(s => {
      return s.length >= this.options.minMatchLength && !s.endsWith('?');
    });
  }

  /**
   * Verify that a response is grounded in the provided context
   */
  verifyGrounding(response: string, context: string[]): AlignmentResult {
    const claims = this.extractClaims(response);
    const combinedContext = context.join(' ');

    return this.align(claims, combinedContext);
  }
}

/**
 * Default evidence aligner instance
 */
let defaultAligner: EvidenceAligner | null = null;

export function getDefaultAligner(): EvidenceAligner {
  if (!defaultAligner) {
    defaultAligner = new EvidenceAligner();
  }
  return defaultAligner;
}
