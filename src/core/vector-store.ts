/**
 * LanceDB Vector Store for semantic search
 * AXIOMMIND Principle 6: Vector store consistency (DuckDB → outbox → LanceDB unidirectional)
 */

import * as lancedb from '@lancedb/lancedb';
import type { VectorRecord } from './types.js';

export interface SearchResult {
  id: string;
  eventId: string;
  content: string;
  score: number;
  sessionId: string;
  eventType: string;
  timestamp: string;
}

export class VectorStore {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private readonly tableName = 'conversations';

  constructor(private dbPath: string) {}

  /**
   * Initialize LanceDB connection
   */
  async initialize(): Promise<void> {
    if (this.db) return;

    this.db = await lancedb.connect(this.dbPath);

    // Try to open existing table
    try {
      const tables = await this.db.tableNames();
      if (tables.includes(this.tableName)) {
        this.table = await this.db.openTable(this.tableName);
      }
    } catch {
      // Table doesn't exist yet, will be created on first insert
      this.table = null;
    }
  }

  /**
   * Add or update vector record
   */
  async upsert(record: VectorRecord): Promise<void> {
    await this.initialize();

    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const data = {
      id: record.id,
      eventId: record.eventId,
      sessionId: record.sessionId,
      eventType: record.eventType,
      content: record.content,
      vector: record.vector,
      timestamp: record.timestamp,
      metadata: JSON.stringify(record.metadata || {})
    };

    if (!this.table) {
      // Create table with first record
      this.table = await this.db.createTable(this.tableName, [data]);
    } else {
      await this.table.add([data]);
    }
  }

  /**
   * Add multiple vector records in batch
   */
  async upsertBatch(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;

    await this.initialize();

    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const data = records.map(record => ({
      id: record.id,
      eventId: record.eventId,
      sessionId: record.sessionId,
      eventType: record.eventType,
      content: record.content,
      vector: record.vector,
      timestamp: record.timestamp,
      metadata: JSON.stringify(record.metadata || {})
    }));

    if (!this.table) {
      this.table = await this.db.createTable(this.tableName, data);
    } else {
      await this.table.add(data);
    }
  }

  /**
   * Search for similar vectors
   */
  async search(
    queryVector: number[],
    options: {
      limit?: number;
      minScore?: number;
      sessionId?: string;
    } = {}
  ): Promise<SearchResult[]> {
    await this.initialize();

    if (!this.table) {
      return [];
    }

    const { limit = 5, minScore = 0.7, sessionId } = options;

    // Use cosine distance for semantic similarity
    let query = this.table
      .search(queryVector)
      .distanceType('cosine')
      .limit(limit * 2); // Get more for filtering

    // Apply session filter if specified
    if (sessionId) {
      query = query.where(`sessionId = '${sessionId}'`);
    }

    const results = await query.toArray();

    return results
      .filter(r => {
        // Convert cosine distance to similarity score
        // Cosine distance ranges from 0 (identical) to 2 (opposite)
        // Score = 1 - (distance / 2) gives range [0, 1]
        const distance = r._distance || 0;
        const score = 1 - (distance / 2);
        return score >= minScore;
      })
      .slice(0, limit)
      .map(r => {
        const distance = r._distance || 0;
        const score = 1 - (distance / 2);
        return {
          id: r.id as string,
          eventId: r.eventId as string,
          content: r.content as string,
          score,
          sessionId: r.sessionId as string,
          eventType: r.eventType as string,
          timestamp: r.timestamp as string
        };
      });
  }

  /**
   * Delete vector by event ID
   */
  async delete(eventId: string): Promise<void> {
    if (!this.table) return;
    await this.table.delete(`eventId = '${eventId}'`);
  }

  /**
   * Get total count of vectors
   */
  async count(): Promise<number> {
    if (!this.table) return 0;
    const result = await this.table.countRows();
    return result;
  }

  /**
   * Check if vector exists for event
   */
  async exists(eventId: string): Promise<boolean> {
    if (!this.table) return false;

    const results = await this.table
      .search([])
      .where(`eventId = '${eventId}'`)
      .limit(1)
      .toArray();

    return results.length > 0;
  }
}
