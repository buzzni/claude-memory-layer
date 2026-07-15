import { randomUUID } from 'crypto';
import { z } from 'zod';

import {
  sqliteAll,
  sqliteGet,
  sqliteRun,
  toDateFromSQLite,
  type SQLiteDatabase
} from '../sqlite-wrapper.js';
import {
  ListMemoryLessonsInputSchema,
  MemoryLessonSchema,
  UpsertMemoryLessonInputSchema,
  type MemoryLesson
} from '../types.js';
import { sanitizeGovernanceAuditValue, writeGovernanceAuditEntry } from './governance-audit.js';

interface MemoryLessonRow {
  lesson_id: string;
  project_hash: string;
  name: string;
  trigger: string;
  steps_json: string;
  confidence: number;
  source_session_ids: string;
  source_event_ids: string;
  failure_modes_json: string;
  skill_candidate: number;
  source_class?: string;
  created_at: string;
  updated_at: string;
}

type ParsedLessonUpsert = z.output<typeof UpsertMemoryLessonInputSchema>;

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [];
  } catch {
    return [];
  }
}

function projectHashToStorage(projectHash: string | undefined): string {
  return projectHash ?? '';
}

function projectHashFromStorage(projectHash: string): string | undefined {
  return projectHash.length > 0 ? projectHash : undefined;
}

function sanitizeString(value: string): string {
  return String(sanitizeGovernanceAuditValue(value));
}

function sanitizeStringArray(values: string[]): string[] {
  return values.map(sanitizeString).filter((value) => value.length > 0);
}

function sanitizeParsedLesson(input: ParsedLessonUpsert): ParsedLessonUpsert {
  return {
    ...input,
    projectHash: input.projectHash ? sanitizeString(input.projectHash) : undefined,
    name: sanitizeString(input.name),
    trigger: sanitizeString(input.trigger),
    steps: sanitizeStringArray(input.steps),
    sourceSessionIds: sanitizeStringArray(input.sourceSessionIds),
    sourceEventIds: sanitizeStringArray(input.sourceEventIds),
    failureModes: sanitizeStringArray(input.failureModes),
    sourceClass: input.sourceClass,
    actor: input.actor ? sanitizeString(input.actor) : undefined
  };
}

function rowToLesson(row: MemoryLessonRow): MemoryLesson {
  return MemoryLessonSchema.parse({
    lessonId: row.lesson_id,
    projectHash: projectHashFromStorage(row.project_hash),
    name: row.name,
    trigger: row.trigger,
    steps: parseStringArray(row.steps_json),
    confidence: Number(row.confidence),
    sourceSessionIds: parseStringArray(row.source_session_ids),
    sourceEventIds: parseStringArray(row.source_event_ids),
    failureModes: parseStringArray(row.failure_modes_json),
    skillCandidate: Number(row.skill_candidate) === 1,
    sourceClass: row.source_class === 'curated' ? 'curated' : 'derived',
    createdAt: toDateFromSQLite(row.created_at),
    updatedAt: toDateFromSQLite(row.updated_at)
  });
}

function lessonToAuditJson(lesson: MemoryLesson): Record<string, unknown> {
  return {
    lessonId: lesson.lessonId,
    projectHash: lesson.projectHash,
    name: lesson.name,
    trigger: lesson.trigger,
    steps: lesson.steps,
    confidence: lesson.confidence,
    sourceSessionIds: lesson.sourceSessionIds,
    sourceEventIds: lesson.sourceEventIds,
    failureModes: lesson.failureModes,
    skillCandidate: lesson.skillCandidate,
    sourceClass: lesson.sourceClass,
    createdAt: lesson.createdAt.toISOString(),
    updatedAt: lesson.updatedAt.toISOString()
  };
}

export type LessonAuditOperation = 'lesson_promote' | 'lesson_capture';

export class LessonRepository {
  constructor(private readonly db: SQLiteDatabase) {}

  async upsert(input: unknown, auditOperation: LessonAuditOperation = 'lesson_promote'): Promise<MemoryLesson> {
    const parsed = sanitizeParsedLesson(UpsertMemoryLessonInputSchema.parse(input));
    const existingById = parsed.lessonId ? this.get(parsed.lessonId) : null;
    const existingByName = this.findByProjectAndName(parsed.projectHash, parsed.name);
    if (existingById && existingByName && existingById.lessonId !== existingByName.lessonId) {
      throw new Error('lesson name already exists for projectHash');
    }
    const existing = existingById ?? existingByName;
    const now = new Date().toISOString();

    if (existing) {
      if (projectHashToStorage(existing.projectHash) !== projectHashToStorage(parsed.projectHash)) {
        throw new Error('lesson projectHash mismatch');
      }
      sqliteRun(
        this.db,
        `UPDATE memory_lessons
         SET name = ?, trigger = ?, steps_json = ?, confidence = ?, source_session_ids = ?,
             source_event_ids = ?, failure_modes_json = ?, skill_candidate = ?, source_class = ?, updated_at = ?
         WHERE lesson_id = ? AND project_hash = ?`,
        [
          parsed.name,
          parsed.trigger,
          JSON.stringify(parsed.steps),
          parsed.confidence,
          JSON.stringify(parsed.sourceSessionIds),
          JSON.stringify(parsed.sourceEventIds),
          JSON.stringify(parsed.failureModes),
          parsed.skillCandidate ? 1 : 0,
          parsed.sourceClass,
          now,
          existing.lessonId,
          projectHashToStorage(existing.projectHash)
        ]
      );
      const saved = this.require(existing.lessonId);
      await this.auditLessonUpsert(parsed, existing, saved, auditOperation);
      return saved;
    }

    const lessonId = parsed.lessonId ?? randomUUID();
    sqliteRun(
      this.db,
      `INSERT INTO memory_lessons (
        lesson_id, project_hash, name, trigger, steps_json, confidence,
        source_session_ids, source_event_ids, failure_modes_json, skill_candidate,
        source_class, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        lessonId,
        projectHashToStorage(parsed.projectHash),
        parsed.name,
        parsed.trigger,
        JSON.stringify(parsed.steps),
        parsed.confidence,
        JSON.stringify(parsed.sourceSessionIds),
        JSON.stringify(parsed.sourceEventIds),
        JSON.stringify(parsed.failureModes),
        parsed.skillCandidate ? 1 : 0,
        parsed.sourceClass,
        now,
        now
      ]
    );

    const saved = this.require(lessonId);
    await this.auditLessonUpsert(parsed, null, saved, auditOperation);
    return saved;
  }

  get(lessonId: string): MemoryLesson | null {
    const row = sqliteGet<MemoryLessonRow>(this.db, `SELECT * FROM memory_lessons WHERE lesson_id = ?`, [lessonId]);
    return row ? rowToLesson(row) : null;
  }

  async list(input: unknown): Promise<MemoryLesson[]> {
    const parsed = ListMemoryLessonsInputSchema.parse(input);
    const clauses = ['project_hash = ?'];
    const params: unknown[] = [projectHashToStorage(parsed.projectHash)];
    if (parsed.skillCandidate !== undefined) {
      clauses.push('skill_candidate = ?');
      params.push(parsed.skillCandidate ? 1 : 0);
    }
    params.push(parsed.limit);
    const where = clauses.join(' AND ');
    const rows = sqliteAll<MemoryLessonRow>(
      this.db,
      `SELECT * FROM memory_lessons WHERE ${where} ORDER BY confidence DESC, updated_at DESC LIMIT ?`,
      params
    );
    return rows.map(rowToLesson);
  }

  private findByProjectAndName(projectHash: string | undefined, name: string): MemoryLesson | null {
    const row = sqliteGet<MemoryLessonRow>(
      this.db,
      `SELECT * FROM memory_lessons WHERE project_hash = ? AND name = ?`,
      [projectHashToStorage(projectHash), name]
    );
    return row ? rowToLesson(row) : null;
  }

  private require(lessonId: string): MemoryLesson {
    const lesson = this.get(lessonId);
    if (!lesson) throw new Error(`Memory lesson not found: ${lessonId}`);
    return lesson;
  }

  private async auditLessonUpsert(
    input: ParsedLessonUpsert,
    before: MemoryLesson | null,
    after: MemoryLesson,
    operation: LessonAuditOperation
  ): Promise<void> {
    await writeGovernanceAuditEntry(this.db, {
      operation,
      actor: input.actor ?? 'cml-core',
      projectHash: input.projectHash,
      targetType: 'lesson',
      targetId: after.lessonId,
      beforeJson: before ? lessonToAuditJson(before) : undefined,
      afterJson: lessonToAuditJson(after),
      sourceEventIds: input.sourceEventIds
    });
  }
}
