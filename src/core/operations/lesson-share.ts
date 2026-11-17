/**
 * Curated lesson export/import through files a team commits to its repository.
 *
 * One JSON file per lesson, named by a hash of the lesson name. Two people
 * adding different lessons touch different files, so git merges them without
 * a conflict; a change to one lesson is a diff of that one file. The file
 * holds only reviewed text: no session or event ids, no machine or project
 * identifiers, no timestamps, so exporting the same lesson again from any
 * store writes the same bytes.
 *
 * Import never overwrites a lesson silently. A name that already exists with
 * other text is a conflict, except a lesson this import path wrote whose
 * revision has not moved since: nobody changed it locally, so a newer export
 * of it is an update. Imported lessons are stored with
 * `source_class = 'imported'` (see lessonOrigin). Deleting a file does not
 * delete the lesson where it was imported.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

import { applyPrivacyFilter } from '../privacy/filter.js';
import { sqliteTransaction, type SQLiteDatabase } from '../sqlite-wrapper.js';
import type { MemoryLesson } from '../types.js';
import { sanitizeGovernanceAuditValue } from './governance-audit.js';
import { LessonRepository } from './lesson-repository.js';
import { CURATED_PRIVACY_CONFIG } from './lesson-service.js';

export const LESSON_SHARE_FORMAT = 'claude-memory-layer/lesson@1';
/** Relative to the project root. Product-named so it does not collide with `.claude/` or other tools. */
export const DEFAULT_LESSON_SHARE_DIR = path.join('.claude-memory-layer', 'lessons');

const SHARED_ID = /^[0-9a-f]{16}$/;
const SHARED_FILE = /^[0-9a-f]{16}\.json$/;

const Text = z.string().trim().min(1).max(8000);
const TextList = z.array(Text).max(200);

/** Field order here is the file's key order. */
const SharedLessonSchema = z.object({
  format: z.literal(LESSON_SHARE_FORMAT),
  id: z.string().regex(SHARED_ID),
  name: Text,
  trigger: Text,
  steps: TextList.min(1),
  failureModes: TextList,
  scope: Text.optional(),
  validation: TextList,
  reconsiderWhen: Text.optional(),
  validVersions: TextList,
  confidence: z.number().min(0).max(1),
  skillCandidate: z.boolean()
}).strict();
export type SharedLesson = z.infer<typeof SharedLessonSchema>;

export function sharedLessonId(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 16);
}

export function sharedLessonFileName(id: string): string {
  return `${id}.json`;
}

export function serializeSharedLesson(lesson: SharedLesson): string {
  return `${JSON.stringify(lesson, null, 2)}\n`;
}

/**
 * Privacy filter (private tags, credential patterns), then the audit
 * sanitizer (credentials, absolute paths), repeated until neither changes the
 * text. The privacy filter goes first: the path pattern would otherwise eat a
 * closing `</private>` tag and leave its content unmatched. Each can leave a
 * match for the other; stopping at a fixed point keeps a second export of
 * imported text byte-identical.
 */
function shareSafeText(value: string): string {
  const privacy = (text: string) => applyPrivacyFilter(text, CURATED_PRIVACY_CONFIG).content.trim();
  const sanitize = (text: string) => String(sanitizeGovernanceAuditValue(text)).trim();
  let text = value.trim();
  for (let pass = 0; pass < 5 && (privacy(text) !== text || sanitize(text) !== text); pass += 1) {
    text = sanitize(privacy(text));
  }
  return text;
}

interface ShareSafeResult {
  lesson: SharedLesson;
  /** Fields whose text the redaction changed. */
  redactedFields: string[];
}

/** The share-safe file form of a lesson; `lesson` may be a stored lesson or a parsed file. */
export function toSharedLesson(lesson: Pick<MemoryLesson, 'name' | 'trigger' | 'steps' | 'failureModes' | 'scope' | 'reconsiderWhen' | 'confidence' | 'skillCandidate'> & {
  validation?: string[];
  validVersions?: string[];
}): ShareSafeResult {
  const redactedFields = new Set<string>();
  const text = (field: string, value: string) => {
    const safe = shareSafeText(value);
    if (safe !== value.trim()) redactedFields.add(field);
    return safe;
  };
  const list = (field: string, values: readonly string[]) => values.map((value) => text(field, value)).filter((value) => value.length > 0);
  const name = text('name', lesson.name);
  const shared: SharedLesson = {
    format: LESSON_SHARE_FORMAT,
    id: sharedLessonId(name),
    name,
    trigger: text('trigger', lesson.trigger),
    steps: list('steps', lesson.steps),
    failureModes: list('failureModes', lesson.failureModes),
    scope: lesson.scope === undefined ? undefined : text('scope', lesson.scope),
    validation: list('validation', lesson.validation ?? []),
    reconsiderWhen: lesson.reconsiderWhen === undefined ? undefined : text('reconsiderWhen', lesson.reconsiderWhen),
    validVersions: list('validVersions', lesson.validVersions ?? []),
    confidence: lesson.confidence,
    skillCandidate: lesson.skillCandidate
  };
  return { lesson: SharedLessonSchema.parse(shared), redactedFields: [...redactedFields] };
}

async function listAllLessons(repository: LessonRepository, projectHash: string): Promise<MemoryLesson[]> {
  const lessons: MemoryLesson[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await repository.list({ projectHash, limit: 500, offset });
    lessons.push(...page);
    if (page.length < 500) return lessons;
  }
}

/**
 * Lessons named by `selectors` (local lesson id, name, or shared id), or with
 * `allCurated` every recall-enabled curated or imported lesson: the set a
 * team shares, including what this store imported from it earlier.
 */
export async function selectLessonsForExport(
  db: SQLiteDatabase,
  projectHash: string,
  selection: { selectors: string[]; allCurated: boolean }
): Promise<MemoryLesson[]> {
  const lessons = await listAllLessons(new LessonRepository(db), projectHash);
  const selected = new Map<string, MemoryLesson>();
  if (selection.allCurated) {
    for (const lesson of lessons) {
      if (lesson.recallEnabled && (lesson.sourceClass === 'curated' || lesson.sourceClass === 'imported')) selected.set(lesson.lessonId, lesson);
    }
  }
  for (const selector of selection.selectors) {
    const lesson = lessons.find((item) => item.lessonId === selector || item.name === selector || sharedLessonId(item.name) === selector);
    if (!lesson) throw new Error(`no lesson in this project matches "${selector}"`);
    selected.set(lesson.lessonId, lesson);
  }
  return [...selected.values()];
}

export type LessonExportAction = 'add' | 'update' | 'unchanged' | 'remove';

export interface LessonExportEntry {
  action: LessonExportAction;
  id: string;
  name?: string;
  file: string;
  redactedFields?: string[];
}

export interface LessonExportPlan {
  entries: LessonExportEntry[];
  /** File name → content for add/update. */
  writes: Map<string, string>;
  /** File names to delete (prune only). */
  removals: string[];
}

function sharedFilesIn(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((file) => SHARED_FILE.test(file)).sort();
}

/**
 * Compare the selected lessons with the export directory. With `prune`,
 * lesson files in the directory that the selection does not include are
 * removed; without it they are left alone and not reported.
 */
export function planLessonExport(lessons: readonly MemoryLesson[], dir: string, options: { prune: boolean }): LessonExportPlan {
  const entries: LessonExportEntry[] = [];
  const writes = new Map<string, string>();
  const byFile = new Map<string, string>();
  for (const lesson of lessons) {
    const { lesson: shared, redactedFields } = toSharedLesson(lesson);
    const file = sharedLessonFileName(shared.id);
    const other = byFile.get(file);
    if (other !== undefined) throw new Error(`lessons "${other}" and "${shared.name}" export to the same file ${file}`);
    byFile.set(file, shared.name);
    const content = serializeSharedLesson(shared);
    const target = path.join(dir, file);
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    const action: LessonExportAction = existing === null ? 'add' : existing === content ? 'unchanged' : 'update';
    if (action !== 'unchanged') writes.set(file, content);
    entries.push({ action, id: shared.id, name: shared.name, file, ...(redactedFields.length > 0 ? { redactedFields } : {}) });
  }
  const removals = options.prune ? sharedFilesIn(dir).filter((file) => !byFile.has(file)) : [];
  for (const file of removals) entries.push({ action: 'remove', id: file.slice(0, -'.json'.length), file });
  entries.sort((left, right) => left.file.localeCompare(right.file));
  return { entries, writes, removals };
}

export function applyLessonExport(plan: LessonExportPlan, dir: string): void {
  if (plan.writes.size > 0) fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of plan.writes) fs.writeFileSync(path.join(dir, file), content, 'utf8');
  for (const file of plan.removals) fs.rmSync(path.join(dir, file));
}

export type LessonImportAction = 'add' | 'update' | 'unchanged' | 'conflict' | 'invalid';

export interface LessonImportEntry {
  action: LessonImportAction;
  file: string;
  id?: string;
  name?: string;
  /** conflict: fields where the local lesson differs from the file. */
  differingFields?: string[];
  /** conflict/invalid: why the file is not imported. */
  reason?: string;
  redactedFields?: string[];
}

interface PlannedImport {
  entry: LessonImportEntry;
  lesson?: SharedLesson;
  local?: MemoryLesson;
}

export interface LessonImportPlan {
  entries: LessonImportEntry[];
  planned: PlannedImport[];
}

function readSharedLessonFile(dir: string, file: string): { lesson: SharedLesson; redactedFields: string[] } | { reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  } catch {
    return { reason: 'not valid JSON' };
  }
  const parsed = SharedLessonSchema.safeParse(raw);
  if (!parsed.success) {
    return { reason: `not a ${LESSON_SHARE_FORMAT} file: ${parsed.error.issues.map((issue) => issue.path.join('.') || issue.message).join(', ')}` };
  }
  if (parsed.data.id !== sharedLessonId(parsed.data.name) || file !== sharedLessonFileName(parsed.data.id)) {
    return { reason: 'id does not match the lesson name or the file name' };
  }
  // A hand-edited file goes through the same redaction as an export.
  return toSharedLesson(parsed.data);
}

const COMPARED_FIELDS = ['trigger', 'steps', 'failureModes', 'scope', 'validation', 'reconsiderWhen', 'validVersions', 'confidence', 'skillCandidate'] as const;

function differingFields(local: SharedLesson, incoming: SharedLesson): string[] {
  return COMPARED_FIELDS.filter((field) => JSON.stringify(local[field]) !== JSON.stringify(incoming[field]));
}

/** `db` may be null when the project has no lesson store yet: every valid file is then an add. */
export function planLessonImport(db: SQLiteDatabase | null, projectHash: string, dir: string): LessonImportPlan {
  if (!fs.existsSync(dir)) throw new Error('lesson directory does not exist');
  const repository = db ? new LessonRepository(db) : null;
  const planned: PlannedImport[] = [];
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    const read = readSharedLessonFile(dir, file);
    if ('reason' in read) {
      planned.push({ entry: { action: 'invalid', file, reason: read.reason } });
      continue;
    }
    const { lesson, redactedFields } = read;
    const base = { file, id: lesson.id, name: lesson.name, ...(redactedFields.length > 0 ? { redactedFields } : {}) };
    const local = repository?.getByProjectAndName(projectHash, lesson.name) ?? null;
    if (!local) {
      planned.push({ entry: { action: 'add', ...base }, lesson });
      continue;
    }
    const differing = differingFields(toSharedLesson(local).lesson, lesson);
    if (differing.length === 0) {
      planned.push({ entry: { action: 'unchanged', ...base }, lesson, local });
    } else if (local.sourceClass === 'imported' && repository!.lastImportedRevision(local.lessonId) === local.revision) {
      planned.push({ entry: { action: 'update', ...base, differingFields: differing }, lesson, local });
    } else {
      const reason = local.sourceClass === 'imported'
        ? 'the imported lesson was changed locally since it was imported'
        : `a ${local.sourceClass} lesson with this name already exists`;
      planned.push({ entry: { action: 'conflict', ...base, differingFields: differing, reason }, lesson, local });
    }
  }
  return { entries: planned.map((item) => item.entry), planned };
}

/**
 * Write the plan's adds and updates in one transaction. An update re-checks
 * the revision it was planned against, so a lesson changed in between fails
 * the whole import instead of being overwritten.
 */
export function applyLessonImport(db: SQLiteDatabase, projectHash: string, plan: LessonImportPlan, actor: string): void {
  const repository = new LessonRepository(db);
  sqliteTransaction(db, () => {
    for (const { entry, lesson, local } of plan.planned) {
      if (!lesson || (entry.action !== 'add' && entry.action !== 'update')) continue;
      const input = { ...lesson, projectHash, actor, file: entry.file };
      if (entry.action === 'add') {
        repository.insertImported(input);
      } else if (!repository.updateImported(local!.lessonId, local!.revision, input)) {
        throw new Error(`lesson "${lesson.name}" changed during import; run the import again`);
      }
    }
  });
}

export function countActions<T extends string>(entries: ReadonlyArray<{ action: T }>): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const { action } of entries) counts[action] = (counts[action] ?? 0) + 1;
  return counts;
}
