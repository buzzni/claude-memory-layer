/**
 * Task Matcher - Find existing tasks by title similarity
 * AXIOMMIND: strict matching (≥0.92, gap≥0.03)
 */

import { dbAll, toDate, type Database } from '../db-wrapper.js';
import type { Entity, MatchConfidence } from '../types.js';
import { makeEntityCanonicalKey } from '../canonical-key.js';
import { MATCH_THRESHOLDS } from '../types.js';

export interface TaskMatchResult {
  match: Entity | null;
  confidence: MatchConfidence;
  score: number;
  gap?: number;
  candidates?: Entity[];
}

export interface TaskMatcherConfig {
  minCombinedScore: number;
  minGap: number;
  suggestionThreshold: number;
  maxCandidates: number;
}

const DEFAULT_CONFIG: TaskMatcherConfig = {
  minCombinedScore: MATCH_THRESHOLDS.minCombinedScore,
  minGap: MATCH_THRESHOLDS.minGap,
  suggestionThreshold: MATCH_THRESHOLDS.suggestionThreshold,
  maxCandidates: 5
};

export class TaskMatcher {
  private readonly config: TaskMatcherConfig;

  constructor(
    private db: Database,
    config?: Partial<TaskMatcherConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Find task by exact canonical key match
   */
  async findExact(title: string, project?: string): Promise<Entity | null> {
    const canonicalKey = makeEntityCanonicalKey('task', title, { project });

    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT * FROM entities
       WHERE entity_type = 'task' AND canonical_key = ?
       AND status = 'active'`,
      [canonicalKey]
    );

    if (rows.length === 0) return null;
    return this.rowToEntity(rows[0]);
  }

  /**
   * Find task by alias
   */
  async findByAlias(title: string, project?: string): Promise<Entity | null> {
    const canonicalKey = makeEntityCanonicalKey('task', title, { project });

    const rows = await dbAll<Record<string, unknown>>(
      this.db,
      `SELECT e.* FROM entities e
       JOIN entity_aliases a ON e.entity_id = a.entity_id
       WHERE a.entity_type = 'task' AND a.canonical_key = ?
       AND e.status = 'active'`,
      [canonicalKey]
    );

    if (rows.length === 0) return null;
    return this.rowToEntity(rows[0]);
  }

  /**
   * Search tasks by text (FTS-like)
   */
  async searchByText(query: string, project?: string): Promise<Array<{ entity: Entity; score: number }>> {
    const searchPattern = `%${query.toLowerCase()}%`;

    let sql = `
      SELECT *,
        CASE
          WHEN title_norm = ? THEN 1.0
          WHEN title_norm LIKE ? THEN 0.9
          ELSE 0.7
        END as match_score
      FROM entities
      WHERE entity_type = 'task'
        AND status = 'active'
        AND (title_norm LIKE ? OR search_text LIKE ?)
    `;

    const normalizedQuery = query.toLowerCase().trim();
    const params: unknown[] = [normalizedQuery, `%${normalizedQuery}%`, searchPattern, searchPattern];

    if (project) {
      sql += ` AND json_extract(current_json, '$.project') = ?`;
      params.push(project);
    }

    sql += ` ORDER BY match_score DESC, updated_at DESC LIMIT ?`;
    params.push(this.config.maxCandidates);

    const rows = await dbAll<Record<string, unknown>>(this.db, sql, params);

    return rows.map(row => ({
      entity: this.rowToEntity(row),
      score: row.match_score as number
    }));
  }

  /**
   * Match task with confidence classification
   * Returns high confidence only if score ≥ 0.92 AND gap ≥ 0.03
   */
  async match(title: string, project?: string): Promise<TaskMatchResult> {
    // Step 1: Try exact match
    const exactMatch = await this.findExact(title, project);
    if (exactMatch) {
      return {
        match: exactMatch,
        confidence: 'high',
        score: 1.0
      };
    }

    // Step 2: Try alias match
    const aliasMatch = await this.findByAlias(title, project);
    if (aliasMatch) {
      return {
        match: aliasMatch,
        confidence: 'high',
        score: 0.98
      };
    }

    // Step 3: Try text search
    const searchResults = await this.searchByText(title, project);
    if (searchResults.length === 0) {
      return {
        match: null,
        confidence: 'none',
        score: 0
      };
    }

    const topResult = searchResults[0];
    const secondScore = searchResults.length > 1 ? searchResults[1].score : null;

    // Calculate gap
    const gap = secondScore !== null ? topResult.score - secondScore : Infinity;

    // Classify confidence
    const confidence = this.classifyConfidence(topResult.score, gap);

    // For strict matching, only return high confidence if criteria met
    if (confidence === 'high') {
      return {
        match: topResult.entity,
        confidence: 'high',
        score: topResult.score,
        gap
      };
    }

    // For suggested, return candidates
    if (confidence === 'suggested') {
      return {
        match: null,
        confidence: 'suggested',
        score: topResult.score,
        gap,
        candidates: searchResults.slice(0, this.config.maxCandidates).map(r => r.entity)
      };
    }

    return {
      match: null,
      confidence: 'none',
      score: topResult.score
    };
  }

  /**
   * Classify confidence based on AXIOMMIND thresholds
   */
  private classifyConfidence(score: number, gap: number): MatchConfidence {
    const { minCombinedScore, minGap, suggestionThreshold } = this.config;

    // High confidence: score ≥ 0.92 AND gap ≥ 0.03
    if (score >= minCombinedScore && gap >= minGap) {
      return 'high';
    }

    // Suggested: score ≥ 0.75
    if (score >= suggestionThreshold) {
      return 'suggested';
    }

    return 'none';
  }

  /**
   * Get suggestion candidates (for condition fallback)
   */
  async getSuggestionCandidates(title: string, project?: string): Promise<Entity[]> {
    const searchResults = await this.searchByText(title, project);
    return searchResults
      .filter(r => r.score >= this.config.suggestionThreshold)
      .slice(0, this.config.maxCandidates)
      .map(r => r.entity);
  }

  /**
   * Convert database row to Entity
   */
  private rowToEntity(row: Record<string, unknown>): Entity {
    return {
      entityId: row.entity_id as string,
      entityType: row.entity_type as 'task' | 'condition' | 'artifact',
      canonicalKey: row.canonical_key as string,
      title: row.title as string,
      stage: row.stage as 'raw' | 'working' | 'candidate' | 'verified' | 'certified',
      status: row.status as 'active' | 'contested' | 'deprecated' | 'superseded',
      currentJson: typeof row.current_json === 'string'
        ? JSON.parse(row.current_json)
        : row.current_json as Record<string, unknown>,
      titleNorm: row.title_norm as string | undefined,
      searchText: row.search_text as string | undefined,
      createdAt: toDate(row.created_at),
      updatedAt: toDate(row.updated_at)
    };
  }
}
