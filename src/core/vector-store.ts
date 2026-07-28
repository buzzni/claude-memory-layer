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

/**
 * Every Lance write is a new dataset version, and each version manifest embeds
 * the full fragment list — so N un-pruned versions cost O(N^2) on disk. Without
 * periodic pruning a busy project accumulates gigabytes of manifests for a few
 * hundred megabytes of vectors. Optimize on a commit counter instead.
 */
const DEFAULT_OPTIMIZE_EVERY_N_COMMITS = 50;
const DEFAULT_VERSION_RETENTION_MS = 60 * 60 * 1000;

/** Lance parses the whole predicate string, so chunk oversized `id IN (...)` deletes. */
const MAX_DELETE_PREDICATE_IDS = 200;

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
  private readonly commitsSinceOptimize = new Map<string, number>();
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
      query = query.where(toLanceColumnEquals('sessionId', sessionId));
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
    await table.delete(toLanceColumnEquals('eventId', eventId));
  }

  /**
   * Delete a vector by event ID from every table that could hold it: the
   * legacy conversations table plus every `event_vectors_<embeddingVersion>`
   * table (there can be more than one after an embedding model migration).
   */
  async deleteEventEverywhere(eventId: string): Promise<void> {
    await this.initialize();
    if (!this.db) return;

    const tableNames = await this.db.tableNames();
    const targetTables = tableNames.filter(
      (name) => name === this.defaultTableName || name.startsWith('event_vectors_')
    );

    for (const tableName of targetTables) {
      const table = await this.getExistingTable(tableName);
      if (!table) continue;
      await table.delete(toLanceColumnEquals('eventId', eventId));
    }
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
      .where(toLanceColumnEquals('eventId', eventId))
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
    const deletePredicates = buildIdDeletePredicates(rows.map(row => row.id));

    for (let attempt = 1; attempt <= MAX_LANCE_COMMIT_ATTEMPTS; attempt++) {
      try {
        for (const predicate of deletePredicates) {
          await table.delete(predicate);
        }
        await table.add(rows);
        await this.maybeOptimize(tableName, table, deletePredicates.length + 1);
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

  /**
   * Compact fragments and prune superseded versions across every table.
   *
   * Writers call this automatically via the commit counter; expose it so
   * maintenance paths can reclaim space accumulated before that existed.
   */
  async optimizeAll(): Promise<void> {
    await this.initialize();
    if (!this.db) return;

    for (const tableName of await this.db.tableNames()) {
      const table = await this.getExistingTable(tableName);
      if (!table) continue;
      this.commitsSinceOptimize.set(tableName, 0);
      await optimizeTable(table);
    }
  }

  private async maybeOptimize(tableName: string, table: LanceTable, commits: number): Promise<void> {
    const threshold = resolveOptimizeCommitInterval();
    if (threshold <= 0) return;

    const pending = (this.commitsSinceOptimize.get(tableName) ?? 0) + commits;
    if (pending < threshold) {
      this.commitsSinceOptimize.set(tableName, pending);
      return;
    }

    this.commitsSinceOptimize.set(tableName, 0);
    await optimizeTable(table);
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

/**
 * One `id IN (...)` delete per chunk instead of one delete per row: each Lance
 * delete is its own commit, so per-row deletes made a 32-record batch cost 33
 * versions instead of 2.
 */
function buildIdDeletePredicates(ids: string[]): string[] {
  if (ids.length === 0) return [];
  if (ids.length === 1) return [`id = ${toLanceSqlString(ids[0])}`];

  const predicates: string[] = [];
  for (let offset = 0; offset < ids.length; offset += MAX_DELETE_PREDICATE_IDS) {
    const chunk = ids.slice(offset, offset + MAX_DELETE_PREDICATE_IDS);
    predicates.push(`id IN (${chunk.map(toLanceSqlString).join(', ')})`);
  }
  return predicates;
}

function resolveOptimizeCommitInterval(): number {
  const raw = process.env.CLAUDE_MEMORY_LANCE_OPTIMIZE_EVERY;
  if (raw === undefined) return DEFAULT_OPTIMIZE_EVERY_N_COMMITS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_OPTIMIZE_EVERY_N_COMMITS;
}

function resolveVersionRetentionMs(): number {
  const raw = process.env.CLAUDE_MEMORY_LANCE_VERSION_RETENTION_MS;
  if (raw === undefined) return DEFAULT_VERSION_RETENTION_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_VERSION_RETENTION_MS;
}

/**
 * Best-effort maintenance: a failed compaction must never fail the write that
 * triggered it, and older lancedb builds have no `optimize` at all.
 */
async function optimizeTable(table: LanceTable): Promise<void> {
  const optimize = (table as { optimize?: (options?: { cleanupOlderThan?: Date }) => Promise<unknown> }).optimize;
  if (typeof optimize !== 'function') return;

  try {
    await optimize.call(table, { cleanupOlderThan: new Date(Date.now() - resolveVersionRetentionMs()) });
  } catch {
    // Compaction is opportunistic; retry on the next threshold crossing.
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

/**
 * Lance's predicate parser lowercases unquoted identifiers, so camelCase
 * columns (eventId, sessionId) silently fail to match the schema unless
 * backtick-quoted (double quotes parse without error but never match either).
 */
function toLanceColumnEquals(column: string, value: string): string {
  return `\`${column}\` = ${toLanceSqlString(value)}`;
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
