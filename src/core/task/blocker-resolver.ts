/**
 * Blocker Resolver - Resolve blocker texts to entity references
 * AXIOMMIND: No stub task creation, fallback to condition
 */

import { dbRun, dbAll, type Database } from '../db-wrapper.js';
import { randomUUID } from 'crypto';
import type { BlockerRef, BlockerKind, Entity } from '../types.js';
import { makeEntityCanonicalKey, makeArtifactKey } from '../canonical-key.js';
import { TaskMatcher } from './task-matcher.js';

export interface BlockerResolverConfig {
  project?: string;
}

// Patterns for artifact detection
const URL_PATTERN = /^https?:\/\/.+/;
const JIRA_PATTERN = /^[A-Z]+-\d+$/;
const GITHUB_ISSUE_PATTERN = /^[^\/]+\/[^#]+#\d+$/;
const TASK_ID_PATTERN = /^task:[^:]+:[^:]+$/;

export class BlockerResolver {
  private taskMatcher: TaskMatcher;

  constructor(
    private db: Database,
    private config: BlockerResolverConfig = {}
  ) {
    this.taskMatcher = new TaskMatcher(db);
  }

  /**
   * Resolve a single blocker text to entity reference
   * Rules:
   * 1. Strong ID/URL/key pattern → artifact
   * 2. Explicit task_id → task
   * 3. Task title match (strict only) → task
   * 4. Fallback → condition (no stub task creation)
   */
  async resolveBlocker(
    text: string,
    sourceEntryId?: string
  ): Promise<BlockerRef> {
    const trimmedText = text.trim();

    // Rule 1: Check for artifact patterns
    const artifactRef = await this.tryResolveAsArtifact(trimmedText);
    if (artifactRef) {
      return artifactRef;
    }

    // Rule 2: Check for explicit task_id pattern
    if (TASK_ID_PATTERN.test(trimmedText)) {
      const taskRef = await this.tryResolveAsTaskId(trimmedText);
      if (taskRef) {
        return taskRef;
      }
      // Task ID not found, fall through to condition
    }

    // Rule 3: Try task title matching (strict only)
    const taskMatch = await this.taskMatcher.match(trimmedText, this.config.project);

    if (taskMatch.confidence === 'high' && taskMatch.match) {
      // Strict match found
      return {
        kind: 'task',
        entityId: taskMatch.match.entityId,
        rawText: trimmedText,
        confidence: taskMatch.score
      };
    }

    // Rule 4: Fallback to condition (get-or-create)
    // Also store candidates if any
    const conditionRef = await this.createConditionBlocker(
      trimmedText,
      taskMatch.candidates
    );

    return conditionRef;
  }

  /**
   * Resolve multiple blocker texts
   */
  async resolveBlockers(
    texts: string[],
    sourceEntryId?: string
  ): Promise<BlockerRef[]> {
    const results: BlockerRef[] = [];

    for (const text of texts) {
      const ref = await this.resolveBlocker(text, sourceEntryId);
      results.push(ref);
    }

    return results;
  }

  /**
   * Try to resolve as artifact (URL, JIRA, GitHub)
   */
  private async tryResolveAsArtifact(text: string): Promise<BlockerRef | null> {
    // Check patterns
    if (!URL_PATTERN.test(text) && !JIRA_PATTERN.test(text) && !GITHUB_ISSUE_PATTERN.test(text)) {
      return null;
    }

    const canonicalKey = makeArtifactKey(text);

    // Find or create artifact
    const existing = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT entity_id FROM entities
       WHERE entity_type = 'artifact' AND canonical_key = ?`,
      [canonicalKey]
    );

    let entityId: string;

    if (existing.length > 0) {
      entityId = existing[0].entity_id as string;
    } else {
      // Create artifact entity via event
      entityId = await this.declareArtifact(text, canonicalKey);
    }

    return {
      kind: 'artifact',
      entityId,
      rawText: text,
      confidence: 1.0
    };
  }

  /**
   * Try to resolve as explicit task ID
   */
  private async tryResolveAsTaskId(taskId: string): Promise<BlockerRef | null> {
    // taskId format: task:project:identifier
    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT entity_id FROM entities
       WHERE entity_type = 'task' AND canonical_key = ?
       AND status = 'active'`,
      [taskId]
    );

    if (rows.length === 0) {
      return null;
    }

    return {
      kind: 'task',
      entityId: rows[0].entity_id as string,
      rawText: taskId,
      confidence: 1.0
    };
  }

  /**
   * Create condition blocker (get-or-create)
   */
  private async createConditionBlocker(
    text: string,
    candidates?: Entity[]
  ): Promise<BlockerRef> {
    const canonicalKey = makeEntityCanonicalKey('condition', text, {
      project: this.config.project
    });

    // Find existing condition
    const existing = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT entity_id FROM entities
       WHERE entity_type = 'condition' AND canonical_key = ?`,
      [canonicalKey]
    );

    let entityId: string;

    if (existing.length > 0) {
      entityId = existing[0].entity_id as string;
    } else {
      // Create condition entity via event
      entityId = await this.declareCondition(text, canonicalKey, candidates);
    }

    return {
      kind: 'condition',
      entityId,
      rawText: text,
      confidence: 0.5,
      candidates: candidates?.map(c => c.entityId)
    };
  }

  /**
   * Declare a new condition entity
   */
  private async declareCondition(
    text: string,
    canonicalKey: string,
    candidates?: Entity[]
  ): Promise<string> {
    const entityId = randomUUID();
    const now = new Date().toISOString();

    const currentJson = {
      text,
      resolved: false,
      candidates: candidates?.map(c => ({
        entityId: c.entityId,
        title: c.title
      }))
    };

    await dbRun(
      this.db,
      `INSERT INTO entities (
        entity_id, entity_type, canonical_key, title, stage, status,
        current_json, title_norm, search_text, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entityId,
        'condition',
        canonicalKey,
        text,
        'raw',
        'active',
        JSON.stringify(currentJson),
        text.toLowerCase().trim(),
        text,
        now,
        now
      ]
    );

    // Create alias
    await dbRun(
      this.db,
      `INSERT INTO entity_aliases (entity_type, canonical_key, entity_id, is_primary)
       VALUES (?, ?, ?, TRUE)
       ON CONFLICT (entity_type, canonical_key) DO NOTHING`,
      ['condition', canonicalKey, entityId]
    );

    return entityId;
  }

  /**
   * Declare a new artifact entity
   */
  private async declareArtifact(
    identifier: string,
    canonicalKey: string
  ): Promise<string> {
    const entityId = randomUUID();
    const now = new Date().toISOString();

    // Determine artifact type
    let artifactType = 'generic';
    if (URL_PATTERN.test(identifier)) {
      artifactType = 'url';
    } else if (JIRA_PATTERN.test(identifier)) {
      artifactType = 'jira';
    } else if (GITHUB_ISSUE_PATTERN.test(identifier)) {
      artifactType = 'github_issue';
    }

    const currentJson = {
      identifier,
      artifactType
    };

    await dbRun(
      this.db,
      `INSERT INTO entities (
        entity_id, entity_type, canonical_key, title, stage, status,
        current_json, title_norm, search_text, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entityId,
        'artifact',
        canonicalKey,
        identifier,
        'raw',
        'active',
        JSON.stringify(currentJson),
        identifier.toLowerCase(),
        identifier,
        now,
        now
      ]
    );

    // Create alias
    await dbRun(
      this.db,
      `INSERT INTO entity_aliases (entity_type, canonical_key, entity_id, is_primary)
       VALUES (?, ?, ?, TRUE)
       ON CONFLICT (entity_type, canonical_key) DO NOTHING`,
      ['artifact', canonicalKey, entityId]
    );

    return entityId;
  }

  /**
   * Create unknown placeholder condition
   * Used when task is blocked but no blocker text provided
   */
  async createUnknownPlaceholder(taskTitle: string): Promise<BlockerRef> {
    const text = `Unknown blocker for: ${taskTitle}`;

    const ref = await this.createConditionBlocker(text);

    // Mark as auto placeholder
    await dbRun(
      this.db,
      `UPDATE entities
       SET current_json = json_set(current_json, '$.auto_placeholder', true)
       WHERE entity_id = ?`,
      [ref.entityId]
    );

    return {
      ...ref,
      confidence: 0.0
    };
  }
}
