/**
 * Task Resolver - Process extracted task entries and emit task events
 * AXIOMMIND: Task state via event fold, no direct updates
 */

import { dbRun, dbAll, type Database } from '../db-wrapper.js';
import { randomUUID } from 'crypto';
import type {
  Entity,
  TaskStatus,
  TaskPriority,
  BlockerRef,
  BlockerMode
} from '../types.js';
import { makeEntityCanonicalKey, makeTaskEventDedupeKey } from '../canonical-key.js';
import { TaskMatcher } from './task-matcher.js';
import { BlockerResolver } from './blocker-resolver.js';

export interface ExtractedTask {
  title: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  blockedBy?: string[];
  description?: string;
  project?: string;
}

export interface TaskResolverConfig {
  sessionId: string;
  project?: string;
  evidenceAligned?: boolean;
}

// Valid status transitions
const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ['in_progress', 'cancelled'],
  in_progress: ['blocked', 'done', 'cancelled'],
  blocked: ['in_progress', 'done', 'cancelled'],
  done: [],  // Terminal state
  cancelled: []  // Terminal state
};

export class TaskResolver {
  private taskMatcher: TaskMatcher;
  private blockerResolver: BlockerResolver;

  constructor(
    private db: Database,
    private config: TaskResolverConfig
  ) {
    this.taskMatcher = new TaskMatcher(db);
    this.blockerResolver = new BlockerResolver(db, { project: config.project });
  }

  /**
   * Process extracted task entry
   * 1. Find or create task entity
   * 2. Emit status/priority change events if needed
   * 3. Process blockers
   */
  async processTask(extracted: ExtractedTask, sourceEntryId?: string): Promise<{
    taskId: string;
    isNew: boolean;
    events: string[];
  }> {
    const events: string[] = [];

    // Step 1: Find existing task or create new
    const { task, isNew, eventId: createEventId } = await this.findOrCreateTask(extracted);

    if (isNew && createEventId) {
      events.push(createEventId);
    }

    // Step 2: Handle status changes
    if (extracted.status) {
      const statusEvent = await this.handleStatusChange(task, extracted.status);
      if (statusEvent) {
        events.push(statusEvent);
      }
    }

    // Step 3: Handle priority changes
    if (extracted.priority) {
      const priorityEvent = await this.handlePriorityChange(task, extracted.priority);
      if (priorityEvent) {
        events.push(priorityEvent);
      }
    }

    // Step 4: Handle blockers
    if (extracted.blockedBy && extracted.blockedBy.length > 0) {
      const blockerEvent = await this.handleBlockers(
        task,
        extracted.blockedBy,
        sourceEntryId
      );
      if (blockerEvent) {
        events.push(blockerEvent);
      }
    } else if (extracted.status === 'blocked') {
      // Status is blocked but no blockers provided
      // Create unknown placeholder
      const blockerEvent = await this.handleUnknownBlocker(task);
      if (blockerEvent) {
        events.push(blockerEvent);
      }
    }

    return {
      taskId: task.entityId,
      isNew,
      events
    };
  }

  /**
   * Find existing task or create new one
   */
  private async findOrCreateTask(extracted: ExtractedTask): Promise<{
    task: Entity;
    isNew: boolean;
    eventId?: string;
  }> {
    // Try to find existing task
    const matchResult = await this.taskMatcher.match(extracted.title, extracted.project);

    if (matchResult.confidence === 'high' && matchResult.match) {
      return {
        task: matchResult.match,
        isNew: false
      };
    }

    // Create new task
    const taskId = randomUUID();
    const canonicalKey = makeEntityCanonicalKey('task', extracted.title, {
      project: extracted.project
    });

    // Correct initial status: never start as 'done'
    let initialStatus = extracted.status ?? 'pending';
    if (initialStatus === 'done') {
      initialStatus = 'in_progress';  // Correct: can't start as done
    }

    const now = new Date();

    const currentJson = {
      status: initialStatus,
      priority: extracted.priority ?? 'medium',
      description: extracted.description,
      project: extracted.project ?? this.config.project
    };

    // Insert entity
    await dbRun(
      this.db,
      `INSERT INTO entities (
        entity_id, entity_type, canonical_key, title, stage, status,
        current_json, title_norm, search_text, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        'task',
        canonicalKey,
        extracted.title,
        'raw',
        'active',
        JSON.stringify(currentJson),
        extracted.title.toLowerCase().trim(),
        `${extracted.title} ${extracted.description ?? ''}`,
        now.toISOString(),
        now.toISOString()
      ]
    );

    // Create alias
    await dbRun(
      this.db,
      `INSERT INTO entity_aliases (entity_type, canonical_key, entity_id, is_primary)
       VALUES (?, ?, ?, TRUE)
       ON CONFLICT (entity_type, canonical_key) DO NOTHING`,
      ['task', canonicalKey, taskId]
    );

    // Emit task_created event
    const eventId = await this.emitTaskEvent('task_created', {
      taskId,
      title: extracted.title,
      canonicalKey,
      initialStatus,
      priority: extracted.priority ?? 'medium',
      description: extracted.description,
      project: extracted.project ?? this.config.project
    });

    // Return created entity
    const task: Entity = {
      entityId: taskId,
      entityType: 'task',
      canonicalKey,
      title: extracted.title,
      stage: 'raw',
      status: 'active',
      currentJson,
      titleNorm: extracted.title.toLowerCase().trim(),
      searchText: `${extracted.title} ${extracted.description ?? ''}`,
      createdAt: now,
      updatedAt: now
    };

    return { task, isNew: true, eventId };
  }

  /**
   * Handle task status change
   */
  private async handleStatusChange(
    task: Entity,
    newStatus: TaskStatus
  ): Promise<string | null> {
    const currentJson = task.currentJson as { status: TaskStatus };
    const currentStatus = currentJson.status;

    if (currentStatus === newStatus) {
      return null;  // No change
    }

    // Validate transition
    const validNextStates = VALID_TRANSITIONS[currentStatus] ?? [];
    if (!validNextStates.includes(newStatus)) {
      // Invalid transition - emit rejection event
      return this.emitTaskEvent('task_transition_rejected', {
        taskId: task.entityId,
        fromStatus: currentStatus,
        toStatus: newStatus,
        reason: `Invalid transition from ${currentStatus} to ${newStatus}`
      });
    }

    // Emit status change event
    const eventId = await this.emitTaskEvent('task_status_changed', {
      taskId: task.entityId,
      fromStatus: currentStatus,
      toStatus: newStatus
    });

    // Update entity (projector will do this, but we update for immediate consistency)
    await dbRun(
      this.db,
      `UPDATE entities
       SET current_json = json_set(current_json, '$.status', ?),
           updated_at = ?
       WHERE entity_id = ?`,
      [newStatus, new Date().toISOString(), task.entityId]
    );

    return eventId;
  }

  /**
   * Handle task priority change
   */
  private async handlePriorityChange(
    task: Entity,
    newPriority: TaskPriority
  ): Promise<string | null> {
    const currentJson = task.currentJson as { priority?: TaskPriority };
    const currentPriority = currentJson.priority ?? 'medium';

    if (currentPriority === newPriority) {
      return null;  // No change
    }

    // Emit priority change event
    const eventId = await this.emitTaskEvent('task_priority_changed', {
      taskId: task.entityId,
      fromPriority: currentPriority,
      toPriority: newPriority
    });

    // Update entity
    await dbRun(
      this.db,
      `UPDATE entities
       SET current_json = json_set(current_json, '$.priority', ?),
           updated_at = ?
       WHERE entity_id = ?`,
      [newPriority, new Date().toISOString(), task.entityId]
    );

    return eventId;
  }

  /**
   * Handle blockers
   */
  private async handleBlockers(
    task: Entity,
    blockedByTexts: string[],
    sourceEntryId?: string
  ): Promise<string | null> {
    // Resolve blocker texts to entity refs
    const blockerRefs = await this.blockerResolver.resolveBlockers(blockedByTexts);

    // Determine mode based on evidence alignment
    const mode: BlockerMode = this.config.evidenceAligned ? 'replace' : 'suggest';

    // Emit task_blockers_set event
    const eventId = await this.emitTaskEvent('task_blockers_set', {
      taskId: task.entityId,
      mode,
      blockers: blockerRefs,
      sourceEntryId
    });

    return eventId;
  }

  /**
   * Handle unknown blocker (status=blocked but no blockedBy)
   */
  private async handleUnknownBlocker(task: Entity): Promise<string | null> {
    const placeholderRef = await this.blockerResolver.createUnknownPlaceholder(task.title);

    const eventId = await this.emitTaskEvent('task_blockers_set', {
      taskId: task.entityId,
      mode: 'suggest' as BlockerMode,
      blockers: [placeholderRef]
    });

    return eventId;
  }

  /**
   * Emit task event to events table
   */
  private async emitTaskEvent(
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<string> {
    const eventId = randomUUID();
    const now = new Date();

    // Generate dedupe key
    const dedupeKey = makeTaskEventDedupeKey(
      eventType,
      payload.taskId as string,
      this.config.sessionId,
      JSON.stringify(payload)
    );

    // Check for duplicate
    const existing = await dbAll<{ event_id: string }>(
      this.db,
      `SELECT event_id FROM event_dedup WHERE dedupe_key = ?`,
      [dedupeKey]
    );

    if (existing.length > 0) {
      return existing[0].event_id;  // Return existing event ID
    }

    // Insert event
    await dbRun(
      this.db,
      `INSERT INTO events (
        id, event_type, session_id, timestamp, content,
        canonical_key, dedupe_key, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventId,
        eventType,
        this.config.sessionId,
        now.toISOString(),
        JSON.stringify(payload),
        `task_event:${eventType}:${payload.taskId}`,
        dedupeKey,
        JSON.stringify({ source: 'task_resolver' })
      ]
    );

    // Insert dedup record
    await dbRun(
      this.db,
      `INSERT INTO event_dedup (dedupe_key, event_id)
       VALUES (?, ?)
       ON CONFLICT DO NOTHING`,
      [dedupeKey, eventId]
    );

    return eventId;
  }

  /**
   * Resolve condition to task (when condition is identified as existing task)
   */
  async resolveConditionToTask(
    conditionId: string,
    taskId: string
  ): Promise<string> {
    const eventId = await this.emitTaskEvent('condition_resolved_to', {
      conditionId,
      resolvedTo: {
        kind: 'task',
        entityId: taskId
      }
    });

    // Create resolves_to edge
    await dbRun(
      this.db,
      `INSERT INTO edges (edge_id, src_type, src_id, rel_type, dst_type, dst_id, meta_json)
       VALUES (?, 'entity', ?, 'resolves_to', 'entity', ?, ?)
       ON CONFLICT DO NOTHING`,
      [randomUUID(), conditionId, taskId, JSON.stringify({ resolved_at: new Date().toISOString() })]
    );

    return eventId;
  }
}
