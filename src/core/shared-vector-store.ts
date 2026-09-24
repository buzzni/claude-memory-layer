/**
 * SharedVectorStore - Vector store for cross-project semantic search
 * Location: ~/.claude-code/memory/shared/vectors/
 */

import * as lancedb from '@lancedb/lancedb';
import type { SharedEntryType, SharedSearchResult } from './types.js';

export interface SharedVectorRecord {
  id: string;
  entryId: string;
  entryType: SharedEntryType;
  content: string;
  vector: number[];
  topics: string[];
  sourceProjectHash?: string;
}

export class SharedVectorStore {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private readonly tableName = 'shared_knowledge';

  constructor(private dbPath: string) {}

  /**
   * Initialize LanceDB connection
   */
  async initialize(): Promise<void> {
    if (this.db) return;

    this.db = await lancedb.connect(this.dbPath);

    try {
      const tables = await this.db.tableNames();
      if (tables.includes(this.tableName)) {
        this.table = await this.db.openTable(this.tableName);
      }
    } catch {
      this.table = null;
    }
  }

  /**
   * Add or update a shared vector record
   */
  async upsert(record: SharedVectorRecord): Promise<void> {
    await this.initialize();

    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const data = {
      id: record.id,
      entryId: record.entryId,
      entryType: record.entryType,
      content: record.content,
      vector: record.vector,
      topics: JSON.stringify(record.topics),
      sourceProjectHash: record.sourceProjectHash || ''
    };

    if (!this.table) {
      this.table = await this.db.createTable(this.tableName, [data]);
    } else {
      // Delete existing entry before adding (upsert behavior)
      try {
        await this.table.delete(`entryId = '${record.entryId}'`);
      } catch {
        // Entry might not exist, ignore
      }
      await this.table.add([data]);
    }
  }

  /**
   * Add multiple records in batch
   */
  async upsertBatch(records: SharedVectorRecord[]): Promise<void> {
    if (records.length === 0) return;

    await this.initialize();

    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const data = records.map(record => ({
      id: record.id,
      entryId: record.entryId,
      entryType: record.entryType,
      content: record.content,
      vector: record.vector,
      topics: JSON.stringify(record.topics),
      sourceProjectHash: record.sourceProjectHash || ''
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
      excludeProjectHash?: string;
      entryType?: SharedEntryType;
    } = {}
  ): Promise<SharedSearchResult[]> {
    await this.initialize();

    if (!this.table) {
      return [];
    }

    const { limit = 5, minScore = 0.7, excludeProjectHash, entryType } = options;

    let query = this.table
      .search(queryVector)
      .distanceType('cosine')
      .limit(limit * 2);

    // Apply filters
    const filters: string[] = [];
    if (excludeProjectHash) {
      filters.push(`sourceProjectHash != '${excludeProjectHash}'`);
    }
    if (entryType) {
      filters.push(`entryType = '${entryType}'`);
    }

    if (filters.length > 0) {
      query = query.where(filters.join(' AND '));
    }

    const results = await query.toArray();

    return results
      .filter(r => {
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
          entryId: r.entryId as string,
          content: r.content as string,
          score,
          entryType: r.entryType as SharedEntryType
        };
      });
  }

  /**
   * Delete vector by entry ID
   */
  async delete(entryId: string): Promise<void> {
    if (!this.table) return;
    await this.table.delete(`entryId = '${entryId}'`);
  }

  /**
   * Get total count
   */
  async count(): Promise<number> {
    if (!this.table) return 0;
    return this.table.countRows();
  }

  /**
   * Check if vector exists for entry
   */
  async exists(entryId: string): Promise<boolean> {
    if (!this.table) return false;

    try {
      const results = await this.table
        .search([])
        .where(`entryId = '${entryId}'`)
        .limit(1)
        .toArray();
      return results.length > 0;
    } catch {
      return false;
    }
  }
}

export function createSharedVectorStore(dbPath: string): SharedVectorStore {
  return new SharedVectorStore(dbPath);
}
