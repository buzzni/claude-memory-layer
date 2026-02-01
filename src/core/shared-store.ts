/**
 * SharedStore - Cross-project troubleshooting knowledge store
 * Manages promotion from verified entries to shared storage
 */

import { randomUUID } from 'crypto';
import { dbRun, dbAll, toDate, type Database } from './db-wrapper.js';
import type {
  SharedTroubleshootingEntry,
  SharedTroubleshootingInput
} from './types.js';
import { SharedEventStore } from './shared-event-store.js';

export class SharedStore {
  constructor(private sharedEventStore: SharedEventStore) {}

  private get db(): Database {
    return this.sharedEventStore.getDatabase();
  }

  /**
   * Promote a verified troubleshooting entry to shared storage
   */
  async promoteEntry(
    input: SharedTroubleshootingInput
  ): Promise<string> {
    const entryId = randomUUID();

    await dbRun(
      this.db,
      `INSERT INTO shared_troubleshooting (
        entry_id, source_project_hash, source_entry_id,
        title, symptoms, root_cause, solution, topics,
        technologies, confidence, promoted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT (source_project_hash, source_entry_id)
      DO UPDATE SET
        title = excluded.title,
        symptoms = excluded.symptoms,
        root_cause = excluded.root_cause,
        solution = excluded.solution,
        topics = excluded.topics,
        technologies = excluded.technologies,
        confidence = CASE
          WHEN excluded.confidence > shared_troubleshooting.confidence
          THEN excluded.confidence
          ELSE shared_troubleshooting.confidence
        END`,
      [
        entryId,
        input.sourceProjectHash,
        input.sourceEntryId,
        input.title,
        JSON.stringify(input.symptoms),
        input.rootCause,
        input.solution,
        JSON.stringify(input.topics),
        JSON.stringify(input.technologies || []),
        input.confidence
      ]
    );

    return entryId;
  }

  /**
   * Search troubleshooting entries by text query
   */
  async search(
    query: string,
    options?: { topK?: number; minConfidence?: number }
  ): Promise<SharedTroubleshootingEntry[]> {
    const topK = options?.topK || 5;
    const minConfidence = options?.minConfidence || 0.5;
    const searchPattern = `%${query}%`;

    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM shared_troubleshooting
       WHERE (title LIKE ? OR root_cause LIKE ? OR solution LIKE ?)
       AND confidence >= ?
       ORDER BY confidence DESC, usage_count DESC
       LIMIT ?`,
      [searchPattern, searchPattern, searchPattern, minConfidence, topK]
    );

    return rows.map(this.rowToEntry);
  }

  /**
   * Search by topics
   */
  async searchByTopics(
    topics: string[],
    options?: { topK?: number; excludeProjectHash?: string }
  ): Promise<SharedTroubleshootingEntry[]> {
    const topK = options?.topK || 5;

    if (topics.length === 0) {
      return [];
    }

    const topicConditions = topics.map(() => `topics LIKE ?`).join(' OR ');
    const topicParams = topics.map(t => `%"${t}"%`);

    let query = `SELECT * FROM shared_troubleshooting WHERE (${topicConditions})`;
    const params: unknown[] = [...topicParams];

    if (options?.excludeProjectHash) {
      query += ` AND source_project_hash != ?`;
      params.push(options.excludeProjectHash);
    }

    query += ` ORDER BY confidence DESC, usage_count DESC LIMIT ?`;
    params.push(topK);

    const rows = await dbAll<Record<string, unknown>>(this.db, query, params);
    return rows.map(this.rowToEntry);
  }

  /**
   * Record usage of a shared entry (for ranking)
   */
  async recordUsage(entryId: string): Promise<void> {
    await dbRun(
      this.db,
      `UPDATE shared_troubleshooting
       SET usage_count = usage_count + 1,
           last_used_at = CURRENT_TIMESTAMP
       WHERE entry_id = ?`,
      [entryId]
    );
  }

  /**
   * Get entry by ID
   */
  async get(entryId: string): Promise<SharedTroubleshootingEntry | null> {
    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM shared_troubleshooting WHERE entry_id = ?`,
      [entryId]
    );

    if (rows.length === 0) return null;
    return this.rowToEntry(rows[0]);
  }

  /**
   * Get entry by source (project hash + entry ID)
   */
  async getBySource(
    projectHash: string,
    sourceEntryId: string
  ): Promise<SharedTroubleshootingEntry | null> {
    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM shared_troubleshooting
       WHERE source_project_hash = ? AND source_entry_id = ?`,
      [projectHash, sourceEntryId]
    );

    if (rows.length === 0) return null;
    return this.rowToEntry(rows[0]);
  }

  /**
   * Check if an entry already exists in shared store
   */
  async exists(projectHash: string, sourceEntryId: string): Promise<boolean> {
    const result = await dbAll<{ count: number }>(
      this.db,
      `SELECT COUNT(*) as count FROM shared_troubleshooting
       WHERE source_project_hash = ? AND source_entry_id = ?`,
      [projectHash, sourceEntryId]
    );
    return (result[0]?.count || 0) > 0;
  }

  /**
   * Get all entries (with limit for safety)
   */
  async getAll(options?: { limit?: number }): Promise<SharedTroubleshootingEntry[]> {
    const limit = options?.limit || 100;
    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM shared_troubleshooting
       ORDER BY confidence DESC, usage_count DESC
       LIMIT ?`,
      [limit]
    );

    return rows.map(this.rowToEntry);
  }

  /**
   * Get total count
   */
  async count(): Promise<number> {
    const result = await dbAll<{ count: number }>(
      this.db,
      `SELECT COUNT(*) as count FROM shared_troubleshooting`
    );
    return result[0]?.count || 0;
  }

  /**
   * Get statistics
   */
  async getStats(): Promise<{
    total: number;
    averageConfidence: number;
    topTopics: Array<{ topic: string; count: number }>;
    totalUsageCount: number;
  }> {
    const countResult = await dbAll<{ count: number }>(
      this.db,
      `SELECT COUNT(*) as count FROM shared_troubleshooting`
    );
    const total = countResult[0]?.count || 0;

    const avgResult = await dbAll<{ avg: number | null }>(
      this.db,
      `SELECT AVG(confidence) as avg FROM shared_troubleshooting`
    );
    const averageConfidence = avgResult[0]?.avg || 0;

    const usageResult = await dbAll<{ total: number }>(
      this.db,
      `SELECT SUM(usage_count) as total FROM shared_troubleshooting`
    );
    const totalUsageCount = usageResult[0]?.total || 0;

    // Get topic counts
    const entries = await this.getAll({ limit: 1000 });
    const topicCounts: Record<string, number> = {};
    for (const entry of entries) {
      for (const topic of entry.topics) {
        topicCounts[topic] = (topicCounts[topic] || 0) + 1;
      }
    }

    const topTopics = Object.entries(topicCounts)
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return { total, averageConfidence, topTopics, totalUsageCount };
  }

  /**
   * Delete an entry
   */
  async delete(entryId: string): Promise<boolean> {
    const before = await this.count();
    await dbRun(
      this.db,
      `DELETE FROM shared_troubleshooting WHERE entry_id = ?`,
      [entryId]
    );
    const after = await this.count();
    return before > after;
  }

  private rowToEntry(row: Record<string, unknown>): SharedTroubleshootingEntry {
    return {
      entryId: row.entry_id as string,
      sourceProjectHash: row.source_project_hash as string,
      sourceEntryId: row.source_entry_id as string,
      title: row.title as string,
      symptoms: JSON.parse(row.symptoms as string || '[]'),
      rootCause: row.root_cause as string,
      solution: row.solution as string,
      topics: JSON.parse(row.topics as string || '[]'),
      technologies: JSON.parse(row.technologies as string || '[]'),
      confidence: row.confidence as number,
      usageCount: row.usage_count as number || 0,
      lastUsedAt: row.last_used_at ? toDate(row.last_used_at) : undefined,
      promotedAt: toDate(row.promoted_at),
      createdAt: toDate(row.created_at)
    };
  }
}

export function createSharedStore(
  sharedEventStore: SharedEventStore
): SharedStore {
  return new SharedStore(sharedEventStore);
}
