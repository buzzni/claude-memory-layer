/**
 * specs/host-lesson-matching-2026-10-18 P1 — consolidate many small lessons
 * into class-level runbooks, after a person approved the drafts.
 *
 * One transaction adds each runbook as a curated lesson and switches its
 * absorbed lessons off, pointing them at it (`absorbed_into`). Nothing is
 * deleted: the absorbed lessons keep their text and provenance, and a revert
 * switches them back on. Absorbed lessons are pinned by revision, so a lesson
 * edited after review is not absorbed by a stale draft.
 */
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { lessonToAuditJson, LessonRepository } from '../core/operations/lesson-repository.js';
import { writeGovernanceAuditEntrySync } from '../core/operations/governance-audit.js';
import { sqliteAll, sqliteRun, sqliteTransaction, type SQLiteDatabase } from '../core/sqlite-wrapper.js';
import type { MemoryLesson } from '../core/types.js';
import { assertCandidateSafe, CandidatePayload } from './lesson-host-service.js';

const Identifier = z.string().trim().min(1).max(240);
const RunbookDraft = z.object({
  /** The draft's own label, used in reports only; the stored id is new. */
  lessonId: Identifier,
  name: Identifier,
  trigger: Identifier,
  steps: z.array(Identifier).min(1).max(20),
  failureModes: z.array(Identifier).max(20).default([]),
  validation: z.array(Identifier).min(1).max(20),
  scope: Identifier,
  reconsiderWhen: Identifier,
  absorbs: z.array(z.object({ lessonId: Identifier, revision: z.number().int().positive() }).strict()).min(1)
}).strict();
const ConsolidationInput = z.object({ runbooks: z.array(RunbookDraft).min(1) }).strict();

/** Validates the drafts' shape before any store is opened. */
export function parseConsolidationDrafts(input: unknown): z.output<typeof ConsolidationInput> {
  return ConsolidationInput.parse(input);
}
type RunbookDraft = z.output<typeof RunbookDraft>;
// A runbook's provenance is its absorbed lessons, which may carry no event refs (CLI-curated ones).
const RunbookPayload = CandidatePayload.extend({ sourceEventIds: z.array(Identifier).max(100) });

export interface ConsolidationPlan {
  runbooks: Array<{ draftId: string; name: string; absorbs: Array<{ lessonId: string; name: string; revision: number }> }>;
  /** State that blocks applying; empty means the drafts can be applied as they are. */
  problems: string[];
}

const PROVENANCE_LIMIT = 100;

/** Read-only check of approved drafts against the store. Malformed or unsafe drafts throw. */
export function planRunbookConsolidation(db: SQLiteDatabase, projectHash: string, input: unknown): ConsolidationPlan {
  const { runbooks } = parseConsolidationDrafts(input);
  const repository = new LessonRepository(db);
  const runbookIds = new Set(listRunbookIds(db, projectHash));
  const problems: string[] = [];
  const absorbedOnce = new Set<string>();
  const draftNames = new Set<string>();
  const planned = runbooks.map((draft) => {
    const found: MemoryLesson[] = [];
    const absorbs = draft.absorbs.map(({ lessonId, revision }) => {
      const lesson = repository.get(lessonId);
      if (absorbedOnce.has(lessonId)) problems.push(`${draft.lessonId}: lesson ${lessonId} is absorbed more than once`);
      absorbedOnce.add(lessonId);
      if (!lesson || lesson.projectHash !== projectHash) {
        problems.push(`${draft.lessonId}: lesson ${lessonId} is not in this project`);
        return { lessonId, name: '', revision };
      }
      if (lesson.revision !== revision) problems.push(`${draft.lessonId}: lesson ${lessonId} is at revision ${lesson.revision}, not ${revision}`);
      if (!lesson.recallEnabled) problems.push(`${draft.lessonId}: lesson ${lessonId} is already switched off`);
      if (lesson.absorbedInto) problems.push(`${draft.lessonId}: lesson ${lessonId} is already absorbed into ${lesson.absorbedInto}`);
      if (runbookIds.has(lessonId)) problems.push(`${draft.lessonId}: lesson ${lessonId} is itself a runbook`);
      found.push(lesson);
      return { lessonId, name: lesson.name, revision: lesson.revision };
    });
    if (repository.getByProjectAndName(projectHash, draft.name)) problems.push(`${draft.lessonId}: name ${draft.name} is already a lesson`);
    if (draftNames.has(draft.name)) problems.push(`${draft.lessonId}: name ${draft.name} is used by another draft`);
    draftNames.add(draft.name);
    // The exact payload apply would store, provenance included, so a preview cannot pass what apply rejects.
    const payload = RunbookPayload.safeParse(runbookPayload(draft, found));
    if (payload.success) assertCandidateSafe(payload.data);
    else problems.push(`${draft.lessonId}: runbook payload is invalid: ${payload.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join(', ')}`);
    return { draftId: draft.lessonId, name: draft.name, absorbs };
  });
  return { runbooks: planned, problems };
}

/** Applies approved drafts all at once, or not at all. */
export function applyRunbookConsolidation(db: SQLiteDatabase, projectHash: string, input: unknown, actor: string): { runbooks: Array<{ draftId: string; lessonId: string; name: string; absorbed: number }> } {
  return sqliteTransaction(db, () => {
    const plan = planRunbookConsolidation(db, projectHash, input);
    if (plan.problems.length > 0) throw new Error(`runbook consolidation blocked: ${plan.problems.join('; ')}`);
    const { runbooks } = parseConsolidationDrafts(input);
    const repository = new LessonRepository(db);
    return {
      runbooks: runbooks.map((draft) => {
        const absorbed = draft.absorbs.map(({ lessonId }) => repository.get(lessonId)!);
        const payload = RunbookPayload.parse(runbookPayload(draft, absorbed));
        const lessonId = randomUUID();
        const now = new Date().toISOString();
        sqliteRun(db, `INSERT INTO memory_lessons (lesson_id, project_hash, name, trigger, steps_json, confidence, source_session_ids, source_event_ids, failure_modes_json, skill_candidate, source_class, revision, recall_enabled, scope, validation_json, reconsider_when, valid_versions_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'curated', 1, 1, ?, ?, ?, '[]', ?, ?)`,
        [lessonId, projectHash, payload.name, payload.trigger, JSON.stringify(payload.steps), payload.confidence, JSON.stringify(payload.sourceSessionIds), JSON.stringify(payload.sourceEventIds), JSON.stringify(payload.failureModes), payload.scope, JSON.stringify(payload.validation), payload.reconsiderWhen, now, now]);
        writeGovernanceAuditEntrySync(db, { operation: 'lesson_promote', actor, projectHash, targetType: 'lesson', targetId: lessonId, afterJson: { ...lessonToAuditJson(repository.get(lessonId)!), absorbs: absorbed.map((lesson) => lesson.lessonId) }, sourceEventIds: payload.sourceEventIds });
        for (const lesson of absorbed) {
          const changed = sqliteRun(db, `UPDATE memory_lessons SET recall_enabled = 0, absorbed_into = ?, revision = revision + 1, updated_at = ?
            WHERE lesson_id = ? AND project_hash = ? AND revision = ? AND recall_enabled = 1 AND absorbed_into IS NULL`,
          [lessonId, now, lesson.lessonId, projectHash, lesson.revision]);
          if (changed.changes !== 1) throw new Error(`lesson ${lesson.lessonId} changed during consolidation`);
          writeGovernanceAuditEntrySync(db, { operation: 'lesson_consolidate', actor, projectHash, targetType: 'lesson', targetId: lesson.lessonId, beforeJson: lessonToAuditJson(lesson), afterJson: lessonToAuditJson(repository.get(lesson.lessonId)!) });
        }
        return { draftId: draft.lessonId, lessonId, name: payload.name, absorbed: absorbed.length };
      })
    };
  });
}

/** What a revert would change: the runbook to switch off and the lessons to switch back on. Throws for a non-runbook. */
export function planRunbookRevert(db: SQLiteDatabase, projectHash: string, runbookId: string): { runbook: { lessonId: string; name: string; revision: number }; restore: Array<{ lessonId: string; name: string; revision: number }> } {
  const runbook = new LessonRepository(db).get(runbookId);
  const absorbed = listAbsorbedLessons(db, projectHash, runbookId);
  if (!runbook || runbook.projectHash !== projectHash || absorbed.length === 0) throw new Error(`lesson ${runbookId} is not a runbook in this project`);
  const brief = (lesson: MemoryLesson) => ({ lessonId: lesson.lessonId, name: lesson.name, revision: lesson.revision });
  return { runbook: brief(runbook), restore: absorbed.map(brief) };
}

/**
 * Switches a runbook's absorbed lessons back on and the runbook off. It is
 * the operator's undo: lessons edited since consolidation come back as they
 * are now, which the preview (planRunbookRevert) shows with revisions.
 */
export function revertRunbookConsolidation(db: SQLiteDatabase, projectHash: string, runbookId: string, actor: string): { runbookId: string; restored: string[] } {
  return sqliteTransaction(db, () => {
    const repository = new LessonRepository(db);
    planRunbookRevert(db, projectHash, runbookId);
    const absorbed = listAbsorbedLessons(db, projectHash, runbookId);
    const runbook = repository.get(runbookId)!;
    const now = new Date().toISOString();
    for (const lesson of absorbed) {
      sqliteRun(db, `UPDATE memory_lessons SET recall_enabled = 1, absorbed_into = NULL, revision = revision + 1, updated_at = ? WHERE lesson_id = ? AND project_hash = ?`, [now, lesson.lessonId, projectHash]);
      writeGovernanceAuditEntrySync(db, { operation: 'lesson_consolidate', actor, projectHash, targetType: 'lesson', targetId: lesson.lessonId, beforeJson: lessonToAuditJson(lesson), afterJson: lessonToAuditJson(repository.get(lesson.lessonId)!) });
    }
    sqliteRun(db, `UPDATE memory_lessons SET recall_enabled = 0, revision = revision + 1, updated_at = ? WHERE lesson_id = ? AND project_hash = ?`, [now, runbookId, projectHash]);
    writeGovernanceAuditEntrySync(db, { operation: 'lesson_consolidate', actor, projectHash, targetType: 'lesson', targetId: runbookId, beforeJson: lessonToAuditJson(runbook), afterJson: lessonToAuditJson(repository.get(runbookId)!) });
    return { runbookId, restored: absorbed.map((lesson) => lesson.lessonId) };
  });
}

export function listAbsorbedLessons(db: SQLiteDatabase, projectHash: string, runbookId: string): MemoryLesson[] {
  if (!hasAbsorptionColumn(db)) return [];
  const repository = new LessonRepository(db);
  return sqliteAll<{ lesson_id: string }>(db, `SELECT lesson_id FROM memory_lessons WHERE project_hash = ? AND absorbed_into = ? ORDER BY lesson_id`, [projectHash, runbookId])
    .map((row) => repository.get(row.lesson_id)!);
}

/** Lessons that at least one absorbed lesson points at. */
export function listRunbookIds(db: SQLiteDatabase, projectHash: string): string[] {
  if (!hasAbsorptionColumn(db)) return [];
  return sqliteAll<{ id: string }>(db, `SELECT DISTINCT absorbed_into AS id FROM memory_lessons WHERE project_hash = ? AND absorbed_into IS NOT NULL ORDER BY id`, [projectHash]).map((row) => row.id);
}

/** A store opened read-only before its migration has no absorption links yet. */
function hasAbsorptionColumn(db: SQLiteDatabase): boolean {
  return sqliteAll<{ name: string }>(db, `PRAGMA table_info(memory_lessons)`).some((column) => column.name === 'absorbed_into');
}

function runbookPayload(draft: RunbookDraft, absorbed: readonly MemoryLesson[]) {
  const union = (values: string[]) => [...new Set(values)].slice(0, PROVENANCE_LIMIT);
  return {
    name: draft.name, trigger: draft.trigger, steps: draft.steps, failureModes: draft.failureModes, validation: draft.validation,
    scope: draft.scope, reconsiderWhen: draft.reconsiderWhen, skillCandidate: true,
    confidence: absorbed.length > 0 ? Math.max(...absorbed.map((lesson) => lesson.confidence)) : 0.5,
    sourceSessionIds: union(absorbed.flatMap((lesson) => lesson.sourceSessionIds)),
    sourceEventIds: union(absorbed.flatMap((lesson) => lesson.sourceEventIds))
  };
}
