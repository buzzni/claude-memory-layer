/**
 * Continuity Manager
 * Tracks and calculates context continuity between interactions
 * Biomimetic: Simulates context-dependent memory retrieval
 */

import { randomUUID } from 'crypto';
import { dbRun, dbAll, toDate, type Database } from './db-wrapper.js';
import type {
  EndlessModeConfig,
  ContextSnapshot,
  ContinuityScore,
  TransitionType,
  ContinuityLog
} from './types.js';
import { EventStore } from './event-store.js';

export class ContinuityManager {
  private lastContext: ContextSnapshot | null = null;

  constructor(
    private eventStore: EventStore,
    private config: EndlessModeConfig
  ) {}

  private get db(): Database {
    return this.eventStore.getDatabase();
  }

  /**
   * Calculate continuity score between current and previous context
   */
  async calculateScore(
    currentContext: ContextSnapshot,
    previousContext?: ContextSnapshot
  ): Promise<ContinuityScore> {
    const prev = previousContext || this.lastContext;

    if (!prev) {
      // No previous context - this is a fresh start
      this.lastContext = currentContext;
      return { score: 0.5, transitionType: 'break' };
    }

    let score = 0;

    // Topic continuity (30%)
    const topicOverlap = this.calculateOverlap(
      currentContext.topics,
      prev.topics
    );
    score += topicOverlap * 0.3;

    // File continuity (20%)
    const fileOverlap = this.calculateOverlap(
      currentContext.files,
      prev.files
    );
    score += fileOverlap * 0.2;

    // Time proximity (30%)
    const timeDiff = currentContext.timestamp - prev.timestamp;
    const decayHours = this.config.continuity.topicDecayHours;
    const timeScore = Math.exp(-timeDiff / (decayHours * 3600000));
    score += timeScore * 0.3;

    // Entity continuity (20%)
    const entityOverlap = this.calculateOverlap(
      currentContext.entities,
      prev.entities
    );
    score += entityOverlap * 0.2;

    // Determine transition type
    const transitionType = this.determineTransitionType(score);

    // Log the transition
    await this.logTransition(currentContext, prev, score, transitionType);

    // Update last context
    this.lastContext = currentContext;

    return { score, transitionType };
  }

  /**
   * Create a context snapshot from current state
   */
  createSnapshot(
    id: string,
    content: string,
    metadata?: {
      files?: string[];
      entities?: string[];
    }
  ): ContextSnapshot {
    return {
      id,
      timestamp: Date.now(),
      topics: this.extractTopics(content),
      files: metadata?.files || this.extractFiles(content),
      entities: metadata?.entities || this.extractEntities(content)
    };
  }

  /**
   * Get recent continuity logs
   */
  async getRecentLogs(limit: number = 10): Promise<ContinuityLog[]> {
    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM continuity_log
       ORDER BY created_at DESC
       LIMIT ?`,
      [limit]
    );

    return rows.map(row => ({
      logId: row.log_id as string,
      fromContextId: row.from_context_id as string | undefined,
      toContextId: row.to_context_id as string | undefined,
      continuityScore: row.continuity_score as number,
      transitionType: row.transition_type as TransitionType,
      createdAt: toDate(row.created_at)
    }));
  }

  /**
   * Get average continuity score over time period
   */
  async getAverageScore(hours: number = 1): Promise<number> {
    const result = await dbAll<{ avg_score: number | null }>(
      this.db,
      `SELECT AVG(continuity_score) as avg_score
       FROM continuity_log
       WHERE created_at > datetime('now', '-${hours} hours')`
    );

    return result[0]?.avg_score ?? 0.5;
  }

  /**
   * Get transition type distribution
   */
  async getTransitionStats(hours: number = 24): Promise<Record<TransitionType, number>> {
    const rows = await dbAll<{ transition_type: string; count: number }>(
      this.db,
      `SELECT transition_type, COUNT(*) as count
       FROM continuity_log
       WHERE created_at > datetime('now', '-${hours} hours')
       GROUP BY transition_type`
    );

    const stats: Record<TransitionType, number> = {
      seamless: 0,
      topic_shift: 0,
      break: 0
    };

    for (const row of rows) {
      stats[row.transition_type as TransitionType] = row.count;
    }

    return stats;
  }

  /**
   * Clear old continuity logs
   */
  async cleanup(olderThanDays: number = 7): Promise<number> {
    const result = await dbAll<{ changes: number }>(
      this.db,
      `DELETE FROM continuity_log
       WHERE created_at < datetime('now', '-${olderThanDays} days')
       RETURNING COUNT(*) as changes`
    );

    return result[0]?.changes || 0;
  }

  /**
   * Calculate overlap between two arrays
   */
  private calculateOverlap(a: string[], b: string[]): number {
    if (a.length === 0 || b.length === 0) return 0;

    const setA = new Set(a.map(s => s.toLowerCase()));
    const setB = new Set(b.map(s => s.toLowerCase()));

    const intersection = [...setA].filter(x => setB.has(x));
    const union = new Set([...setA, ...setB]);

    return intersection.length / union.size; // Jaccard similarity
  }

  /**
   * Determine transition type based on score
   */
  private determineTransitionType(score: number): TransitionType {
    if (score >= this.config.continuity.minScoreForSeamless) {
      return 'seamless';
    } else if (score >= 0.4) {
      return 'topic_shift';
    } else {
      return 'break';
    }
  }

  /**
   * Log a context transition
   */
  private async logTransition(
    current: ContextSnapshot,
    previous: ContextSnapshot,
    score: number,
    type: TransitionType
  ): Promise<void> {
    await dbRun(
      this.db,
      `INSERT INTO continuity_log
        (log_id, from_context_id, to_context_id, continuity_score, transition_type, created_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [randomUUID(), previous.id, current.id, score, type]
    );
  }

  /**
   * Extract topics from content
   */
  private extractTopics(content: string): string[] {
    const topics: string[] = [];
    const contentLower = content.toLowerCase();

    // Programming language keywords
    const langPatterns = [
      { pattern: /typescript|\.ts\b/i, topic: 'typescript' },
      { pattern: /javascript|\.js\b/i, topic: 'javascript' },
      { pattern: /python|\.py\b/i, topic: 'python' },
      { pattern: /rust|\.rs\b/i, topic: 'rust' },
      { pattern: /go\b|golang/i, topic: 'go' }
    ];

    for (const { pattern, topic } of langPatterns) {
      if (pattern.test(content)) {
        topics.push(topic);
      }
    }

    // Common development topics
    const devTopics = [
      'api', 'database', 'test', 'bug', 'feature', 'refactor',
      'component', 'function', 'class', 'module', 'hook',
      'deploy', 'build', 'config', 'docker', 'git'
    ];

    for (const topic of devTopics) {
      if (contentLower.includes(topic)) {
        topics.push(topic);
      }
    }

    return [...new Set(topics)].slice(0, 10);
  }

  /**
   * Extract file paths from content
   */
  private extractFiles(content: string): string[] {
    const filePatterns = [
      /(?:^|\s)([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)(?:\s|$|:)/gm,
      /['"](\.?\/[^'"]+\.[a-zA-Z0-9]+)['"]/g,
      /file[:\s]+([^\s,]+)/gi
    ];

    const files = new Set<string>();

    for (const pattern of filePatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const file = match[1];
        if (file && file.length > 3 && file.length < 100) {
          // Filter out common non-file patterns
          if (!file.match(/^(https?:|mailto:|ftp:)/i)) {
            files.add(file);
          }
        }
      }
    }

    return Array.from(files).slice(0, 10);
  }

  /**
   * Extract entity names from content (functions, classes, variables)
   */
  private extractEntities(content: string): string[] {
    const entities = new Set<string>();

    const entityPatterns = [
      /\b(function|const|let|var|class|interface|type)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,
      /\b([A-Z][a-zA-Z0-9_]*(?:Component|Service|Store|Manager|Handler|Factory|Provider))\b/g,
      /\b(use[A-Z][a-zA-Z0-9_]*)\b/g // React hooks
    ];

    for (const pattern of entityPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const entity = match[2] || match[1];
        if (entity && entity.length > 2) {
          entities.add(entity);
        }
      }
    }

    return Array.from(entities).slice(0, 20);
  }

  /**
   * Reset the last context (for testing or manual reset)
   */
  resetLastContext(): void {
    this.lastContext = null;
  }

  /**
   * Get the last context snapshot
   */
  getLastContext(): ContextSnapshot | null {
    return this.lastContext;
  }
}

/**
 * Create a Continuity Manager instance
 */
export function createContinuityManager(
  eventStore: EventStore,
  config: EndlessModeConfig
): ContinuityManager {
  return new ContinuityManager(eventStore, config);
}
