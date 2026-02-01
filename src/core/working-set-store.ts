/**
 * Working Set Store
 * Manages the active memory window for Endless Mode
 * Biomimetic: Simulates human working memory (7±2 items, 15-30s duration)
 */

import { randomUUID } from 'crypto';
import { Database } from 'duckdb';
import type {
  MemoryEvent,
  EndlessModeConfig,
  WorkingSet,
  WorkingSetItem
} from './types.js';
import { EventStore } from './event-store.js';

export class WorkingSetStore {
  constructor(
    private eventStore: EventStore,
    private config: EndlessModeConfig
  ) {}

  private get db(): Database {
    return this.eventStore.getDatabase();
  }

  /**
   * Add an event to the working set
   */
  async add(eventId: string, relevanceScore: number = 1.0, topics?: string[]): Promise<void> {
    const expiresAt = new Date(
      Date.now() + this.config.workingSet.timeWindowHours * 60 * 60 * 1000
    );

    await this.db.run(
      `INSERT OR REPLACE INTO working_set (id, event_id, added_at, relevance_score, topics, expires_at)
       VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?)`,
      [
        randomUUID(),
        eventId,
        relevanceScore,
        JSON.stringify(topics || []),
        expiresAt.toISOString()
      ]
    );

    // Enforce size limit
    await this.enforceLimit();
  }

  /**
   * Get the current working set
   */
  async get(): Promise<WorkingSet> {
    // Clean up expired items first
    await this.cleanup();

    // Get working set items with their events
    const rows = await this.db.all<Array<Record<string, unknown>>>(
      `SELECT ws.*, e.*
       FROM working_set ws
       JOIN events e ON ws.event_id = e.id
       ORDER BY ws.relevance_score DESC, ws.added_at DESC
       LIMIT ?`,
      [this.config.workingSet.maxEvents]
    );

    const events: MemoryEvent[] = rows.map(row => ({
      id: row.id as string,
      eventType: row.event_type as 'user_prompt' | 'agent_response' | 'session_summary' | 'tool_observation',
      sessionId: row.session_id as string,
      timestamp: new Date(row.timestamp as string),
      content: row.content as string,
      canonicalKey: row.canonical_key as string,
      dedupeKey: row.dedupe_key as string,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined
    }));

    return {
      recentEvents: events,
      lastActivity: events.length > 0 ? events[0].timestamp : new Date(),
      continuityScore: await this.calculateContinuityScore()
    };
  }

  /**
   * Get working set items (metadata only)
   */
  async getItems(): Promise<WorkingSetItem[]> {
    const rows = await this.db.all<Array<Record<string, unknown>>>(
      `SELECT * FROM working_set ORDER BY relevance_score DESC, added_at DESC`
    );

    return rows.map(row => ({
      id: row.id as string,
      eventId: row.event_id as string,
      addedAt: new Date(row.added_at as string),
      relevanceScore: row.relevance_score as number,
      topics: row.topics ? JSON.parse(row.topics as string) : undefined,
      expiresAt: new Date(row.expires_at as string)
    }));
  }

  /**
   * Update relevance score for an event
   */
  async updateRelevance(eventId: string, score: number): Promise<void> {
    await this.db.run(
      `UPDATE working_set SET relevance_score = ? WHERE event_id = ?`,
      [score, eventId]
    );
  }

  /**
   * Prune specific events from working set (after consolidation)
   */
  async prune(eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return;

    const placeholders = eventIds.map(() => '?').join(',');
    await this.db.run(
      `DELETE FROM working_set WHERE event_id IN (${placeholders})`,
      eventIds
    );
  }

  /**
   * Get the count of items in working set
   */
  async count(): Promise<number> {
    const result = await this.db.all<Array<{ count: number }>>(
      `SELECT COUNT(*) as count FROM working_set`
    );
    return result[0]?.count || 0;
  }

  /**
   * Clear the entire working set
   */
  async clear(): Promise<void> {
    await this.db.run(`DELETE FROM working_set`);
  }

  /**
   * Check if an event is in the working set
   */
  async contains(eventId: string): Promise<boolean> {
    const result = await this.db.all<Array<{ count: number }>>(
      `SELECT COUNT(*) as count FROM working_set WHERE event_id = ?`,
      [eventId]
    );
    return (result[0]?.count || 0) > 0;
  }

  /**
   * Refresh expiration for an event (rehears al - keep relevant items longer)
   */
  async refresh(eventId: string): Promise<void> {
    const newExpiresAt = new Date(
      Date.now() + this.config.workingSet.timeWindowHours * 60 * 60 * 1000
    );

    await this.db.run(
      `UPDATE working_set SET expires_at = ? WHERE event_id = ?`,
      [newExpiresAt.toISOString(), eventId]
    );
  }

  /**
   * Clean up expired items
   */
  private async cleanup(): Promise<void> {
    await this.db.run(
      `DELETE FROM working_set WHERE expires_at < datetime('now')`
    );
  }

  /**
   * Enforce the maximum size limit
   * Removes lowest relevance items when over limit
   */
  private async enforceLimit(): Promise<void> {
    const maxEvents = this.config.workingSet.maxEvents;

    // Get IDs to keep (highest relevance, most recent)
    const keepIds = await this.db.all<Array<{ id: string }>>(
      `SELECT id FROM working_set
       ORDER BY relevance_score DESC, added_at DESC
       LIMIT ?`,
      [maxEvents]
    );

    if (keepIds.length === 0) return;

    const keepIdList = keepIds.map(r => r.id);
    const placeholders = keepIdList.map(() => '?').join(',');

    // Delete everything not in the keep list
    await this.db.run(
      `DELETE FROM working_set WHERE id NOT IN (${placeholders})`,
      keepIdList
    );
  }

  /**
   * Calculate continuity score based on recent context transitions
   */
  private async calculateContinuityScore(): Promise<number> {
    const result = await this.db.all<Array<{ avg_score: number | null }>>(
      `SELECT AVG(continuity_score) as avg_score
       FROM continuity_log
       WHERE created_at > datetime('now', '-1 hour')`
    );

    return result[0]?.avg_score ?? 0.5;
  }

  /**
   * Get topics from current working set for context matching
   */
  async getActiveTopics(): Promise<string[]> {
    const rows = await this.db.all<Array<{ topics: string }>>(
      `SELECT topics FROM working_set WHERE topics IS NOT NULL`
    );

    const allTopics = new Set<string>();
    for (const row of rows) {
      const topics = JSON.parse(row.topics) as string[];
      topics.forEach(t => allTopics.add(t));
    }

    return Array.from(allTopics);
  }
}

/**
 * Create a Working Set Store instance
 */
export function createWorkingSetStore(
  eventStore: EventStore,
  config: EndlessModeConfig
): WorkingSetStore {
  return new WorkingSetStore(eventStore, config);
}
