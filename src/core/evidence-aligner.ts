/**
 * Evidence Aligner V2 - AXIOMMIND Principle 4
 * Quote-only approach: LLM provides quote, pipeline calculates span
 * 3-step alignment: exact → normalized → fuzzy
 */

import { createHash } from 'crypto';
import type {
  EvidenceSpan,
  ExtractedEvidence,
  AlignedEvidence,
  FailedEvidence,
  EvidenceAlignResult
} from './types.js';

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

// V2 Options
export interface AlignmentOptionsV2 {
  minMatchLength: number;
  exactMatchBonus: number;
  normalizedThreshold: number;
  fuzzyThreshold: number;
  maxMissingRatio: number;
}

const DEFAULT_OPTIONS: AlignmentOptions = {
  minMatchLength: 10,
  fuzzyThreshold: 0.8,
  maxMissingClaims: 2
};

const DEFAULT_OPTIONS_V2: AlignmentOptionsV2 = {
  minMatchLength: 5,
  exactMatchBonus: 1.0,
  normalizedThreshold: 0.95,
  fuzzyThreshold: 0.85,
  maxMissingRatio: 0.2
};

// V2 Alignment result for entries
export interface AlignResultV2 {
  evidenceAligned: boolean;
  alignedCount: number;
  failedCount: number;
  results: EvidenceAlignResult[];
  overallConfidence: number;
}

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

  // ============================================================
  // V2 Methods: Quote-only alignment
  // ============================================================

  private optionsV2: AlignmentOptionsV2 = DEFAULT_OPTIONS_V2;

  /**
   * Configure V2 options
   */
  configureV2(options: Partial<AlignmentOptionsV2>): void {
    this.optionsV2 = { ...DEFAULT_OPTIONS_V2, ...options };
  }

  /**
   * Align V2: Process extracted evidence with messageIndex and quote
   * @param sessionMessages - Array of session messages (original text)
   * @param evidence - Array of extracted evidence (messageIndex + quote)
   */
  alignV2(
    sessionMessages: string[],
    evidence: ExtractedEvidence[]
  ): AlignResultV2 {
    const results: EvidenceAlignResult[] = [];
    let alignedCount = 0;
    let totalConfidence = 0;

    for (const ev of evidence) {
      const result = this.alignSingleEvidence(sessionMessages, ev);
      results.push(result);

      if (result.aligned) {
        alignedCount++;
        totalConfidence += result.evidence.confidence;
      }
    }

    const failedCount = evidence.length - alignedCount;
    const maxMissing = Math.floor(evidence.length * this.optionsV2.maxMissingRatio);
    const evidenceAligned = failedCount <= maxMissing;
    const overallConfidence = evidence.length > 0
      ? totalConfidence / evidence.length
      : 1.0;

    return {
      evidenceAligned,
      alignedCount,
      failedCount,
      results,
      overallConfidence
    };
  }

  /**
   * Align a single evidence item
   */
  private alignSingleEvidence(
    sessionMessages: string[],
    evidence: ExtractedEvidence
  ): EvidenceAlignResult {
    const { messageIndex, quote } = evidence;

    // Validate messageIndex
    if (messageIndex < 0 || messageIndex >= sessionMessages.length) {
      return {
        aligned: false,
        evidence: {
          messageIndex,
          quote,
          failureReason: 'invalid_index'
        }
      };
    }

    // Validate quote
    if (!quote || quote.trim().length === 0) {
      return {
        aligned: false,
        evidence: {
          messageIndex,
          quote,
          failureReason: 'empty_quote'
        }
      };
    }

    const sourceMessage = sessionMessages[messageIndex];

    // Step 1: Try exact match
    const exactResult = this.tryExactMatchV2(quote, sourceMessage, messageIndex);
    if (exactResult) {
      return exactResult;
    }

    // Step 2: Try normalized match
    const normalizedResult = this.tryNormalizedMatchV2(quote, sourceMessage, messageIndex);
    if (normalizedResult) {
      return normalizedResult;
    }

    // Step 3: Try fuzzy match
    const fuzzyResult = this.tryFuzzyMatchV2(quote, sourceMessage, messageIndex);
    if (fuzzyResult) {
      return fuzzyResult;
    }

    // No match found
    return {
      aligned: false,
      evidence: {
        messageIndex,
        quote,
        failureReason: 'not_found'
      }
    };
  }

  /**
   * Try exact substring match
   */
  private tryExactMatchV2(
    quote: string,
    source: string,
    messageIndex: number
  ): EvidenceAlignResult | null {
    const index = source.indexOf(quote);

    if (index === -1) {
      return null;
    }

    return {
      aligned: true,
      evidence: {
        messageIndex,
        quote,
        spanStart: index,
        spanEnd: index + quote.length,
        quoteHash: this.hashQuote(quote),
        confidence: 1.0,
        matchMethod: 'exact'
      }
    };
  }

  /**
   * Try normalized match (whitespace collapsed)
   */
  private tryNormalizedMatchV2(
    quote: string,
    source: string,
    messageIndex: number
  ): EvidenceAlignResult | null {
    const normalizedQuote = this.normalizeWhitespace(quote);
    const normalizedSource = this.normalizeWhitespace(source);

    const normalizedIndex = normalizedSource.indexOf(normalizedQuote);
    if (normalizedIndex === -1) {
      return null;
    }

    // Map back to original positions
    const originalSpan = this.mapToOriginalPositions(
      source,
      normalizedSource,
      normalizedIndex,
      normalizedIndex + normalizedQuote.length
    );

    if (!originalSpan) {
      return null;
    }

    return {
      aligned: true,
      evidence: {
        messageIndex,
        quote,
        spanStart: originalSpan.start,
        spanEnd: originalSpan.end,
        quoteHash: this.hashQuote(quote),
        confidence: 0.95,
        matchMethod: 'normalized'
      }
    };
  }

  /**
   * Try fuzzy match using sliding window
   */
  private tryFuzzyMatchV2(
    quote: string,
    source: string,
    messageIndex: number
  ): EvidenceAlignResult | null {
    const normalizedQuote = this.normalize(quote);
    const normalizedSource = this.normalize(source);

    if (normalizedQuote.length < this.optionsV2.minMatchLength) {
      return null;
    }

    // Try different window sizes
    const windowSizes = [
      normalizedQuote.length,
      Math.floor(normalizedQuote.length * 1.1),
      Math.floor(normalizedQuote.length * 1.2)
    ];

    let bestMatch: {
      index: number;
      windowSize: number;
      similarity: number;
    } | null = null;

    for (const windowSize of windowSizes) {
      for (let i = 0; i <= normalizedSource.length - windowSize; i++) {
        const window = normalizedSource.slice(i, i + windowSize);
        const similarity = this.calculateLevenshteinSimilarity(normalizedQuote, window);

        if (similarity >= this.optionsV2.fuzzyThreshold) {
          if (!bestMatch || similarity > bestMatch.similarity) {
            bestMatch = { index: i, windowSize, similarity };
          }
        }
      }
    }

    if (!bestMatch) {
      return null;
    }

    // Map back to original positions (approximate)
    const originalSpan = this.mapToOriginalPositions(
      source,
      normalizedSource,
      bestMatch.index,
      bestMatch.index + bestMatch.windowSize
    );

    if (!originalSpan) {
      return null;
    }

    return {
      aligned: true,
      evidence: {
        messageIndex,
        quote,
        spanStart: originalSpan.start,
        spanEnd: originalSpan.end,
        quoteHash: this.hashQuote(quote),
        confidence: bestMatch.similarity,
        matchMethod: 'fuzzy'
      }
    };
  }

  /**
   * Normalize whitespace only (preserve other characters)
   */
  private normalizeWhitespace(text: string): string {
    return text
      .replace(/[\t\r]/g, ' ')
      .replace(/\n+/g, ' ')
      .replace(/ +/g, ' ')
      .trim();
  }

  /**
   * Map normalized positions back to original
   */
  private mapToOriginalPositions(
    original: string,
    normalized: string,
    normalizedStart: number,
    normalizedEnd: number
  ): { start: number; end: number } | null {
    // Build position map
    const normalizedToOriginal: Map<number, number> = new Map();
    let normalizedPos = 0;

    for (let origPos = 0; origPos < original.length; origPos++) {
      const char = original[origPos];

      // Skip extra whitespace in original
      if (/\s/.test(char)) {
        // Check if this whitespace contributes to normalized
        if (normalizedPos < normalized.length && /\s/.test(normalized[normalizedPos])) {
          normalizedToOriginal.set(normalizedPos, origPos);
          normalizedPos++;

          // Skip consecutive whitespace in original
          while (origPos + 1 < original.length && /\s/.test(original[origPos + 1])) {
            origPos++;
          }
        }
      } else {
        normalizedToOriginal.set(normalizedPos, origPos);
        normalizedPos++;
      }
    }

    const startOrig = normalizedToOriginal.get(normalizedStart);
    let endOrig = normalizedToOriginal.get(normalizedEnd - 1);

    if (startOrig === undefined) {
      return null;
    }

    if (endOrig === undefined) {
      // Use end of string
      endOrig = original.length - 1;
    }

    return {
      start: startOrig,
      end: endOrig + 1
    };
  }

  /**
   * Calculate Levenshtein distance similarity
   */
  private calculateLevenshteinSimilarity(a: string, b: string): number {
    const m = a.length;
    const n = b.length;

    if (m === 0) return n === 0 ? 1 : 0;
    if (n === 0) return 0;

    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,      // deletion
          dp[i][j - 1] + 1,      // insertion
          dp[i - 1][j - 1] + cost // substitution
        );
      }
    }

    const distance = dp[m][n];
    const maxLen = Math.max(m, n);
    return 1 - distance / maxLen;
  }

  /**
   * Hash quote for deduplication
   */
  private hashQuote(quote: string): string {
    return createHash('sha256').update(quote).digest('hex').slice(0, 16);
  }

  /**
   * Convert V2 result to V1 format for backwards compatibility
   */
  convertToV1Result(v2Result: AlignResultV2): AlignmentResult {
    const spans: EvidenceSpan[] = [];
    const missingClaims: string[] = [];

    for (const result of v2Result.results) {
      if (result.aligned) {
        const ev = result.evidence as AlignedEvidence;
        spans.push({
          start: ev.spanStart,
          end: ev.spanEnd,
          confidence: ev.confidence,
          matchType: ev.matchMethod === 'exact' ? 'exact' : 'fuzzy',
          originalQuote: ev.quote,
          alignedText: ev.quote
        });
      } else {
        const ev = result.evidence as FailedEvidence;
        missingClaims.push(ev.quote);
      }
    }

    return {
      isAligned: v2Result.evidenceAligned,
      confidence: v2Result.overallConfidence,
      spans,
      missingClaims
    };
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
