/**
 * Consolidated Store
 * Manages long-term integrated memories for Endless Mode
 * Biomimetic: Simulates memory consolidation that occurs during sleep
 */

import { randomUUID } from 'crypto';
import { dbRun, dbAll, toDate, type Database } from './db-wrapper.js';
import type {
  ConsolidatedMemory,
  ConsolidatedMemoryInput,
  ConsolidationRule,
  ConsolidationRuleInput
} from './types.js';
import { EventStore } from './event-store.js';

export class ConsolidatedStore {
  constructor(private eventStore: EventStore) {}

  private get db(): Database {
    return this.eventStore.getDatabase();
  }

  /**
   * Create a new consolidated memory
   */
  async create(input: ConsolidatedMemoryInput): Promise<string> {
    const memoryId = randomUUID();

    await dbRun(
      this.db,
      `INSERT INTO consolidated_memories
        (memory_id, summary, topics, source_events, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        memoryId,
        input.summary,
        JSON.stringify(input.topics),
        JSON.stringify(input.sourceEvents),
        input.confidence
      ]
    );

    return memoryId;
  }

  /**
   * Get a consolidated memory by ID
   */
  async get(memoryId: string): Promise<ConsolidatedMemory | null> {
    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM consolidated_memories WHERE memory_id = ?`,
      [memoryId]
    );

    if (rows.length === 0) return null;
    return this.rowToMemory(rows[0]);
  }

  /**
   * Search consolidated memories by query (simple text search)
   */
  async search(query: string, options?: { topK?: number }): Promise<ConsolidatedMemory[]> {
    const topK = options?.topK || 5;

    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM consolidated_memories
       WHERE summary LIKE ?
       ORDER BY confidence DESC
       LIMIT ?`,
      [`%${query}%`, topK]
    );

    return rows.map(this.rowToMemory);
  }

  /**
   * Search by topics
   */
  async searchByTopics(topics: string[], options?: { topK?: number }): Promise<ConsolidatedMemory[]> {
    const topK = options?.topK || 5;

    // Build topic filter
    const topicConditions = topics.map(() => `topics LIKE ?`).join(' OR ');
    const topicParams = topics.map(t => `%"${t}"%`);

    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM consolidated_memories
       WHERE ${topicConditions}
       ORDER BY confidence DESC
       LIMIT ?`,
      [...topicParams, topK]
    );

    return rows.map(this.rowToMemory);
  }

  /**
   * Get all consolidated memories ordered by confidence
   */
  async getAll(options?: { limit?: number }): Promise<ConsolidatedMemory[]> {
    const limit = options?.limit || 100;

    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM consolidated_memories
       ORDER BY confidence DESC, created_at DESC
       LIMIT ?`,
      [limit]
    );

    return rows.map(this.rowToMemory);
  }

  /**
   * Get recently created memories
   */
  async getRecent(options?: { limit?: number; hours?: number }): Promise<ConsolidatedMemory[]> {
    const limit = options?.limit || 10;
    const hours = options?.hours || 24;

    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM consolidated_memories
       WHERE created_at > datetime('now', '-${hours} hours')
       ORDER BY created_at DESC
       LIMIT ?`,
      [limit]
    );

    return rows.map(this.rowToMemory);
  }

  /**
   * Mark a memory as accessed (tracks usage for importance scoring)
   */
  async markAccessed(memoryId: string): Promise<void> {
    await dbRun(
      this.db,
      `UPDATE consolidated_memories
       SET accessed_at = CURRENT_TIMESTAMP,
           access_count = access_count + 1
       WHERE memory_id = ?`,
      [memoryId]
    );
  }

  /**
   * Update confidence score for a memory
   */
  async updateConfidence(memoryId: string, confidence: number): Promise<void> {
    await dbRun(
      this.db,
      `UPDATE consolidated_memories
       SET confidence = ?
       WHERE memory_id = ?`,
      [confidence, memoryId]
    );
  }

  /**
   * Delete a consolidated memory
   */
  async delete(memoryId: string): Promise<void> {
    await dbRun(
      this.db,
      `DELETE FROM consolidated_memories WHERE memory_id = ?`,
      [memoryId]
    );
  }

  /**
   * Create a long-term rule promoted from stable summaries
   */
  async createRule(input: ConsolidationRuleInput): Promise<string> {
    const ruleId = randomUUID();

    await dbRun(
      this.db,
      `INSERT INTO consolidated_rules
        (rule_id, rule, topics, source_memory_ids, source_events, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        ruleId,
        input.rule,
        JSON.stringify(input.topics),
        JSON.stringify(input.sourceMemoryIds),
        JSON.stringify(input.sourceEvents),
        input.confidence
      ]
    );

    return ruleId;
  }

  async getRules(options?: { limit?: number }): Promise<ConsolidationRule[]> {
    const limit = options?.limit || 100;
    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM consolidated_rules ORDER BY confidence DESC, created_at DESC LIMIT ?`,
      [limit]
    );

    return rows.map((row) => ({
      ruleId: row.rule_id as string,
      rule: row.rule as string,
      topics: JSON.parse((row.topics as string) || '[]'),
      sourceMemoryIds: JSON.parse((row.source_memory_ids as string) || '[]'),
      sourceEvents: JSON.parse((row.source_events as string) || '[]'),
      confidence: Number(row.confidence ?? 0.5),
      createdAt: toDate(row.created_at) || new Date()
    }));
  }

  async countRules(): Promise<number> {
    const result = await dbAll<{ count: number }>(
      this.db,
      `SELECT COUNT(*) as count FROM consolidated_rules`
    );
    return result[0]?.count || 0;
  }

  async hasRuleForSourceMemory(memoryId: string): Promise<boolean> {
    const rows = await dbAll<{ count: number }>(
      this.db,
      `SELECT COUNT(*) as count FROM consolidated_rules WHERE source_memory_ids LIKE ?`,
      [`%"${memoryId}"%`]
    );
    return (rows[0]?.count || 0) > 0;
  }

  /**
   * Get count of consolidated memories
   */
  async count(): Promise<number> {
    const result = await dbAll<{ count: number }>(
      this.db,
      `SELECT COUNT(*) as count FROM consolidated_memories`
    );
    return result[0]?.count || 0;
  }

  /**
   * Get most accessed memories (for importance scoring)
   */
  async getMostAccessed(limit: number = 10): Promise<ConsolidatedMemory[]> {
    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM consolidated_memories
       WHERE access_count > 0
       ORDER BY access_count DESC
       LIMIT ?`,
      [limit]
    );

    return rows.map(this.rowToMemory);
  }

  /**
   * Get statistics about consolidated memories
   */
  async getStats(): Promise<{
    total: number;
    averageConfidence: number;
    topicCounts: Record<string, number>;
    recentCount: number;
  }> {
    const total = await this.count();

    const avgResult = await dbAll<{ avg: number | null }>(
      this.db,
      `SELECT AVG(confidence) as avg FROM consolidated_memories`
    );
    const averageConfidence = avgResult[0]?.avg || 0;

    const recentResult = await dbAll<{ count: number }>(
      this.db,
      `SELECT COUNT(*) as count FROM consolidated_memories
       WHERE created_at > datetime('now', '-24 hours')`
    );
    const recentCount = recentResult[0]?.count || 0;

    // Get topic counts
    const allMemories = await this.getAll({ limit: 1000 });
    const topicCounts: Record<string, number> = {};
    for (const memory of allMemories) {
      for (const topic of memory.topics) {
        topicCounts[topic] = (topicCounts[topic] || 0) + 1;
      }
    }

    return {
      total,
      averageConfidence,
      topicCounts,
      recentCount
    };
  }

  /**
   * Check if source events are already consolidated
   */
  async isAlreadyConsolidated(eventIds: string[]): Promise<boolean> {
    for (const eventId of eventIds) {
      const result = await dbAll<{ count: number }>(
        this.db,
        `SELECT COUNT(*) as count FROM consolidated_memories
         WHERE source_events LIKE ?`,
        [`%"${eventId}"%`]
      );
      if ((result[0]?.count || 0) > 0) return true;
    }
    return false;
  }

  /**
   * Get the last consolidation time
   */
  async getLastConsolidationTime(): Promise<Date | null> {
    const result = await dbAll<{ created_at: string }>(
      this.db,
      `SELECT created_at FROM consolidated_memories
       ORDER BY created_at DESC
       LIMIT 1`
    );

    if (result.length === 0) return null;
    return new Date(result[0].created_at);
  }

  /**
   * Convert database row to ConsolidatedMemory
   */
  private rowToMemory(row: Record<string, unknown>): ConsolidatedMemory {
    return {
      memoryId: row.memory_id as string,
      summary: row.summary as string,
      topics: JSON.parse(row.topics as string || '[]'),
      sourceEvents: JSON.parse(row.source_events as string || '[]'),
      confidence: row.confidence as number,
      createdAt: toDate(row.created_at),
      accessedAt: row.accessed_at ? toDate(row.accessed_at) : undefined,
      accessCount: row.access_count as number || 0
    };
  }
}

/**
 * Create a Consolidated Store instance
 */
export function createConsolidatedStore(eventStore: EventStore): ConsolidatedStore {
  return new ConsolidatedStore(eventStore);
}
