/**
 * Consolidated Store
 * Manages long-term integrated memories for Endless Mode
 * Biomimetic: Simulates memory consolidation that occurs during sleep
 */

import { randomUUID } from 'crypto';
import { Database } from 'duckdb';
import type {
  ConsolidatedMemory,
  ConsolidatedMemoryInput
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

    await this.db.run(
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
    const rows = await this.db.all<Array<Record<string, unknown>>>(
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

    const rows = await this.db.all<Array<Record<string, unknown>>>(
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

    const rows = await this.db.all<Array<Record<string, unknown>>>(
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

    const rows = await this.db.all<Array<Record<string, unknown>>>(
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

    const rows = await this.db.all<Array<Record<string, unknown>>>(
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
    await this.db.run(
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
    await this.db.run(
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
    await this.db.run(
      `DELETE FROM consolidated_memories WHERE memory_id = ?`,
      [memoryId]
    );
  }

  /**
   * Get count of consolidated memories
   */
  async count(): Promise<number> {
    const result = await this.db.all<Array<{ count: number }>>(
      `SELECT COUNT(*) as count FROM consolidated_memories`
    );
    return result[0]?.count || 0;
  }

  /**
   * Get most accessed memories (for importance scoring)
   */
  async getMostAccessed(limit: number = 10): Promise<ConsolidatedMemory[]> {
    const rows = await this.db.all<Array<Record<string, unknown>>>(
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

    const avgResult = await this.db.all<Array<{ avg: number | null }>>(
      `SELECT AVG(confidence) as avg FROM consolidated_memories`
    );
    const averageConfidence = avgResult[0]?.avg || 0;

    const recentResult = await this.db.all<Array<{ count: number }>>(
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
      const result = await this.db.all<Array<{ count: number }>>(
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
    const result = await this.db.all<Array<{ created_at: string }>>(
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
      createdAt: new Date(row.created_at as string),
      accessedAt: row.accessed_at ? new Date(row.accessed_at as string) : undefined,
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
