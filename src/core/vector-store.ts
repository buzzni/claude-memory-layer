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

type LanceTable = lancedb.Table;

const MAX_LANCE_COMMIT_ATTEMPTS = 3;
const LANCE_COMMIT_RETRY_BASE_DELAY_MS = 20;

type VectorRow = {
  id: string;
  eventId: string;
  sessionId: string;
  eventType: string;
  content: string;
  vector: number[];
  timestamp: string;
  metadata: string;
};

export class VectorStore {
  private db: lancedb.Connection | null = null;
  private readonly tableCache = new Map<string, LanceTable>();
  private readonly defaultTableName = 'conversations';

  constructor(private dbPath: string) {}

  /**
   * Initialize LanceDB connection.
   *
   * Table handles are resolved lazily so Vector Outbox V2 can route records to
   * item-kind/embedding-version tables without eagerly touching the legacy
   * conversations table.
   */
  async initialize(): Promise<void> {
    if (this.db) return;
    this.db = await lancedb.connect(this.dbPath);
  }

  /**
   * Add or update vector record. Existing rows with the same stable id are
   * deleted before insertion to avoid append-only duplicates in LanceDB.
   */
  async upsert(record: VectorRecord): Promise<void> {
    await this.upsertBatch([record]);
  }

  /**
   * Add or update multiple vector records in batch, grouped by inferred table.
   */
  async upsertBatch(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;

    await this.initialize();

    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const groups = new Map<string, VectorRow[]>();
    for (const record of records) {
      const tableName = this.getRecordTableName(record);
      const rows = groups.get(tableName) ?? [];
      rows.push(this.toVectorRow(record));
      groups.set(tableName, rows);
    }

    for (const [tableName, rows] of groups) {
      await this.upsertRows(tableName, rows);
    }
  }

  /**
   * Search for similar vectors in the legacy conversations table.
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

    const table = await this.getExistingTable(this.defaultTableName);
    if (!table) {
      return [];
    }

    const { limit = 5, minScore = 0.7, sessionId } = options;

    // Use cosine distance for semantic similarity
    let query = table
      .search(queryVector)
      .distanceType('cosine')
      .limit(limit * 2); // Get more for filtering

    // Apply session filter if specified
    if (sessionId) {
      query = query.where(`sessionId = ${toLanceSqlString(sessionId)}`);
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
   * Delete vector by event ID from the legacy conversations table.
   */
  async delete(eventId: string): Promise<void> {
    await this.initialize();
    const table = await this.getExistingTable(this.defaultTableName);
    if (!table) return;
    await table.delete(`eventId = ${toLanceSqlString(eventId)}`);
  }

  /**
   * Get total count of vectors in the legacy conversations table.
   */
  async count(): Promise<number> {
    await this.initialize();
    const table = await this.getExistingTable(this.defaultTableName);
    if (!table) return 0;
    const result = await table.countRows();
    return result;
  }

  /**
   * Clear all legacy vectors (used for embedding model migration).
   */
  async clearAll(): Promise<void> {
    await this.initialize();
    if (!this.db) return;

    try {
      if (typeof (this.db as any).dropTable === 'function') {
        await (this.db as any).dropTable(this.defaultTableName);
      } else if (typeof (this.db as any).drop_table === 'function') {
        await (this.db as any).drop_table(this.defaultTableName);
      }
    } catch {
      // Ignore if table does not exist
    }

    this.tableCache.delete(this.defaultTableName);
  }

  /**
   * Check if vector exists for event in the legacy conversations table.
   */
  async exists(eventId: string): Promise<boolean> {
    await this.initialize();
    const table = await this.getExistingTable(this.defaultTableName);
    if (!table) return false;

    const results = await table
      .search([])
      .where(`eventId = ${toLanceSqlString(eventId)}`)
      .limit(1)
      .toArray();

    return results.length > 0;
  }

  private async upsertRows(tableName: string, rows: VectorRow[]): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const existingTable = await this.getExistingTable(tableName);
    if (existingTable) {
      await this.writeExistingRowsWithRetry(tableName, existingTable, rows);
      return;
    }

    try {
      const created = await this.db.createTable(tableName, rows);
      this.tableCache.set(tableName, created);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
      const racedTable = await this.openTable(tableName);
      await this.writeExistingRowsWithRetry(tableName, racedTable, rows);
    }
  }

  private async writeExistingRowsWithRetry(
    tableName: string,
    initialTable: LanceTable,
    rows: VectorRow[]
  ): Promise<void> {
    let table = initialTable;

    for (let attempt = 1; attempt <= MAX_LANCE_COMMIT_ATTEMPTS; attempt++) {
      try {
        for (const row of rows) {
          await table.delete(`id = ${toLanceSqlString(row.id)}`);
        }
        await table.add(rows);
        return;
      } catch (error) {
        if (!isLanceCommitConflict(error) || attempt === MAX_LANCE_COMMIT_ATTEMPTS) {
          throw error;
        }

        this.tableCache.delete(tableName);
        await delay(LANCE_COMMIT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        table = await this.openTable(tableName);
      }
    }
  }

  private async getExistingTable(tableName: string): Promise<LanceTable | null> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const cached = this.tableCache.get(tableName);
    if (cached) return cached;

    const tableNames = await this.db.tableNames();
    if (!tableNames.includes(tableName)) {
      return null;
    }

    return this.openTable(tableName);
  }

  private async openTable(tableName: string): Promise<LanceTable> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    const table = await this.db.openTable(tableName);
    this.tableCache.set(tableName, table);
    return table;
  }

  private getRecordTableName(record: VectorRecord): string {
    const metadata = record.metadata ?? {};
    const itemKind = typeof metadata.itemKind === 'string' ? metadata.itemKind : null;
    const embeddingVersion = typeof metadata.embeddingVersion === 'string' ? metadata.embeddingVersion : null;

    if (!itemKind || !embeddingVersion) {
      return this.defaultTableName;
    }

    return `${slugifyTablePart(itemKind)}_vectors_${slugifyTablePart(embeddingVersion)}`;
  }

  private toVectorRow(record: VectorRecord): VectorRow {
    return {
      id: record.id,
      eventId: record.eventId,
      sessionId: record.sessionId,
      eventType: record.eventType,
      content: record.content,
      vector: record.vector,
      timestamp: record.timestamp,
      metadata: JSON.stringify(record.metadata || {})
    };
  }
}

function slugifyTablePart(value: string): string {
  return value
    .trim()
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'default';
}

function toLanceSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function isAlreadyExistsError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return message.includes('already exists');
}

function isLanceCommitConflict(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return message.includes('commit conflict')
    && message.includes('concurrent commit')
    && message.includes('rerun the operation');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
