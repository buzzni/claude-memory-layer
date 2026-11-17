import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { LessonRepository } from '../../src/core/operations/lesson-repository.js';
import { LessonService } from '../../src/core/operations/lesson-service.js';
import {
  applyLessonExport,
  applyLessonImport,
  LESSON_DIR_MAX_FILES,
  LESSON_FILE_MAX_BYTES,
  planLessonExport,
  planLessonImport,
  selectLessonsForExport,
  sharedLessonFileName,
  sharedLessonId
} from '../../src/core/operations/lesson-share.js';
import { lessonOrigin } from '../../src/core/memory-origin.js';
import { applyRunbookConsolidation, planRunbookConsolidation } from '../../src/services/lesson-consolidation-service.js';
import { scoreLessonEvidence } from '../../src/adapters/claude/hooks/prompt-injection-policy.js';
import { formatLessonIndexContext } from '../../src/adapters/claude/hooks/session-start.js';
import { sqliteAll, sqliteRun, type SQLiteDatabase } from '../../src/core/sqlite-wrapper.js';

const tempDirs: string[] = [];
const stores: SQLiteEventStore[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function openStore(): Promise<SQLiteDatabase> {
  const store = new SQLiteEventStore(join(tempDir('cml-lesson-share-store-'), 'events.sqlite'));
  await store.initialize();
  stores.push(store);
  return store.getDatabase();
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PROJECT_A = 'project-a';
const PROJECT_B = 'project-b';

async function saveCurated(db: SQLiteDatabase, projectHash: string, name: string, steps: string[]) {
  return new LessonService(db).saveCurated({ projectHash, actor: 'tester', name, trigger: `when ${name}`, steps, failureModes: ['skipping the check'] });
}

async function exportAll(db: SQLiteDatabase, projectHash: string, dir: string) {
  const plan = planLessonExport(await selectLessonsForExport(db, projectHash, { selectors: [], allCurated: true }), dir, { prune: false });
  applyLessonExport(plan, dir);
  return plan;
}

function importDir(db: SQLiteDatabase, projectHash: string, dir: string) {
  const plan = planLessonImport(db, projectHash, dir);
  applyLessonImport(db, projectHash, plan, 'tester');
  return plan;
}

function readDir(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).sort().map((file) => [file, readFileSync(join(dir, file), 'utf8')]));
}

describe('lesson export/import', () => {
  it('round-trips through a committed directory: re-exporting the imported lessons changes no file', async () => {
    const a = await openStore();
    await saveCurated(a, PROJECT_A, 'Release checklist', ['run tests', 'tag the release']);
    await saveCurated(a, PROJECT_A, 'Rotate keys', ['revoke the old key', 'update the secret store']);
    const exported = tempDir('cml-lesson-share-a-');
    expect((await exportAll(a, PROJECT_A, exported)).entries.map((entry) => entry.action)).toEqual(['add', 'add']);

    // "git commit" then a teammate's checkout: a copy of the directory.
    const checkout = tempDir('cml-lesson-share-checkout-');
    cpSync(exported, checkout, { recursive: true });

    const b = await openStore();
    expect(importDir(b, PROJECT_B, checkout).entries.map((entry) => entry.action)).toEqual(['add', 'add']);
    const reexport = await exportAll(b, PROJECT_B, checkout);
    expect(reexport.entries.map((entry) => entry.action)).toEqual(['unchanged', 'unchanged']);
    expect(readDir(checkout)).toEqual(readDir(exported));

    // And the original side exporting again writes nothing either.
    expect((await exportAll(a, PROJECT_A, exported)).writes.size).toBe(0);
  });

  it('writes one stable, reviewable file per lesson without local identifiers', async () => {
    const db = await openStore();
    const lesson = await saveCurated(db, PROJECT_A, 'Release checklist', ['run tests', 'tag the release']);
    const dir = tempDir('cml-lesson-share-file-');
    await exportAll(db, PROJECT_A, dir);

    const file = sharedLessonFileName(sharedLessonId('Release checklist'));
    expect(readdirSync(dir)).toEqual([file]);
    const text = readFileSync(join(dir, file), 'utf8');
    expect(JSON.parse(text)).toEqual({
      format: 'claude-memory-layer/lesson@1',
      id: sharedLessonId('Release checklist'),
      name: 'Release checklist',
      trigger: 'when Release checklist',
      steps: ['run tests', 'tag the release'],
      failureModes: ['skipping the check'],
      validation: [],
      validVersions: [],
      confidence: 1,
      skillCandidate: true
    });
    for (const local of [lesson.lessonId, PROJECT_A, ...lesson.sourceSessionIds, lesson.createdAt.toISOString()]) {
      expect(text).not.toContain(local);
    }
  });

  it('is a dry run until applied: planning writes no file and no row', async () => {
    const a = await openStore();
    await saveCurated(a, PROJECT_A, 'Release checklist', ['run tests']);
    const dir = join(tempDir('cml-lesson-share-dry-'), 'lessons');
    const exportPlan = planLessonExport(await selectLessonsForExport(a, PROJECT_A, { selectors: ['Release checklist'], allCurated: false }), dir, { prune: false });
    expect(exportPlan.entries).toMatchObject([{ action: 'add', name: 'Release checklist' }]);
    expect(existsSync(dir)).toBe(false);

    applyLessonExport(exportPlan, dir);
    const b = await openStore();
    const importPlan = planLessonImport(b, PROJECT_B, dir);
    expect(importPlan.entries).toMatchObject([{ action: 'add' }]);
    expect(sqliteAll(b, 'SELECT lesson_id FROM memory_lessons')).toEqual([]);
    expect(sqliteAll(b, 'SELECT audit_id FROM memory_governance_audit')).toEqual([]);
  });

  it('imports idempotently and audits each import', async () => {
    const a = await openStore();
    await saveCurated(a, PROJECT_A, 'Release checklist', ['run tests']);
    const dir = tempDir('cml-lesson-share-idem-');
    await exportAll(a, PROJECT_A, dir);

    const b = await openStore();
    importDir(b, PROJECT_B, dir);
    expect(importDir(b, PROJECT_B, dir).entries.map((entry) => entry.action)).toEqual(['unchanged']);
    expect(sqliteAll(b, 'SELECT lesson_id FROM memory_lessons')).toHaveLength(1);
    const audits = sqliteAll<{ operation: string; actor: string; after_json: string }>(b, 'SELECT operation, actor, after_json FROM memory_governance_audit');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ operation: 'lesson_import', actor: 'tester' });
    expect(JSON.parse(audits[0].after_json)).toMatchObject({ sourceClass: 'imported', importedFrom: sharedLessonFileName(sharedLessonId('Release checklist')) });
  });

  it('reports a conflict instead of overwriting a local lesson with the same name', async () => {
    const a = await openStore();
    await saveCurated(a, PROJECT_A, 'Release checklist', ['run tests', 'tag the release']);
    const dir = tempDir('cml-lesson-share-conflict-');
    await exportAll(a, PROJECT_A, dir);

    const b = await openStore();
    const local = await saveCurated(b, PROJECT_B, 'Release checklist', ['ship it']);
    const plan = importDir(b, PROJECT_B, dir);
    expect(plan.entries).toMatchObject([{ action: 'conflict', differingFields: ['steps'], reason: 'a curated lesson with this name already exists' }]);
    expect(new LessonRepository(b).get(local.lessonId)).toMatchObject({ steps: ['ship it'], sourceClass: 'curated', revision: 1 });
  });

  it('updates an imported lesson nobody changed locally, and treats a local change as a conflict', async () => {
    const a = await openStore();
    await saveCurated(a, PROJECT_A, 'Release checklist', ['run tests']);
    await saveCurated(a, PROJECT_A, 'Rotate keys', ['revoke the old key']);
    const dir = tempDir('cml-lesson-share-update-');
    await exportAll(a, PROJECT_A, dir);
    const b = await openStore();
    importDir(b, PROJECT_B, dir);

    // Locally switched off: no longer what the import left.
    const repository = new LessonRepository(b);
    const rotate = repository.getByProjectAndName(PROJECT_B, 'Rotate keys')!;
    repository.setRecallEnabled({ lessonId: rotate.lessonId, projectHash: PROJECT_B, expectedRevision: rotate.revision, enabled: false });

    await saveCurated(a, PROJECT_A, 'Release checklist', ['run tests', 'tag the release']);
    await saveCurated(a, PROJECT_A, 'Rotate keys', ['revoke the old key', 'tell the team']);
    await exportAll(a, PROJECT_A, dir);

    const plan = importDir(b, PROJECT_B, dir);
    const byName = [...plan.entries].sort((left, right) => left.name!.localeCompare(right.name!));
    expect(byName).toMatchObject([
      { name: 'Release checklist', action: 'update', differingFields: ['steps'] },
      { name: 'Rotate keys', action: 'conflict', reason: 'the imported lesson was changed locally since it was imported' }
    ]);
    expect(repository.getByProjectAndName(PROJECT_B, 'Release checklist')).toMatchObject({ steps: ['run tests', 'tag the release'], sourceClass: 'imported', revision: 2 });
    expect(repository.getByProjectAndName(PROJECT_B, 'Rotate keys')).toMatchObject({ steps: ['revoke the old key'] });
    // The update is itself an import, so a later export can update it again.
    expect(Object.fromEntries(importDir(b, PROJECT_B, dir).entries.map((entry) => [entry.name, entry.action])))
      .toEqual({ 'Release checklist': 'unchanged', 'Rotate keys': 'conflict' });
  });

  it('keeps an imported lesson imported when it is saved again through the curated path', async () => {
    const a = await openStore();
    await saveCurated(a, PROJECT_A, 'Release checklist', ['run tests']);
    const dir = tempDir('cml-lesson-share-sticky-');
    await exportAll(a, PROJECT_A, dir);
    const b = await openStore();
    importDir(b, PROJECT_B, dir);

    const saved = await saveCurated(b, PROJECT_B, 'Release checklist', ['run tests', 'and more']);
    expect(saved.sourceClass).toBe('imported');
  });

  it('redacts credentials, private tags and absolute paths on export, and again on import', async () => {
    const db = await openStore();
    // A lesson written by a path that does not sanitize on save.
    sqliteRun(db, `INSERT INTO memory_lessons (lesson_id, project_hash, name, trigger, steps_json, confidence, source_class, created_at, updated_at)
      VALUES ('00000000-0000-4000-8000-000000000001', ?, 'Deploy', 'when deploying', ?, 0.5, 'curated', '2026-11-17T00:00:00.000Z', '2026-11-17T00:00:00.000Z')`,
    [PROJECT_A, JSON.stringify(['run /Users/someone/deploy.sh', 'export API_TOKEN=abc123secret', 'mention <private>the vpn password</private> here'])]);
    const dir = tempDir('cml-lesson-share-redact-');
    const plan = await exportAll(db, PROJECT_A, dir);
    expect(plan.entries).toMatchObject([{ action: 'add', redactedFields: ['steps'] }]);
    const text = readDir(dir)[sharedLessonFileName(sharedLessonId('Deploy'))];
    expect(text).not.toContain('/Users/someone');
    expect(text).not.toContain('abc123secret');
    expect(text).not.toContain('vpn password');
    expect(text).toContain('[REDACTED]');
    // Redaction reaches a fixed point: exporting the same text again is stable.
    expect((await exportAll(db, PROJECT_A, dir)).writes.size).toBe(0);

    // A hand-edited file is redacted on the way in.
    const file = sharedLessonFileName(sharedLessonId('Deploy'));
    const edited = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    edited.steps.push('copy C:\\Users\\someone\\key.pem');
    writeFileSync(join(dir, file), JSON.stringify(edited));
    const b = await openStore();
    const imported = importDir(b, PROJECT_B, dir);
    expect(imported.entries).toMatchObject([{ action: 'add', redactedFields: ['steps'] }]);
    expect(JSON.stringify(new LessonRepository(b).getByProjectAndName(PROJECT_B, 'Deploy')!.steps)).not.toContain('someone');
  });

  it('reports files that are not lesson exports and imports the rest', async () => {
    const a = await openStore();
    await saveCurated(a, PROJECT_A, 'Release checklist', ['run tests']);
    const dir = tempDir('cml-lesson-share-invalid-');
    await exportAll(a, PROJECT_A, dir);
    writeFileSync(join(dir, 'broken.json'), '{');
    writeFileSync(join(dir, `${sharedLessonId('other')}.json`), JSON.stringify({
      format: 'claude-memory-layer/lesson@1', id: sharedLessonId('other'), name: 'renamed', trigger: 't', steps: ['s'],
      failureModes: [], validation: [], validVersions: [], confidence: 1, skillCandidate: false
    }));
    writeFileSync(join(dir, `${sharedLessonId('extra')}.json`), JSON.stringify({
      format: 'claude-memory-layer/lesson@1', id: sharedLessonId('extra'), name: 'extra', trigger: 't', steps: ['s'],
      failureModes: [], validation: [], validVersions: [], confidence: 1, skillCandidate: false, sourceEventIds: ['e1']
    }));
    const b = await openStore();
    const plan = importDir(b, PROJECT_B, dir);
    expect(plan.entries.filter((entry) => entry.action === 'invalid').map((entry) => entry.file).sort()).toEqual(
      ['broken.json', `${sharedLessonId('extra')}.json`, `${sharedLessonId('other')}.json`].sort()
    );
    expect(plan.entries.filter((entry) => entry.action === 'add')).toHaveLength(1);
  });

  it('prunes only unselected files that read as valid lesson exports, and shows them first', async () => {
    const a = await openStore();
    await saveCurated(a, PROJECT_A, 'Release checklist', ['run tests']);
    await saveCurated(a, PROJECT_A, 'Rotate keys', ['revoke the old key']);
    const dir = tempDir('cml-lesson-share-prune-');
    await exportAll(a, PROJECT_A, dir);
    writeFileSync(join(dir, 'README.md'), 'team notes');
    // Reviewer repro: plain text under a lesson-shaped name was deleted.
    writeFileSync(join(dir, '0000000000000000.json'), 'not a lesson');
    const outside = join(tempDir('cml-lesson-share-prune-outside-'), 'target.json');
    writeFileSync(outside, 'outside');
    symlinkSync(outside, join(dir, '1111111111111111.json'));

    const one = await selectLessonsForExport(a, PROJECT_A, { selectors: ['Release checklist'], allCurated: false });
    expect(planLessonExport(one, dir, { prune: false }).entries.map((entry) => entry.action)).toEqual(['unchanged']);
    const pruned = planLessonExport(one, dir, { prune: true });
    expect(pruned.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'remove', name: 'Rotate keys', file: sharedLessonFileName(sharedLessonId('Rotate keys')) }),
      expect.objectContaining({ action: 'keep', file: '0000000000000000.json' }),
      expect.objectContaining({ action: 'keep', file: '1111111111111111.json' })
    ]));
    expect(existsSync(join(dir, sharedLessonFileName(sharedLessonId('Rotate keys'))))).toBe(true);
    applyLessonExport(pruned, dir);
    expect(readdirSync(dir).sort()).toEqual(
      [sharedLessonFileName(sharedLessonId('Release checklist')), '0000000000000000.json', '1111111111111111.json', 'README.md'].sort()
    );
    expect(readFileSync(outside, 'utf8')).toBe('outside');
  });

  it('rejects a selector that names no lesson', async () => {
    const a = await openStore();
    await expect(selectLessonsForExport(a, PROJECT_A, { selectors: ['missing'], allCurated: false })).rejects.toThrow(/no lesson in this project matches "missing"/);
  });

  it('fails when the import directory does not exist', async () => {
    const b = await openStore();
    expect(() => planLessonImport(b, PROJECT_B, join(tempDir('cml-lesson-share-missing-'), 'nope'))).toThrow(/does not exist/);
  });
});

describe('imported lesson origin', () => {
  async function importedLesson() {
    const a = await openStore();
    await saveCurated(a, PROJECT_A, 'Release checklist', ['run the release tests', 'tag the release']);
    const dir = tempDir('cml-lesson-share-origin-');
    await exportAll(a, PROJECT_A, dir);
    const b = await openStore();
    importDir(b, PROJECT_B, dir);
    return { local: (await new LessonRepository(b).list({ projectHash: PROJECT_B }))[0], curated: (await new LessonRepository(a).list({ projectHash: PROJECT_A }))[0] };
  }

  it('classifies from the stored source class: imported lessons are imported, curated ones derived', async () => {
    const { local, curated } = await importedLesson();
    expect(local.sourceClass).toBe('imported');
    expect(lessonOrigin(local)).toBe('imported');
    expect(lessonOrigin(curated)).toBe('derived');
  });

  it('labels an imported lesson as low-trust where it is injected', async () => {
    const { local, curated } = await importedLesson();
    const evidence = scoreLessonEvidence('Release checklist', { ...local, sourceClass: local.sourceClass });
    expect(evidence?.origin).toBe('imported');
    expect(scoreLessonEvidence('Release checklist', curated)?.origin).toBe('derived');

    const index = formatLessonIndexContext([local, { ...curated, name: 'Other lesson' }], { budgetChars: 2400, totalCount: 2 });
    expect(index).toContain('- [low-trust: imported] Release checklist — ');
    expect(index).toContain('- Other lesson — ');
  });
});

describe('lesson files: links, sizes and races', () => {
  async function exportedDir(names: string[] = ['Release checklist']) {
    const a = await openStore();
    for (const name of names) await saveCurated(a, PROJECT_A, name, [`do ${name}`]);
    const dir = tempDir('cml-lesson-share-safety-');
    await exportAll(a, PROJECT_A, dir);
    return { a, dir };
  }

  it('does not write through a lesson file that is a symbolic link (reviewer repro)', async () => {
    const { a, dir } = await exportedDir();
    await saveCurated(a, PROJECT_A, 'Release checklist', ['changed step']);
    const file = sharedLessonFileName(sharedLessonId('Release checklist'));
    const outside = join(tempDir('cml-lesson-share-victim-'), 'victim.txt');
    writeFileSync(outside, 'keep me');
    rmSync(join(dir, file));
    symlinkSync(outside, join(dir, file));

    const plan = await exportAll(a, PROJECT_A, dir);
    expect(plan.entries).toMatchObject([{ action: 'rejected', reason: expect.stringContaining('symbolic link') }]);
    expect(readFileSync(outside, 'utf8')).toBe('keep me');
  });

  it('does not import a lesson file that is a symbolic link (reviewer repro)', async () => {
    const { dir } = await exportedDir();
    const file = sharedLessonFileName(sharedLessonId('Release checklist'));
    const real = join(tempDir('cml-lesson-share-linked-'), file);
    cpSync(join(dir, file), real);
    rmSync(join(dir, file));
    symlinkSync(real, join(dir, file));

    const b = await openStore();
    expect(importDir(b, PROJECT_B, dir).entries).toMatchObject([{ action: 'invalid', reason: 'a symbolic link, not a regular file' }]);
    expect(sqliteAll(b, 'SELECT lesson_id FROM memory_lessons')).toEqual([]);
  });

  it('refuses a lesson directory reached through a symbolic link inside the project', async () => {
    const { a, dir } = await exportedDir();
    const project = tempDir('cml-lesson-share-project-');
    mkdirSync(join(project, '.claude-memory-layer'));
    symlinkSync(dir, join(project, '.claude-memory-layer', 'lessons'));
    const linkedDir = join(project, '.claude-memory-layer', 'lessons');
    const lessons = await selectLessonsForExport(a, PROJECT_A, { selectors: [], allCurated: true });
    expect(() => planLessonExport(lessons, linkedDir, { prune: false, root: project })).toThrow(/symbolic link \(\.claude-memory-layer\/lessons\)/);
    expect(() => planLessonImport(null, PROJECT_B, linkedDir, project)).toThrow(/symbolic link/);

    // A linked parent component is refused the same way.
    const project2 = tempDir('cml-lesson-share-project2-');
    symlinkSync(tempDir('cml-lesson-share-elsewhere-'), join(project2, '.claude-memory-layer'));
    expect(() => planLessonImport(null, PROJECT_B, join(project2, '.claude-memory-layer', 'lessons'), project2)).toThrow(/symbolic link \(\.claude-memory-layer\)/);
  });

  it('reports an oversized file without reading it (reviewer repro: 12 MiB of padding)', async () => {
    const { dir } = await exportedDir();
    const file = sharedLessonFileName(sharedLessonId('Release checklist'));
    const valid = readFileSync(join(dir, file), 'utf8');
    writeFileSync(join(dir, file), ' '.repeat(12 * 1024 * 1024) + valid);
    const b = await openStore();
    expect(importDir(b, PROJECT_B, dir).entries).toMatchObject([{ action: 'invalid', reason: 'larger than the 64 KiB file limit' }]);
  });

  it('refuses a directory over the file-count or total-size limit before reading any file', async () => {
    const tooMany = tempDir('cml-lesson-share-many-');
    for (let index = 0; index <= LESSON_DIR_MAX_FILES; index += 1) writeFileSync(join(tooMany, `${index}.json`), '{}');
    expect(() => planLessonImport(null, PROJECT_B, tooMany)).toThrow(/1001 \.json files; the limit is 1000/);

    const tooBig = tempDir('cml-lesson-share-big-');
    const filler = ' '.repeat(LESSON_FILE_MAX_BYTES - 1024);
    for (let index = 0; index < 270; index += 1) writeFileSync(join(tooBig, `${index}.json`), filler);
    expect(() => planLessonImport(null, PROJECT_B, tooBig)).toThrow(/the limit is 16 MiB/);
  });

  it('rejects exporting a lesson whose file would exceed the import limit', async () => {
    const a = await openStore();
    await saveCurated(a, PROJECT_A, 'Huge', Array.from({ length: 100 }, (_value, index) => `step ${index} ${'x'.repeat(700)}`));
    const dir = tempDir('cml-lesson-share-huge-');
    const plan = await exportAll(a, PROJECT_A, dir);
    expect(plan.entries).toMatchObject([{ action: 'rejected', reason: 'larger than the 64 KiB file limit' }]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('fails the second of two racing imports as a whole, writing none of it', async () => {
    const { dir } = await exportedDir(['Release checklist', 'Rotate keys']);
    const b = await openStore();
    const first = planLessonImport(b, PROJECT_B, dir);
    const second = planLessonImport(b, PROJECT_B, dir);
    // Another import of only one of the files lands first.
    applyLessonImport(b, PROJECT_B, { ...first, planned: first.planned.filter((item) => item.entry.name === 'Rotate keys') }, 'other');
    expect(() => applyLessonImport(b, PROJECT_B, second, 'tester')).toThrow(/"Rotate keys" was added while importing/);
    expect(sqliteAll<{ name: string }>(b, 'SELECT name FROM memory_lessons').map((row) => row.name)).toEqual(['Rotate keys']);
  });

  it('rolls back the whole import when a planned update was changed locally after planning', async () => {
    const { a, dir } = await exportedDir(['Release checklist']);
    const b = await openStore();
    importDir(b, PROJECT_B, dir);
    await saveCurated(a, PROJECT_A, 'Release checklist', ['run tests', 'tag']);
    await saveCurated(a, PROJECT_A, 'Rotate keys', ['revoke']);
    await exportAll(a, PROJECT_A, dir);

    const plan = planLessonImport(b, PROJECT_B, dir);
    expect(Object.fromEntries(plan.entries.map((entry) => [entry.name, entry.action]))).toEqual({ 'Release checklist': 'update', 'Rotate keys': 'add' });
    const repository = new LessonRepository(b);
    const local = repository.getByProjectAndName(PROJECT_B, 'Release checklist')!;
    repository.setRecallEnabled({ lessonId: local.lessonId, projectHash: PROJECT_B, expectedRevision: local.revision, enabled: false });

    expect(() => applyLessonImport(b, PROJECT_B, plan, 'tester')).toThrow(/"Release checklist" changed during import/);
    expect(repository.getByProjectAndName(PROJECT_B, 'Rotate keys')).toBeNull();
    expect(repository.getByProjectAndName(PROJECT_B, 'Release checklist')).toMatchObject({ steps: ['do Release checklist'] });
  });

  it('round-trips a lesson with sensitive text at a redaction fixed point', async () => {
    const a = await openStore();
    sqliteRun(a, `INSERT INTO memory_lessons (lesson_id, project_hash, name, trigger, steps_json, confidence, source_class, created_at, updated_at)
      VALUES ('00000000-0000-4000-8000-000000000002', ?, 'Deploy', 'when deploying with password: hunter2', ?, 0.5, 'curated', '2026-11-17T00:00:00.000Z', '2026-11-17T00:00:00.000Z')`,
    [PROJECT_A, JSON.stringify(['run /Users/someone/deploy.sh --token abc123secret', 'see <private>/etc/creds</private>\nthen continue', 'curl "https://x.test/?api_key=k123456789"'])]);
    const exported = tempDir('cml-lesson-share-sensitive-');
    await exportAll(a, PROJECT_A, exported);
    const text = Object.values(readDir(exported)).join('');
    for (const secret of ['hunter2', 'abc123secret', '/Users/someone', '/etc/creds', 'k123456789']) expect(text).not.toContain(secret);

    const checkout = tempDir('cml-lesson-share-sensitive-checkout-');
    cpSync(exported, checkout, { recursive: true });
    const b = await openStore();
    expect(importDir(b, PROJECT_B, checkout).entries).toMatchObject([{ action: 'add' }]);
    expect((await exportAll(b, PROJECT_B, checkout)).entries).toMatchObject([{ action: 'unchanged' }]);
    expect(readDir(checkout)).toEqual(readDir(exported));
  });

  it('plans against an old store without touching it: no migration, no audit table needed', async () => {
    const { dir } = await exportedDir();
    const store = tempDir('cml-lesson-share-old-');
    const dbPath = join(store, 'events.sqlite');
    const Database = (await import('better-sqlite3')).default;
    const old = new Database(dbPath);
    old.exec(`CREATE TABLE memory_lessons (lesson_id TEXT PRIMARY KEY, project_hash TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, trigger TEXT NOT NULL,
      steps_json TEXT NOT NULL, confidence REAL NOT NULL, source_session_ids TEXT NOT NULL DEFAULT '[]', source_event_ids TEXT NOT NULL DEFAULT '[]',
      failure_modes_json TEXT NOT NULL DEFAULT '[]', skill_candidate INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_hash, name))`);
    old.prepare(`INSERT INTO memory_lessons (lesson_id, project_hash, name, trigger, steps_json, confidence, created_at, updated_at)
      VALUES ('00000000-0000-4000-8000-000000000003', ?, 'Release checklist', 't', '["other"]', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run(PROJECT_B);
    old.close();
    const before = readFileSync(dbPath);
    const readOnly = new Database(dbPath, { readonly: true });
    try {
      expect(planLessonImport(readOnly, PROJECT_B, dir).entries).toMatchObject([{ action: 'conflict', reason: 'a derived lesson with this name already exists' }]);
    } finally {
      readOnly.close();
    }
    expect(readFileSync(dbPath).equals(before)).toBe(true);
    expect(readdirSync(store)).toEqual(['events.sqlite']);
  });
});

describe('imported provenance only goes down', () => {
  async function importedInto(b: SQLiteDatabase, names: string[]) {
    const a = await openStore();
    for (const name of names) await saveCurated(a, PROJECT_A, name, [`do ${name}`]);
    const dir = tempDir('cml-lesson-share-consolidate-');
    await exportAll(a, PROJECT_A, dir);
    importDir(b, PROJECT_B, dir);
  }

  function draft(lessonId: string, absorbs: Array<{ lessonId: string; revision: number }>) {
    return { runbooks: [{ lessonId, name: `runbook ${lessonId}`, trigger: 'when releasing', steps: ['do the release'], validation: ['released'], scope: 'releases', reconsiderWhen: 'the release flow changes', absorbs }] };
  }

  it('makes a runbook imported when it absorbs an imported lesson (reviewer repro), curated otherwise', async () => {
    const b = await openStore();
    await importedInto(b, ['Release checklist']);
    const local = await saveCurated(b, PROJECT_B, 'Local step', ['do local']);
    const repository = new LessonRepository(b);
    const imported = repository.getByProjectAndName(PROJECT_B, 'Release checklist')!;

    const mixed = draft('rb-mixed', [{ lessonId: imported.lessonId, revision: imported.revision }, { lessonId: local.lessonId, revision: local.revision }]);
    expect(planRunbookConsolidation(b, PROJECT_B, mixed).runbooks).toMatchObject([{ sourceClass: 'imported' }]);
    const [runbook] = applyRunbookConsolidation(b, PROJECT_B, mixed, 'tester').runbooks;
    const stored = repository.get(runbook.lessonId)!;
    expect(stored.sourceClass).toBe('imported');
    expect(lessonOrigin(stored)).toBe('imported');

    const other = await saveCurated(b, PROJECT_B, 'Another local', ['do another']);
    const curatedOnly = draft('rb-local', [{ lessonId: other.lessonId, revision: other.revision }]);
    expect(planRunbookConsolidation(b, PROJECT_B, curatedOnly).runbooks).toMatchObject([{ sourceClass: 'curated' }]);
  });

  it('refuses any UPDATE that would move an imported lesson to another source class', async () => {
    const b = await openStore();
    await importedInto(b, ['Release checklist']);
    expect(() => sqliteRun(b, `UPDATE memory_lessons SET source_class = 'curated' WHERE name = 'Release checklist'`)).toThrow(/an imported lesson stays imported/);
    sqliteRun(b, `UPDATE memory_lessons SET trigger = 'still allowed' WHERE name = 'Release checklist'`);
    expect(new LessonRepository(b).getByProjectAndName(PROJECT_B, 'Release checklist')).toMatchObject({ sourceClass: 'imported', trigger: 'still allowed' });
  });
});
