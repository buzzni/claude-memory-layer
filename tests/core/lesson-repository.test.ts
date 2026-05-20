import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { LessonRepository } from '../../src/core/operations/lesson-repository.js';
import { sqliteAll, sqliteGet } from '../../src/core/sqlite-wrapper.js';
import { MemoryLessonSchema, UpsertMemoryLessonInputSchema } from '../../src/core/types.js';

const tempDirs: string[] = [];

async function createFixture(): Promise<{ store: SQLiteEventStore; repo: LessonRepository; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-lesson-repo-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  return { store, repo: new LessonRepository(store.getDatabase()), cleanup: async () => store.close() };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Memory lesson schemas', () => {
  it('normalizes lesson input and requires source refs plus at least one step', () => {
    const parsed = UpsertMemoryLessonInputSchema.parse({
      projectHash: ' project-1 ',
      name: ' Release checklist ',
      trigger: ' when a release is requested ',
      steps: [' run tests ', ' commit changes '],
      sourceSessionIds: [' session-1 ', ''],
      sourceEventIds: [' event-1 '],
      failureModes: [' flaky tests '],
      confidence: 0.75,
      skillCandidate: true
    });

    expect(parsed.projectHash).toBe('project-1');
    expect(parsed.name).toBe('Release checklist');
    expect(parsed.trigger).toBe('when a release is requested');
    expect(parsed.steps).toEqual(['run tests', 'commit changes']);
    expect(parsed.sourceSessionIds).toEqual(['session-1']);
    expect(parsed.sourceEventIds).toEqual(['event-1']);
    expect(parsed.failureModes).toEqual(['flaky tests']);
    expect(parsed.skillCandidate).toBe(true);

    expect(() => UpsertMemoryLessonInputSchema.parse({
      name: 'No evidence',
      trigger: 'when guessing',
      steps: ['avoid this']
    })).toThrow(/sourceSessionIds or sourceEventIds/);

    expect(() => UpsertMemoryLessonInputSchema.parse({
      name: 'No steps',
      trigger: 'when guessing',
      steps: [],
      sourceEventIds: ['event-1']
    })).toThrow();
  });
});

describe('LessonRepository', () => {
  it('initializes memory_lessons schema with project-safe indexes', async () => {
    const { store, cleanup } = await createFixture();
    const columns = sqliteAll<{ name: string }>(store.getDatabase(), `PRAGMA table_info(memory_lessons)`);
    const indexes = sqliteAll<{ name: string }>(store.getDatabase(), `PRAGMA index_list(memory_lessons)`);
    await cleanup();

    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'lesson_id',
      'project_hash',
      'name',
      'trigger',
      'steps_json',
      'confidence',
      'source_session_ids',
      'source_event_ids',
      'failure_modes_json',
      'skill_candidate',
      'created_at',
      'updated_at'
    ]));
    expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      'idx_memory_lessons_project_confidence',
      'idx_memory_lessons_skill_candidate'
    ]));
  });

  it('upserts sanitized first-class lessons idempotently by project and name with audit rows', async () => {
    const { store, repo, cleanup } = await createFixture();
    const releasePath = ['', 'tmp', 'customer', 'release'].join('/');
    const buildPath = ['', 'var', 'tmp', 'build-output'].join('/');
    const tokenAssignment = `${'token'}=secret-value`;
    const apiKeyAssignment = `${'api_' + 'key'}=abc123`;

    const first = await repo.upsert({
      projectHash: 'project-1',
      name: 'Release workflow',
      trigger: `When working from ${releasePath} with ${tokenAssignment}`,
      steps: ['Run npm test', `Inspect ${buildPath} before commit`],
      confidence: 0.7,
      sourceSessionIds: ['session-1', 'session-2'],
      sourceEventIds: ['event-1'],
      failureModes: [`Do not paste ${apiKeyAssignment} into reports`],
      skillCandidate: true,
      actor: 'tester'
    });

    const second = await repo.upsert({
      projectHash: 'project-1',
      name: 'Release workflow',
      trigger: 'When release validation repeats',
      steps: ['Run focused tests', 'Run full suite'],
      confidence: 0.9,
      sourceSessionIds: ['session-3', 'session-4'],
      sourceEventIds: ['event-2'],
      failureModes: ['Investigate flakes before committing'],
      skillCandidate: false,
      actor: 'tester'
    });

    const row = sqliteGet<Record<string, unknown>>(store.getDatabase(), `SELECT * FROM memory_lessons WHERE lesson_id = ?`, [first.lessonId]);
    const auditRows = sqliteAll<Record<string, unknown>>(
      store.getDatabase(),
      `SELECT operation, actor, project_hash, target_type, target_id, before_json, after_json, source_event_ids
       FROM memory_governance_audit WHERE target_type = 'lesson' ORDER BY created_at ASC`
    );
    await cleanup();

    expect(second.lessonId).toBe(first.lessonId);
    expect(second.confidence).toBe(0.9);
    expect(second.steps).toEqual(['Run focused tests', 'Run full suite']);
    expect(first.trigger).toContain('[REDACTED]');
    expect(first.steps[1]).toContain('[REDACTED]');
    expect(first.failureModes[0]).toContain('[REDACTED]');
    expect(row).toBeDefined();
    expect(JSON.parse(String(row?.steps_json))).toEqual(['Run focused tests', 'Run full suite']);
    expect(auditRows).toHaveLength(2);
    expect(auditRows[0].operation).toBe('lesson_promote');
    expect(auditRows[0].actor).toBe('tester');
    expect(auditRows[0].project_hash).toBe('project-1');
    expect(auditRows[0].target_id).toBe(first.lessonId);
    expect(auditRows[0].before_json).toBeNull();
    expect(JSON.parse(String(auditRows[0].after_json)).trigger).toContain('[REDACTED]');
    expect(JSON.parse(String(auditRows[1].before_json)).confidence).toBe(0.7);
    expect(JSON.parse(String(auditRows[1].source_event_ids))).toEqual(['event-2']);
    expect(() => MemoryLessonSchema.parse(second)).not.toThrow();
  });

  it('lists lessons by project without leaking other project or unscoped rows by default', async () => {
    const { repo, cleanup } = await createFixture();

    const projectHigh = await repo.upsert({
      projectHash: 'project-1',
      name: 'High confidence project lesson',
      trigger: 'when focused validation repeats',
      steps: ['run focused tests'],
      confidence: 0.9,
      sourceSessionIds: ['session-1', 'session-2']
    });
    const projectLow = await repo.upsert({
      projectHash: 'project-1',
      name: 'Low confidence project lesson',
      trigger: 'when docs repeat',
      steps: ['read docs'],
      confidence: 0.3,
      sourceSessionIds: ['session-3', 'session-4']
    });
    await repo.upsert({
      projectHash: 'project-2',
      name: 'Other project lesson',
      trigger: 'when other project repeats',
      steps: ['avoid leaking'],
      confidence: 1,
      sourceSessionIds: ['session-5', 'session-6']
    });
    const unscoped = await repo.upsert({
      name: 'Global lesson',
      trigger: 'when explicitly unscoped',
      steps: ['list only without project scope'],
      confidence: 1,
      sourceEventIds: ['event-global']
    });

    const projectLessons = await repo.list({ projectHash: 'project-1' });
    const unscopedLessons = await repo.list({});
    await cleanup();

    expect(projectLessons.map((lesson) => lesson.lessonId)).toEqual([projectHigh.lessonId, projectLow.lessonId]);
    expect(projectLessons.map((lesson) => lesson.name)).not.toContain('Other project lesson');
    expect(projectLessons.map((lesson) => lesson.lessonId)).not.toContain(unscoped.lessonId);
    expect(unscopedLessons.map((lesson) => lesson.lessonId)).toEqual([unscoped.lessonId]);
  });

  it('rejects cross-project updates when an existing lesson id belongs to another project', async () => {
    const { repo, cleanup } = await createFixture();
    const lesson = await repo.upsert({
      projectHash: 'project-1',
      name: 'Scoped lesson',
      trigger: 'when scoped lesson exists',
      steps: ['keep project isolation'],
      sourceEventIds: ['event-1']
    });

    await expect(repo.upsert({
      lessonId: lesson.lessonId,
      projectHash: 'project-2',
      name: 'Scoped lesson',
      trigger: 'when crossing projects',
      steps: ['reject mutation'],
      sourceEventIds: ['event-2']
    })).rejects.toThrow(/projectHash/);

    const unchanged = repo.get(lesson.lessonId);
    await cleanup();

    expect(unchanged?.projectHash).toBe('project-1');
    expect(unchanged?.trigger).toBe('when scoped lesson exists');
  });
});
