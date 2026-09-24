/**
 * LanceDB Vector Store for semantic search
 * AXIOMMIND Principle 6: Vector store consistency (DuckDB → outbox → LanceDB unidirectional)
 */

import * as lancedb from '@lancedb/lancedb';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VectorRecord } from './types.js';

export interface VectorPhysicalHealth {
  physicalBytes: number | null;
  tableCount: number | null;
  fragmentCount: number | null;
  versionCount: number | null;
  bytesPerLogicalVector: number | null;
  lastOptimizedAt: string | null;
  lastOptimizeOutcome: 'success' | 'failed' | 'unsupported' | 'never';
  amplificationState: 'normal' | 'elevated' | 'critical' | 'unknown';
}

export interface VectorOptimizeTableResult {
  tableKind: string;
  outcome: 'optimized' | 'skipped' | 'failed' | 'unsupported';
  safeErrorCode?: string;
}

export interface VectorOptimizeResult {
  startedAt: string;
  finishedAt: string;
  supported: boolean;
  tablesScanned: number;
  tablesOptimized: number;
  failures: number;
  beforeBytes: number | null;
  afterBytes: number | null;
  reclaimedBytes: number | null;
  tableResults: VectorOptimizeTableResult[];
  budgetExhausted?: boolean;
}

export interface VectorOptimizeOptions {
  maxTables?: number;
  maxDurationMs?: number;
  now?: () => number;
}

export interface VectorStoreOptions {
  readOnly?: boolean;
  /** Canonical project/global storage root that owns the vectors directory. */
  canonicalRoot?: string;
}

export function withVectorOptimizeIntegrityFailure(
  result: VectorOptimizeResult,
  safeErrorCode: 'logical_count_mismatch' | 'read_smoke_failed'
): VectorOptimizeResult {
  return {
    ...result,
    failures: result.failures + 1,
    tableResults: [
      ...result.tableResults,
      { tableKind: 'integrity_check', outcome: 'failed', safeErrorCode }
    ]
  };
}

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
const DEFAULT_MAX_OPTIMIZE_TABLES = 32;
const DEFAULT_OPTIMIZE_BUDGET_MS = 10 * 60 * 1000;

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
  private writeOptimizeFailures = 0;
  private readonly defaultTableName = 'conversations';

  private readonly readOnly: boolean;
  private readonly canonicalRoot?: string;

  constructor(private dbPath: string, options: VectorStoreOptions = {}) {
    this.readOnly = options.readOnly === true;
    this.canonicalRoot = options.canonicalRoot;
  }

  /**
   * Initialize LanceDB connection.
   *
   * Table handles are resolved lazily so Vector Outbox V2 can route records to
   * item-kind/embedding-version tables without eagerly touching the legacy
   * conversations table.
   */
  async initialize(): Promise<void> {
    if (this.db) return;
    // LanceDB creates its target directory during connect(). A read-only
    // service must therefore treat a missing or escaped vector index as empty
    // instead of connecting and mutating canonical storage.
    if (this.readOnly && !isOwnedExistingVectorDirectory(this.dbPath, this.canonicalRoot)) return;
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
    this.assertWritable();

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
    if (!this.db) return [];

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
    this.assertWritable();
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
    this.assertWritable();
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
    if (!this.db) return 0;
    const table = await this.getExistingTable(this.defaultTableName);
    if (!table) return 0;
    const result = await table.countRows();
    return result;
  }

  /** Count logical rows across every CML vector table. */
  async countAll(): Promise<number> {
    await this.initialize();
    if (!this.db) return 0;
    let total = 0;
    for (const tableName of await this.db.tableNames()) {
      const table = await this.getExistingTable(tableName);
      if (table) total += await table.countRows();
    }
    return total;
  }

  /** Capture bounded private row identities for a post-maintenance read smoke check. */
  async createReadSmokeVerifier(maxTables = DEFAULT_MAX_OPTIMIZE_TABLES): Promise<() => Promise<boolean>> {
    await this.initialize();
    if (!this.db) return async () => true;
    const boundedTables = normalizeOptimizeBound(maxTables, DEFAULT_MAX_OPTIMIZE_TABLES, 1, 1_000);
    const samples: Array<{ tableName: string; id: string }> = [];
    for (const tableName of (await this.db.tableNames()).slice(0, boundedTables)) {
      const table = await this.getExistingTable(tableName);
      if (!table || await table.countRows() === 0) continue;
      // `search([])` is a zero-dimensional vector query and fails for every
      // real non-empty embedding table. Use a scalar table query for the
      // identity sample so this verifier is independent of vector dimension.
      const rows = await table.query().limit(1).toArray();
      const id = rows[0]?.id;
      if (typeof id !== 'string' || id.length === 0) return async () => false;
      samples.push({ tableName, id });
    }
    return async () => {
      try {
        for (const sample of samples) {
          const table = await this.getExistingTable(sample.tableName);
          if (!table) return false;
          const rows = await table.query()
            .where(toLanceColumnEquals('id', sample.id))
            .limit(1)
            .toArray();
          if (rows.length !== 1) return false;
        }
        return true;
      } catch {
        return false;
      }
    };
  }

  /**
   * Clear all legacy vectors (used for embedding model migration).
   */
  async clearAll(): Promise<void> {
    this.assertWritable();
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
    if (!this.db) return false;
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
  async optimizeAll(options: VectorOptimizeOptions = {}): Promise<VectorOptimizeResult> {
    this.assertWritable();
    const now = options.now ?? Date.now;
    const maxTables = normalizeOptimizeBound(options.maxTables, DEFAULT_MAX_OPTIMIZE_TABLES, 1, 1_000);
    const maxDurationMs = normalizeOptimizeBound(options.maxDurationMs, DEFAULT_OPTIMIZE_BUDGET_MS, 0, 60 * 60 * 1000);
    const deadline = now() + maxDurationMs;
    const startedAt = new Date().toISOString();
    const beforeBytes = measureVectorDirectory(this.dbPath).physicalBytes;
    await this.initialize();
    if (!this.db) {
      return emptyOptimizeResult(startedAt, beforeBytes);
    }

    const tableResults: VectorOptimizeTableResult[] = [];
    const tableNames = await this.db.tableNames();
    let budgetExhausted = false;
    for (let index = 0; index < tableNames.length; index += 1) {
      const tableName = tableNames[index];
      if (index >= maxTables || now() >= deadline) {
        budgetExhausted = true;
        for (const skippedName of tableNames.slice(index)) {
          tableResults.push({
            tableKind: normalizeTableKind(skippedName),
            outcome: 'skipped',
            safeErrorCode: 'budget_exhausted'
          });
        }
        break;
      }
      const table = await this.getExistingTable(tableName);
      if (!table) {
        tableResults.push({ tableKind: normalizeTableKind(tableName), outcome: 'skipped' });
        continue;
      }
      this.commitsSinceOptimize.set(tableName, 0);
      tableResults.push({
        tableKind: normalizeTableKind(tableName),
        ...await optimizeTable(table, false)
      });
    }
    const afterBytes = measureVectorDirectory(this.dbPath).physicalBytes;
    const result: VectorOptimizeResult = {
      startedAt,
      finishedAt: new Date().toISOString(),
      supported: tableResults.some((item) => item.outcome === 'optimized' || item.outcome === 'failed'),
      tablesScanned: tableNames.length,
      tablesOptimized: tableResults.filter((item) => item.outcome === 'optimized').length,
      failures: tableResults.filter((item) => item.outcome === 'failed').length,
      beforeBytes,
      afterBytes,
      reclaimedBytes: beforeBytes === null || afterBytes === null ? null : Math.max(0, beforeBytes - afterBytes),
      tableResults,
      budgetExhausted
    };
    writeOptimizeState(this.dbPath, result);
    return result;
  }

  async getPhysicalHealth(logicalVectorCount?: number): Promise<VectorPhysicalHealth> {
    await this.initialize();
    const metrics = measureVectorDirectory(this.dbPath);
    const tableCount = this.db ? (await this.db.tableNames()).length : null;
    const state = readOptimizeState(this.dbPath);
    const bytesPerLogicalVector = metrics.physicalBytes !== null
      && typeof logicalVectorCount === 'number'
      && logicalVectorCount > 0
      ? Math.round(metrics.physicalBytes / logicalVectorCount)
      : null;
    return {
      physicalBytes: metrics.physicalBytes,
      tableCount,
      fragmentCount: metrics.fragmentCount,
      versionCount: metrics.versionCount,
      bytesPerLogicalVector,
      lastOptimizedAt: state && !state.budgetExhausted ? state.finishedAt : null,
      lastOptimizeOutcome: state
        ? state.failures > 0
          ? 'failed'
          : state.budgetExhausted && !state.supported
            ? 'never'
            : state.supported ? 'success' : 'unsupported'
        : 'never',
      amplificationState: amplificationState(bytesPerLogicalVector)
    };
  }

  persistOptimizeResult(result: VectorOptimizeResult): void {
    this.assertWritable();
    writeOptimizeState(this.dbPath, result);
  }

  getWriteOptimizeFailureCount(): number {
    return this.writeOptimizeFailures;
  }

  private assertWritable(): void {
    if (this.readOnly) throw new Error('VectorStore is read-only');
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
    const result = await optimizeTable(table, true);
    if (result.outcome === 'failed') this.writeOptimizeFailures += 1;
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
async function optimizeTable(
  table: LanceTable,
  swallowFailure: boolean
): Promise<Omit<VectorOptimizeTableResult, 'tableKind'>> {
  const optimize = (table as { optimize?: (options?: { cleanupOlderThan?: Date }) => Promise<unknown> }).optimize;
  if (typeof optimize !== 'function') return { outcome: 'unsupported' };

  try {
    await optimize.call(table, { cleanupOlderThan: new Date(Date.now() - resolveVersionRetentionMs()) });
    return { outcome: 'optimized' };
  } catch (error) {
    const result = { outcome: 'failed' as const, safeErrorCode: classifyOptimizeError(error) };
    if (!swallowFailure) return result;
    // Write-triggered compaction is opportunistic; retry on the next threshold crossing.
    return result;
  }
}

function classifyOptimizeError(error: unknown): string {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  if (message.includes('lock') || message.includes('busy')) return 'busy';
  if (message.includes('space') || message.includes('disk')) return 'disk_pressure';
  if (message.includes('unsupported') || message.includes('not implemented')) return 'unsupported_api';
  return 'optimize_failed';
}

function normalizeTableKind(tableName: string): string {
  if (tableName === 'conversations') return 'conversations';
  if (/^event_vectors_/i.test(tableName)) return 'event_vectors';
  if (/^tool_observation_vectors_/i.test(tableName)) return 'tool_observation_vectors';
  return 'other';
}

function measureVectorDirectory(dbPath: string): {
  physicalBytes: number | null;
  fragmentCount: number | null;
  versionCount: number | null;
} {
  if (!fs.existsSync(dbPath)) return { physicalBytes: 0, fragmentCount: 0, versionCount: 0 };
  let physicalBytes = 0;
  let fragmentCount = 0;
  let versionCount = 0;
  try {
    const pending = [dbPath];
    while (pending.length > 0) {
      const current = pending.pop()!;
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
      } else if (stat.isFile()) {
        physicalBytes += stat.size;
        if (/\.lance$/i.test(current) || /[/\\]data[/\\]/.test(current)) fragmentCount += 1;
        if (/\.manifest$/i.test(current) || /[/\\]_versions[/\\]/.test(current)) versionCount += 1;
      }
    }
    return { physicalBytes, fragmentCount, versionCount };
  } catch {
    return { physicalBytes: null, fragmentCount: null, versionCount: null };
  }
}

function isOwnedExistingVectorDirectory(dbPath: string, canonicalRoot?: string): boolean {
  try {
    const vectorStat = fs.lstatSync(dbPath);
    if (!vectorStat.isDirectory() || vectorStat.isSymbolicLink()) return false;
    if (!canonicalRoot) return true;
    const rootStat = fs.lstatSync(canonicalRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
    const relative = path.relative(fs.realpathSync(canonicalRoot), fs.realpathSync(dbPath));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function amplificationState(bytesPerLogicalVector: number | null): VectorPhysicalHealth['amplificationState'] {
  const elevated = Number(process.env.CLAUDE_MEMORY_VECTOR_ELEVATED_BYTES_PER_ROW);
  const critical = Number(process.env.CLAUDE_MEMORY_VECTOR_CRITICAL_BYTES_PER_ROW);
  if (bytesPerLogicalVector === null || !Number.isFinite(elevated) || !Number.isFinite(critical)
    || elevated <= 0 || critical < elevated) return 'unknown';
  if (bytesPerLogicalVector >= critical) return 'critical';
  if (bytesPerLogicalVector >= elevated) return 'elevated';
  return 'normal';
}

function optimizeStatePath(dbPath: string): string {
  return path.join(dbPath, '.cml-optimize-state.json');
}

function writeOptimizeState(dbPath: string, result: VectorOptimizeResult): void {
  try {
    fs.mkdirSync(dbPath, { recursive: true });
    const target = optimizeStatePath(dbPath);
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({
      finishedAt: result.finishedAt,
      supported: result.supported,
      failures: result.failures,
      reclaimedBytes: result.reclaimedBytes,
      budgetExhausted: result.budgetExhausted === true
    }), { mode: 0o600 });
    fs.renameSync(temp, target);
  } catch {
    // Maintenance result remains returned even if optional bounded state cannot be persisted.
  }
}

function readOptimizeState(dbPath: string): {
  finishedAt: string;
  supported: boolean;
  failures: number;
  budgetExhausted: boolean;
} | null {
  try {
    const value = JSON.parse(fs.readFileSync(optimizeStatePath(dbPath), 'utf8')) as Record<string, unknown>;
    if (typeof value.finishedAt !== 'string' || !Number.isFinite(Date.parse(value.finishedAt))) return null;
    return {
      finishedAt: value.finishedAt,
      supported: value.supported === true,
      failures: Number.isFinite(value.failures) ? Number(value.failures) : 0,
      budgetExhausted: value.budgetExhausted === true
    };
  } catch {
    return null;
  }
}

function emptyOptimizeResult(startedAt: string, beforeBytes: number | null): VectorOptimizeResult {
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    supported: false,
    tablesScanned: 0,
    tablesOptimized: 0,
    failures: 0,
    beforeBytes,
    afterBytes: beforeBytes,
    reclaimedBytes: beforeBytes === null ? null : 0,
    tableResults: [],
    budgetExhausted: false
  };
}

function normalizeOptimizeBound(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`vector optimize bound must be an integer between ${min} and ${max}`);
  }
  return value;
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
