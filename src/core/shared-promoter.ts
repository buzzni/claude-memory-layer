/**
 * SharedPromoter - Handles auto-promotion of verified troubleshooting entries
 * Promotes entries from project-local storage to cross-project shared storage
 */

import { randomUUID } from 'crypto';
import { SharedStore } from './shared-store.js';
import { SharedVectorStore } from './shared-vector-store.js';
import { Embedder } from './embedder.js';
import type { Entry, SharedTroubleshootingInput, SharedStoreConfig } from './types.js';

export interface TroubleshootingContent {
  symptoms?: string[];
  rootCause?: string;
  solution?: string;
  technologies?: string[];
}

export interface PromotionResult {
  success: boolean;
  entryId?: string;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
}

export class SharedPromoter {
  constructor(
    private sharedStore: SharedStore,
    private sharedVectorStore: SharedVectorStore,
    private embedder: Embedder,
    private config?: SharedStoreConfig
  ) {}

  /**
   * Check if an entry is eligible for promotion
   */
  isEligibleForPromotion(entry: Entry): boolean {
    // Must be troubleshooting type
    if (entry.entryType !== 'troubleshooting') {
      return false;
    }

    // Must be at least 'verified' stage
    if (entry.stage !== 'verified' && entry.stage !== 'certified') {
      return false;
    }

    // Must be active status
    if (entry.status !== 'active') {
      return false;
    }

    return true;
  }

  /**
   * Promote a verified troubleshooting entry to shared storage
   */
  async promoteEntry(
    entry: Entry,
    projectHash: string
  ): Promise<PromotionResult> {
    // Validate eligibility
    if (!this.isEligibleForPromotion(entry)) {
      return {
        success: false,
        skipped: true,
        skipReason: `Entry not eligible: type=${entry.entryType}, stage=${entry.stage}, status=${entry.status}`
      };
    }

    // Check if already promoted
    const exists = await this.sharedStore.exists(projectHash, entry.entryId);
    if (exists) {
      return {
        success: true,
        skipped: true,
        skipReason: 'Entry already exists in shared store'
      };
    }

    try {
      const content = entry.contentJson as TroubleshootingContent;
      const confidence = this.calculateConfidence(entry);

      // Check minimum confidence threshold
      const minConfidence = this.config?.minConfidenceForPromotion ?? 0.8;
      if (confidence < minConfidence) {
        return {
          success: false,
          skipped: true,
          skipReason: `Confidence ${confidence} below threshold ${minConfidence}`
        };
      }

      const input: SharedTroubleshootingInput = {
        sourceProjectHash: projectHash,
        sourceEntryId: entry.entryId,
        title: entry.title,
        symptoms: content.symptoms || [],
        rootCause: content.rootCause || '',
        solution: content.solution || '',
        topics: this.extractTopics(entry),
        technologies: content.technologies || [],
        confidence
      };

      // Promote to shared store
      const entryId = await this.sharedStore.promoteEntry(input);

      // Create embedding for vector search
      const embeddingContent = this.createEmbeddingContent(input);
      const embedding = await this.embedder.embed(embeddingContent);

      await this.sharedVectorStore.upsert({
        id: randomUUID(),
        entryId,
        entryType: 'troubleshooting',
        content: embeddingContent,
        vector: embedding.vector,
        topics: input.topics,
        sourceProjectHash: projectHash
      });

      return {
        success: true,
        entryId
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Batch promote multiple entries
   */
  async promoteEntries(
    entries: Entry[],
    projectHash: string
  ): Promise<Map<string, PromotionResult>> {
    const results = new Map<string, PromotionResult>();

    for (const entry of entries) {
      const result = await this.promoteEntry(entry, projectHash);
      results.set(entry.entryId, result);
    }

    return results;
  }

  /**
   * Extract topics from entry
   */
  private extractTopics(entry: Entry): string[] {
    const topics: string[] = [];

    // Extract from title (meaningful words)
    const titleWords = entry.title
      .toLowerCase()
      .split(/[\s\-_]+/)
      .filter(w => w.length > 3 && !this.isStopWord(w));
    topics.push(...titleWords);

    // Extract from content if available
    const content = entry.contentJson as Record<string, unknown>;
    if (content.topics && Array.isArray(content.topics)) {
      topics.push(...content.topics.map(t => String(t).toLowerCase()));
    }

    // Extract technologies as topics
    if (content.technologies && Array.isArray(content.technologies)) {
      topics.push(...content.technologies.map(t => String(t).toLowerCase()));
    }

    // Dedupe and return
    return [...new Set(topics)];
  }

  /**
   * Check if word is a stop word
   */
  private isStopWord(word: string): boolean {
    const stopWords = new Set([
      'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'been',
      'were', 'are', 'was', 'had', 'has', 'will', 'would', 'could', 'should',
      'when', 'where', 'what', 'which', 'while', 'error', 'problem', 'issue'
    ]);
    return stopWords.has(word);
  }

  /**
   * Calculate confidence score for entry
   */
  private calculateConfidence(entry: Entry): number {
    let confidence = 0.8; // Base confidence for verified entries

    // Boost if certified
    if (entry.stage === 'certified') {
      confidence = 0.95;
    }

    // Could add more factors:
    // - Number of evidence items
    // - Age of entry (older verified entries may be more reliable)
    // - Usage count if tracked

    return Math.min(confidence, 1.0);
  }

  /**
   * Create embedding content from input
   */
  private createEmbeddingContent(input: SharedTroubleshootingInput): string {
    const parts: string[] = [];

    parts.push(`Problem: ${input.title}`);

    if (input.symptoms.length > 0) {
      parts.push(`Symptoms: ${input.symptoms.join(', ')}`);
    }

    if (input.rootCause) {
      parts.push(`Root Cause: ${input.rootCause}`);
    }

    if (input.solution) {
      parts.push(`Solution: ${input.solution}`);
    }

    if (input.technologies && input.technologies.length > 0) {
      parts.push(`Technologies: ${input.technologies.join(', ')}`);
    }

    return parts.join('\n');
  }
}

export function createSharedPromoter(
  sharedStore: SharedStore,
  sharedVectorStore: SharedVectorStore,
  embedder: Embedder,
  config?: SharedStoreConfig
): SharedPromoter {
  return new SharedPromoter(sharedStore, sharedVectorStore, embedder, config);
}
