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
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

import { applyPrivacyFilter } from '../privacy/filter.js';
import type { SQLiteDatabase } from '../sqlite-wrapper.js';
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

/**
 * The share-safe file form of a lesson; `lesson` may be a stored lesson or a
 * parsed file. Redaction can lengthen text past the format's limits or empty a
 * field, so the result is validated again and a failure is returned as a
 * reason for that one lesson, never thrown.
 */
export function toSharedLesson(lesson: Pick<MemoryLesson, 'name' | 'trigger' | 'steps' | 'failureModes' | 'scope' | 'reconsiderWhen' | 'confidence' | 'skillCandidate'> & {
  validation?: string[];
  validVersions?: string[];
}): ShareSafeResult | { reason: string } {
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
  const parsed = SharedLessonSchema.safeParse(shared);
  if (!parsed.success) {
    return { reason: `not a valid lesson after redaction: ${parsed.error.issues.map((issue) => issue.path.join('.') || issue.message).join(', ')}` };
  }
  return { lesson: parsed.data, redactedFields: [...redactedFields] };
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

/**
 * Size limits, checked before a file is read. A lesson is a short procedure:
 * `lesson add` takes at most 100 steps and recall shows the first 8, so a
 * 100-step lesson of ~600-byte steps is the realistic ceiling. One file may
 * be 64 KiB; one directory at most 1000 lesson files and 16 MiB in all, more
 * than a team can review or the per-prompt lesson lane (which scans every
 * enabled lesson) should carry.
 */
export const LESSON_FILE_MAX_BYTES = 64 * 1024;
export const LESSON_DIR_MAX_FILES = 1000;
export const LESSON_DIR_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The lesson directory must be a real directory reached without symbolic
 * links: every component from `root` (the project) down to `dir` that exists
 * is checked with lstat. A link committed to the repository (the directory
 * itself, a parent inside the project, or a lesson file) could otherwise
 * point reads and writes outside it. For a `dir` outside `root` only `dir`
 * itself is checked: the caller named that path.
 */
export function assertLessonDirectory(root: string, dir: string): void {
  const relative = path.relative(root, dir);
  const inside = relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  const components = inside
    ? relative.split(path.sep).map((_part, index, parts) => path.join(root, ...parts.slice(0, index + 1)))
    : [dir];
  for (const component of components) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(component);
    } catch {
      return; // Missing from here down; export creates it.
    }
    const shown = inside ? path.relative(root, component) : path.basename(component);
    if (stat.isSymbolicLink()) throw new Error(`lesson directory path goes through a symbolic link (${shown}); refusing to follow it`);
    if (!stat.isDirectory()) throw new Error(`lesson directory path is not a directory (${shown})`);
  }
}

type FileRead = { text: string } | { reason: string };

/**
 * A regular file's text, read without following a link (O_NOFOLLOW where the
 * platform has it; the lstat in listJsonFiles otherwise) and never past the
 * size limit: the size is checked on the open descriptor before reading.
 */
function readRegularFile(file: string): FileRead {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    return { reason: (error as NodeJS.ErrnoException).code === 'ELOOP' ? 'a symbolic link, not a regular file' : 'not readable' };
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { reason: 'not a regular file' };
    if (stat.size > LESSON_FILE_MAX_BYTES) return { reason: `larger than the ${LESSON_FILE_MAX_BYTES / 1024} KiB file limit` };
    const buffer = Buffer.alloc(LESSON_FILE_MAX_BYTES + 1);
    let length = 0;
    for (let read = -1; read !== 0 && length < buffer.length;) {
      read = fs.readSync(fd, buffer, length, buffer.length - length, null);
      length += read;
    }
    if (length > LESSON_FILE_MAX_BYTES) return { reason: `larger than the ${LESSON_FILE_MAX_BYTES / 1024} KiB file limit` };
    return { text: buffer.subarray(0, length).toString('utf8') };
  } finally {
    fs.closeSync(fd);
  }
}

interface JsonFileEntry {
  file: string;
  /** null: a regular file; otherwise why it is not read. */
  problem: string | null;
}

/** `.json` entries of `dir`, by lstat: links and other non-regular entries carry a problem and are never read. */
function listJsonFiles(dir: string): JsonFileEntry[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith('.json'))
    .map((entry) => ({
      file: entry.name,
      problem: entry.isSymbolicLink() ? 'a symbolic link, not a regular file' : entry.isFile() ? null : 'not a regular file'
    }))
    .sort((left, right) => left.file.localeCompare(right.file));
}

/**
 * Write through a new file created exclusively in the same directory, then
 * rename it over the target. The exclusive create never follows a link, and
 * rename replaces a directory entry instead of writing through it.
 */
function writeFileNoFollow(root: string, dir: string, file: string, content: string): void {
  const temp = path.join(dir, `.${file}.${randomUUID()}.tmp`);
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
  try {
    try {
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // The directory chain again, right before the entry is replaced.
    assertLessonDirectory(root, dir);
    fs.renameSync(temp, path.join(dir, file));
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

export type LessonExportAction = 'add' | 'update' | 'unchanged' | 'remove' | 'keep' | 'rejected';

export interface LessonExportEntry {
  action: LessonExportAction;
  id: string;
  name?: string;
  file: string;
  /** keep/rejected: why the file is left as it is. */
  reason?: string;
  redactedFields?: string[];
}

export interface LessonExportPlan {
  entries: LessonExportEntry[];
  /** File name → content for add/update. */
  writes: Map<string, string>;
  /** File names to delete (prune only). */
  removals: string[];
}

/**
 * Compare the selected lessons with the export directory. A target that is
 * not a regular file (a link, a directory) is `rejected` and never written
 * through. With `prune`, unselected files are removed only when they read as
 * a valid lesson export; anything else in the directory is `keep`. Without
 * `prune`, unselected files are left alone and not reported.
 */
export function planLessonExport(lessons: readonly MemoryLesson[], dir: string, options: { prune: boolean; root?: string }): LessonExportPlan {
  assertLessonDirectory(options.root ?? dir, dir);
  const entries: LessonExportEntry[] = [];
  const writes = new Map<string, string>();
  const byFile = new Map<string, string>();
  const onDisk = new Map(listJsonFiles(dir).map((entry) => [entry.file, entry]));
  for (const lesson of lessons) {
    const converted = toSharedLesson(lesson);
    if ('reason' in converted) {
      const name = shareSafeText(lesson.name);
      const id = sharedLessonId(name);
      entries.push({ action: 'rejected', id, name, file: sharedLessonFileName(id), reason: converted.reason });
      continue;
    }
    const { lesson: shared, redactedFields } = converted;
    const file = sharedLessonFileName(shared.id);
    const other = byFile.get(file);
    if (other !== undefined) throw new Error(`lessons "${other}" and "${shared.name}" export to the same file ${file}`);
    byFile.set(file, shared.name);
    const base = { id: shared.id, name: shared.name, file, ...(redactedFields.length > 0 ? { redactedFields } : {}) };
    const content = serializeSharedLesson(shared);
    if (Buffer.byteLength(content) > LESSON_FILE_MAX_BYTES) {
      entries.push({ action: 'rejected', ...base, reason: `larger than the ${LESSON_FILE_MAX_BYTES / 1024} KiB file limit` });
      continue;
    }
    const present = onDisk.get(file);
    const existing = present === undefined ? null : present.problem === null ? readRegularFile(path.join(dir, file)) : { reason: present.problem };
    if (existing !== null && 'reason' in existing) {
      entries.push({ action: 'rejected', ...base, reason: `${existing.reason}; refusing to replace it` });
      continue;
    }
    const action: LessonExportAction = existing === null ? 'add' : existing.text === content ? 'unchanged' : 'update';
    if (action !== 'unchanged') writes.set(file, content);
    entries.push({ action, ...base });
  }
  const removals: string[] = [];
  if (options.prune) {
    for (const { file, problem } of onDisk.values()) {
      if (byFile.has(file) || !SHARED_FILE.test(file)) continue;
      const read = problem === null ? readSharedLessonFile(dir, file) : { reason: problem };
      if ('reason' in read) {
        entries.push({ action: 'keep', id: file.slice(0, -'.json'.length), file, reason: `${read.reason}; prune removes only valid lesson exports` });
      } else {
        removals.push(file);
        entries.push({ action: 'remove', id: read.lesson.id, name: read.lesson.name, file });
      }
    }
  }
  entries.sort((left, right) => left.file.localeCompare(right.file));
  return { entries, writes, removals };
}

/** Writes adds and updates and removes pruned files; rejected entries are not in the plan's writes. */
export function applyLessonExport(plan: LessonExportPlan, dir: string, root: string = dir): void {
  assertLessonDirectory(root, dir);
  if (plan.writes.size > 0) {
    fs.mkdirSync(dir, { recursive: true });
    assertLessonDirectory(root, dir);
  }
  for (const [file, content] of plan.writes) writeFileNoFollow(root, dir, file, content);
  for (const file of plan.removals) {
    // unlink removes the entry itself; it never follows a link.
    if (fs.lstatSync(path.join(dir, file)).isFile()) fs.unlinkSync(path.join(dir, file));
  }
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
  const read = readRegularFile(path.join(dir, file));
  if ('reason' in read) return read;
  let raw: unknown;
  try {
    raw = JSON.parse(read.text);
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

/** Refuses the whole directory, before reading any file, when it is over the count or byte limit. */
function assertDirectoryWithinLimits(dir: string, files: readonly JsonFileEntry[]): void {
  if (files.length > LESSON_DIR_MAX_FILES) {
    throw new Error(`lesson directory has ${files.length} .json files; the limit is ${LESSON_DIR_MAX_FILES}`);
  }
  let total = 0;
  for (const { file, problem } of files) {
    if (problem !== null) continue;
    const size = fs.lstatSync(path.join(dir, file)).size;
    // An oversized file is reported on its own and never read; it does not count.
    if (size <= LESSON_FILE_MAX_BYTES) total += size;
  }
  if (total > LESSON_DIR_MAX_BYTES) {
    throw new Error(`lesson files total ${total} bytes; the limit is ${LESSON_DIR_MAX_BYTES / (1024 * 1024)} MiB`);
  }
}

/** `db` may be null when the project has no lesson store yet: every valid file is then an add. */
export function planLessonImport(db: SQLiteDatabase | null, projectHash: string, dir: string, root: string = dir): LessonImportPlan {
  assertLessonDirectory(root, dir);
  if (!fs.existsSync(dir)) throw new Error('lesson directory does not exist');
  const files = listJsonFiles(dir);
  assertDirectoryWithinLimits(dir, files);
  const repository = db ? new LessonRepository(db) : null;
  const planned: PlannedImport[] = [];
  for (const { file, problem } of files) {
    const read = problem === null ? readSharedLessonFile(dir, file) : { reason: problem };
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
    const localShared = toSharedLesson(local);
    if ('reason' in localShared) {
      planned.push({ entry: { action: 'conflict', ...base, reason: `the local lesson with this name cannot be compared (${localShared.reason})` }, lesson, local });
      continue;
    }
    const differing = differingFields(localShared.lesson, lesson);
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
 * Write the plan's adds and updates in one immediate transaction. Each entry
 * is re-checked inside it: an add whose name now exists, or an update whose
 * lesson moved past the planned revision (another import, a local edit),
 * fails the whole import, so nothing is overwritten and nothing is half done.
 */
export function applyLessonImport(db: SQLiteDatabase, projectHash: string, plan: LessonImportPlan, actor: string): void {
  const repository = new LessonRepository(db);
  db.transaction(() => {
    for (const { entry, lesson, local } of plan.planned) {
      if (!lesson || (entry.action !== 'add' && entry.action !== 'update')) continue;
      const input = { ...lesson, projectHash, actor, file: entry.file };
      if (entry.action === 'add') {
        if (repository.getByProjectAndName(projectHash, lesson.name)) {
          throw new Error(`lesson "${lesson.name}" was added while importing; run the import again`);
        }
        repository.insertImported(input);
      } else if (!repository.updateImported(local!.lessonId, local!.revision, input)) {
        throw new Error(`lesson "${lesson.name}" changed during import; run the import again`);
      }
    }
  }).immediate();
}

export function countActions<T extends string>(entries: ReadonlyArray<{ action: T }>): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const { action } of entries) counts[action] = (counts[action] ?? 0) + 1;
  return counts;
}
