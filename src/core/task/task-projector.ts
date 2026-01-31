/**
 * Task Projector - Project task events to entities/edges
 * AXIOMMIND: Incremental processing with offset tracking
 */

import { Database } from 'duckdb';
import { randomUUID } from 'crypto';
import type { BlockerMode, BlockerRef } from '../types.js';

const PROJECTOR_NAME = 'task_projector';
const TASK_EVENT_TYPES = [
  'task_created',
  'task_status_changed',
  'task_priority_changed',
  'task_blockers_set',
  'task_transition_rejected',
  'condition_resolved_to'
];

interface ProjectionOffset {
  lastEventId: string | null;
  lastTimestamp: Date | null;
}

interface TaskEvent {
  id: string;
  eventType: string;
  sessionId: string;
  timestamp: Date;
  content: Record<string, unknown>;
}

export class TaskProjector {
  constructor(private db: Database) {}

  /**
   * Get current projection offset
   */
  async getOffset(): Promise<ProjectionOffset> {
    const rows = await this.db.all<Array<Record<string, unknown>>>(
      `SELECT last_event_id, last_timestamp
       FROM projection_offsets
       WHERE projection_name = ?`,
      [PROJECTOR_NAME]
    );

    if (rows.length === 0) {
      return { lastEventId: null, lastTimestamp: null };
    }

    return {
      lastEventId: rows[0].last_event_id as string | null,
      lastTimestamp: rows[0].last_timestamp
        ? new Date(rows[0].last_timestamp as string)
        : null
    };
  }

  /**
   * Update projection offset
   */
  private async updateOffset(eventId: string, timestamp: Date): Promise<void> {
    await this.db.run(
      `INSERT INTO projection_offsets (projection_name, last_event_id, last_timestamp, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (projection_name) DO UPDATE SET
         last_event_id = excluded.last_event_id,
         last_timestamp = excluded.last_timestamp,
         updated_at = CURRENT_TIMESTAMP`,
      [PROJECTOR_NAME, eventId, timestamp.toISOString()]
    );
  }

  /**
   * Fetch events since last offset
   */
  async fetchEventsSince(
    offset: ProjectionOffset,
    limit: number = 100
  ): Promise<TaskEvent[]> {
    let query = `
      SELECT id, event_type, session_id, timestamp, content
      FROM events
      WHERE event_type IN (${TASK_EVENT_TYPES.map(() => '?').join(', ')})
    `;
    const params: unknown[] = [...TASK_EVENT_TYPES];

    if (offset.lastTimestamp && offset.lastEventId) {
      query += ` AND (timestamp > ? OR (timestamp = ? AND id > ?))`;
      params.push(
        offset.lastTimestamp.toISOString(),
        offset.lastTimestamp.toISOString(),
        offset.lastEventId
      );
    }

    query += ` ORDER BY timestamp ASC, id ASC LIMIT ?`;
    params.push(limit);

    const rows = await this.db.all<Array<Record<string, unknown>>>(query, params);

    return rows.map(row => ({
      id: row.id as string,
      eventType: row.event_type as string,
      sessionId: row.session_id as string,
      timestamp: new Date(row.timestamp as string),
      content: typeof row.content === 'string'
        ? JSON.parse(row.content)
        : row.content as Record<string, unknown>
    }));
  }

  /**
   * Process a batch of events
   */
  async processBatch(batchSize: number = 100): Promise<number> {
    const offset = await this.getOffset();
    const events = await this.fetchEventsSince(offset, batchSize);

    if (events.length === 0) {
      return 0;
    }

    for (const event of events) {
      await this.processEvent(event);
      await this.updateOffset(event.id, event.timestamp);
    }

    return events.length;
  }

  /**
   * Process all pending events
   */
  async processAll(): Promise<number> {
    let totalProcessed = 0;
    let processed: number;

    do {
      processed = await this.processBatch();
      totalProcessed += processed;
    } while (processed > 0);

    return totalProcessed;
  }

  /**
   * Process a single event
   */
  private async processEvent(event: TaskEvent): Promise<void> {
    switch (event.eventType) {
      case 'task_created':
        // Entity already created by TaskResolver, just ensure vector outbox entry
        await this.enqueueForVectorization(event.content.taskId as string, 'task_title');
        break;

      case 'task_status_changed':
        await this.handleStatusChanged(event);
        break;

      case 'task_priority_changed':
        // Priority change doesn't affect edges
        break;

      case 'task_blockers_set':
        await this.handleBlockersSet(event);
        break;

      case 'condition_resolved_to':
        await this.handleConditionResolved(event);
        break;

      case 'task_transition_rejected':
        // Log event, no state change
        break;
    }
  }

  /**
   * Handle task_status_changed event
   */
  private async handleStatusChanged(event: TaskEvent): Promise<void> {
    const { taskId, toStatus } = event.content;

    // If status changed to 'done', remove all blocked_by edges
    if (toStatus === 'done') {
      await this.db.run(
        `DELETE FROM edges
         WHERE src_id = ? AND rel_type IN ('blocked_by', 'blocked_by_suggested')`,
        [taskId]
      );

      // Clear blockers cache in entity
      await this.db.run(
        `UPDATE entities
         SET current_json = json_remove(json_remove(current_json, '$.blockers'), '$.blockerSuggestions'),
             updated_at = CURRENT_TIMESTAMP
         WHERE entity_id = ?`,
        [taskId]
      );
    }
  }

  /**
   * Handle task_blockers_set event
   */
  private async handleBlockersSet(event: TaskEvent): Promise<void> {
    const { taskId, mode, blockers } = event.content as {
      taskId: string;
      mode: BlockerMode;
      blockers: BlockerRef[];
    };

    if (mode === 'replace') {
      // Delete existing blocked_by edges
      await this.db.run(
        `DELETE FROM edges WHERE src_id = ? AND rel_type = 'blocked_by'`,
        [taskId]
      );

      // Create new edges
      for (const blocker of blockers) {
        await this.createBlockerEdge(taskId, blocker, 'blocked_by');
      }

      // Update entity cache
      const blockerIds = blockers.map(b => b.entityId);
      await this.db.run(
        `UPDATE entities
         SET current_json = json_set(current_json, '$.blockers', ?),
             updated_at = CURRENT_TIMESTAMP
         WHERE entity_id = ?`,
        [JSON.stringify(blockerIds), taskId]
      );

    } else {
      // mode === 'suggest'
      // Delete existing suggested edges
      await this.db.run(
        `DELETE FROM edges WHERE src_id = ? AND rel_type = 'blocked_by_suggested'`,
        [taskId]
      );

      // Create suggested edges
      for (const blocker of blockers) {
        await this.createBlockerEdge(taskId, blocker, 'blocked_by_suggested');
      }

      // Update entity cache (suggestions)
      const suggestionIds = blockers.map(b => b.entityId);
      await this.db.run(
        `UPDATE entities
         SET current_json = json_set(current_json, '$.blockerSuggestions', ?),
             updated_at = CURRENT_TIMESTAMP
         WHERE entity_id = ?`,
        [JSON.stringify(suggestionIds), taskId]
      );
    }
  }

  /**
   * Create blocker edge
   */
  private async createBlockerEdge(
    taskId: string,
    blocker: BlockerRef,
    relType: 'blocked_by' | 'blocked_by_suggested'
  ): Promise<void> {
    const edgeId = randomUUID();

    await this.db.run(
      `INSERT INTO edges (edge_id, src_type, src_id, rel_type, dst_type, dst_id, meta_json, created_at)
       VALUES (?, 'entity', ?, ?, 'entity', ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT DO NOTHING`,
      [
        edgeId,
        taskId,
        relType,
        blocker.entityId,
        JSON.stringify({
          kind: blocker.kind,
          rawText: blocker.rawText,
          confidence: blocker.confidence,
          candidates: blocker.candidates
        })
      ]
    );
  }

  /**
   * Handle condition_resolved_to event
   */
  private async handleConditionResolved(event: TaskEvent): Promise<void> {
    const { conditionId, resolvedTo } = event.content as {
      conditionId: string;
      resolvedTo: { kind: string; entityId: string };
    };

    // Update condition entity
    await this.db.run(
      `UPDATE entities
       SET current_json = json_set(json_set(current_json, '$.resolved', true), '$.resolvedTo', ?),
           updated_at = CURRENT_TIMESTAMP
       WHERE entity_id = ?`,
      [JSON.stringify(resolvedTo), conditionId]
    );

    // Edge already created by TaskResolver
  }

  /**
   * Enqueue entity for vectorization
   */
  private async enqueueForVectorization(itemId: string, itemKind: string): Promise<void> {
    const jobId = randomUUID();
    const embeddingVersion = 'v1';  // Should come from config

    await this.db.run(
      `INSERT INTO vector_outbox (job_id, item_kind, item_id, embedding_version, status, retry_count)
       VALUES (?, ?, ?, ?, 'pending', 0)
       ON CONFLICT (item_kind, item_id, embedding_version) DO NOTHING`,
      [jobId, itemKind, itemId, embeddingVersion]
    );
  }

  /**
   * Rebuild all projections from scratch
   * WARNING: This clears all edges and rebuilds from events
   */
  async rebuild(): Promise<number> {
    // Clear task-related edges
    await this.db.run(
      `DELETE FROM edges WHERE rel_type IN ('blocked_by', 'blocked_by_suggested', 'resolves_to')`
    );

    // Reset offset
    await this.db.run(
      `DELETE FROM projection_offsets WHERE projection_name = ?`,
      [PROJECTOR_NAME]
    );

    // Process all events
    return this.processAll();
  }
}
