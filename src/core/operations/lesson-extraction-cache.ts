/**
 * Cache for LLM-extracted lesson text.
 *
 * Two things make this non-optional rather than an optimization:
 *
 * 1. Promotion re-derives. `LessonService.resolveGeneratedCandidate` calls
 *    `findCandidates` a second time and looks the candidate up by id, so a
 *    non-deterministic extractor would let a reviewer approve one text and
 *    promote a different one. Serving both calls from the cache keeps the text
 *    a reviewer saw identical to the text that gets stored.
 * 2. Cost. Extraction spawns a CLI per candidate group; listing candidates is a
 *    read-shaped operation that callers repeat freely.
 *
 * Negative verdicts are cached too: when the model explicitly answers that a
 * group holds no reusable procedure, re-asking on every listing would re-pay
 * the full subprocess cost forever for the same answer. Only thrown provider
 * errors (transient outages) stay uncached.
 *
 * Entries are keyed by candidate id and validated against a fingerprint of the
 * source material, so new sessions joining a group re-extract instead of
 * serving stale guidance.
 */

import { createHash } from 'crypto';

import { sqliteExec, sqliteGet, sqliteRun, type SQLiteDatabase } from '../sqlite-wrapper.js';
import type { ExtractedLesson } from './lesson-candidate-service.js';

interface CacheRow {
  extraction_json: string;
  fingerprint: string;
}

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS lesson_extraction_cache (
    candidate_id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    extraction_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;

/**
 * Fingerprints the material the extraction was derived from. Any change to the
 * contributing sessions, events, or transcript invalidates the entry.
 */
export function lessonExtractionFingerprint(input: {
  sourceSessionIds: string[];
  sourceEventIds: string[];
  transcript: string;
}): string {
  return createHash('sha256')
    .update(input.sourceSessionIds.join(','))
    .update('\n')
    .update(input.sourceEventIds.join(','))
    .update('\n')
    .update(input.transcript)
    .digest('hex')
    .slice(0, 32);
}

function isExtractedLesson(value: unknown): value is ExtractedLesson {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === 'string'
    && typeof record.trigger === 'string'
    && Array.isArray(record.steps)
    && record.steps.every((step) => typeof step === 'string')
    && Array.isArray(record.failureModes)
    && record.failureModes.every((mode) => typeof mode === 'string');
}

/** A hit whose extraction is null is the cached "no reusable procedure" verdict. */
export interface CachedExtraction {
  extraction: ExtractedLesson | null;
}

export class LessonExtractionCache {
  private ensured = false;

  constructor(private readonly db: SQLiteDatabase) {}

  private ensureTable(): void {
    if (this.ensured) return;
    sqliteExec(this.db, CREATE_TABLE_SQL);
    this.ensured = true;
  }

  /**
   * Returns the cached entry only when it matches the current source material;
   * null means a cache miss (never stored, or the group's sessions changed).
   */
  read(candidateId: string, fingerprint: string): CachedExtraction | null {
    this.ensureTable();
    const row = sqliteGet<CacheRow>(
      this.db,
      'SELECT extraction_json, fingerprint FROM lesson_extraction_cache WHERE candidate_id = ?',
      [candidateId]
    );
    if (!row || row.fingerprint !== fingerprint) return null;

    try {
      const parsed = JSON.parse(row.extraction_json);
      if (parsed === null) return { extraction: null };
      return isExtractedLesson(parsed) ? { extraction: parsed } : null;
    } catch {
      return null;
    }
  }

  write(input: {
    candidateId: string;
    fingerprint: string;
    extraction: ExtractedLesson | null;
  }): void {
    this.ensureTable();
    sqliteRun(
      this.db,
      `INSERT INTO lesson_extraction_cache
         (candidate_id, fingerprint, extraction_json, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(candidate_id) DO UPDATE SET
         fingerprint = excluded.fingerprint,
         extraction_json = excluded.extraction_json,
         created_at = excluded.created_at`,
      [
        input.candidateId,
        input.fingerprint,
        JSON.stringify(input.extraction),
        new Date().toISOString()
      ]
    );
  }
}
