import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { LessonCandidateService, LessonService, type LessonCandidate } from '../../src/core/operations/index.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteAll, sqliteGet } from '../../src/core/sqlite-wrapper.js';
import type { MemoryEvent } from '../../src/core/types.js';

const tempDirs: string[] = [];
const baseTime = Date.parse('2026-05-20T06:00:00.000Z');

async function createFixture(): Promise<{
  store: SQLiteEventStore;
  candidateService: LessonCandidateService;
  lessonService: LessonService;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-lesson-service-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  return {
    store,
    candidateService: new LessonCandidateService(store.getDatabase()),
    lessonService: new LessonService(store.getDatabase()),
    cleanup: async () => store.close()
  };
}

function projectMetadata(projectHash: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope: { project: { hash: projectHash } },
    ...extra
  };
}

function memoryEvent(input: {
  sessionId: string;
  eventType: MemoryEvent['eventType'];
  content: string;
  index: number;
  metadata?: Record<string, unknown>;
}): MemoryEvent {
  const id = randomUUID();
  return {
    id,
    eventType: input.eventType,
    sessionId: input.sessionId,
    timestamp: new Date(baseTime + input.index * 60_000),
    content: input.content,
    canonicalKey: `event:${id}`,
    dedupeKey: `dedupe:${id}`,
    metadata: input.metadata ?? {}
  };
}

function implementationSession(sessionId: string, projectHash: string, offset: number): MemoryEvent[] {
  const sourceFile = ['src', 'core', 'operations', `${sessionId}-service.ts`].join('/');
  const testFile = ['tests', 'core', `${sessionId}-service.test.ts`].join('/');
  const metadata = projectMetadata(projectHash);
  return [
    memoryEvent({
      sessionId,
      eventType: 'user_prompt',
      index: offset,
      metadata,
      content: `Implement a TypeScript service touching ${sourceFile} and ${testFile}.`
    }),
    memoryEvent({
      sessionId,
      eventType: 'tool_observation',
      index: offset + 1,
      metadata,
      content: `terminal: npm test -- --run ${testFile} completed with exit_code 0 and 4 tests passed`
    }),
    memoryEvent({
      sessionId,
      eventType: 'tool_observation',
      index: offset + 2,
      metadata,
      content: 'terminal: npm run typecheck completed with exit_code 0'
    }),
    memoryEvent({
      sessionId,
      eventType: 'tool_observation',
      index: offset + 3,
      metadata,
      content: 'terminal: npm run build completed with exit_code 0'
    }),
    memoryEvent({
      sessionId,
      eventType: 'tool_observation',
      index: offset + 4,
      metadata,
      content: 'terminal: npm test -- --run completed with exit_code 0; 100 files and 509 tests passed'
    }),
    memoryEvent({
      sessionId,
      eventType: 'tool_observation',
      index: offset + 5,
      metadata,
      content: 'terminal: staged static/privacy scan completed with STAGED_STATIC_SCAN_FINDINGS=0'
    }),
    memoryEvent({
      sessionId,
      eventType: 'tool_observation',
      index: offset + 6,
      metadata,
      content: 'terminal: git commit -m "[verified] Add service" completed with exit_code 0'
    })
  ];
}

function reviewedCandidate(input: Partial<LessonCandidate> & { projectHash: string; sourceEventIds: string[] }): LessonCandidate {
  return {
    candidateId: input.candidateId ?? `candidate:${randomUUID()}`,
    projectHash: input.projectHash,
    name: input.name ?? 'Workflow pattern: reviewed validation',
    trigger: input.trigger ?? 'When validation workflow repeats',
    steps: input.steps ?? ['Run focused tests', 'Run typecheck', 'Commit verified changes'],
    confidence: input.confidence ?? 0.92,
    sourceSessionIds: input.sourceSessionIds ?? ['session-reviewed-a', 'session-reviewed-b'],
    sourceEventIds: input.sourceEventIds,
    failureModes: input.failureModes ?? ['Do not promote without checking source refs'],
    skillCandidate: input.skillCandidate ?? true,
    pattern: input.pattern ?? {
      tools: ['focused-test', 'typecheck', 'verified-commit'],
      fileCategories: ['source:ts', 'test:ts'],
      taskPatterns: ['code-change', 'validation']
    },
    reasons: input.reasons ?? ['Reviewed candidate payload']
  };
}

function lessonRows(store: SQLiteEventStore): Array<Record<string, unknown>> {
  return sqliteAll<Record<string, unknown>>(store.getDatabase(), `SELECT * FROM memory_lessons ORDER BY updated_at ASC`);
}

function auditRows(store: SQLiteEventStore): Array<Record<string, unknown>> {
  return sqliteAll<Record<string, unknown>>(
    store.getDatabase(),
    `SELECT operation, actor, project_hash, target_type, target_id, source_event_ids, after_json
     FROM memory_governance_audit ORDER BY created_at ASC`
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('LessonService manual promotion', () => {
  it('promotes an explicitly approved generated candidate with source refs and one audit row', async () => {
    const { store, candidateService, lessonService, cleanup } = await createFixture();
    const projectHash = 'project-promote-generated';
    await store.importEvents([
      ...implementationSession('session-alpha', projectHash, 0),
      ...implementationSession('session-beta', projectHash, 20),
      ...implementationSession('session-other', 'other-project', 40)
    ]);
    const candidate = (await candidateService.findCandidates({ projectHash })).candidates[0];

    const lesson = await lessonService.promoteCandidate({
      projectHash,
      candidateId: candidate.candidateId,
      actor: 'reviewer',
      approved: true
    });
    const storedLessons = lessonRows(store);
    const storedAuditRows = auditRows(store);
    await cleanup();

    expect(lesson.projectHash).toBe(projectHash);
    expect(lesson.name).toBe(candidate.name);
    expect(lesson.trigger).toBe(candidate.trigger);
    expect(lesson.steps).toEqual(candidate.steps);
    expect(lesson.sourceSessionIds).toEqual(candidate.sourceSessionIds);
    expect(lesson.sourceEventIds).toEqual(candidate.sourceEventIds);
    expect(storedLessons).toHaveLength(1);
    expect(storedAuditRows).toHaveLength(1);
    expect(storedAuditRows[0]).toMatchObject({
      operation: 'lesson_promote',
      actor: 'reviewer',
      project_hash: projectHash,
      target_type: 'lesson',
      target_id: lesson.lessonId
    });
    expect(JSON.parse(String(storedAuditRows[0].source_event_ids))).toEqual(candidate.sourceEventIds);
  });

  it('rejects unapproved low-confidence promotion requests before mutating lessons or audit rows', async () => {
    const { store, lessonService, cleanup } = await createFixture();
    const projectHash = 'project-requires-approval';
    const sourceEvent = memoryEvent({
      sessionId: 'session-source',
      eventType: 'tool_observation',
      index: 0,
      metadata: projectMetadata(projectHash),
      content: 'terminal: npm run typecheck completed with exit_code 0'
    });
    await store.importEvents([sourceEvent]);

    await expect(lessonService.promoteCandidate({
      projectHash,
      actor: 'reviewer',
      approved: false,
      candidate: reviewedCandidate({
        projectHash,
        confidence: 0.72,
        sourceEventIds: [sourceEvent.id]
      })
    })).rejects.toThrow(/explicit approval|high-confidence/i);
    const storedLessons = lessonRows(store);
    const storedAuditRows = auditRows(store);
    await cleanup();

    expect(storedLessons).toHaveLength(0);
    expect(storedAuditRows).toHaveLength(0);
  });

  it('promotes high-confidence reviewed payloads idempotently while sanitizing persisted lesson fields', async () => {
    const { store, lessonService, cleanup } = await createFixture();
    const projectHash = 'project-reviewed-payload';
    const sourceEvents = [
      memoryEvent({
        sessionId: 'session-reviewed-a',
        eventType: 'tool_observation',
        index: 0,
        metadata: projectMetadata(projectHash),
        content: 'terminal: npm test -- --run completed with exit_code 0'
      }),
      memoryEvent({
        sessionId: 'session-reviewed-b',
        eventType: 'tool_observation',
        index: 1,
        metadata: projectMetadata(projectHash),
        content: 'terminal: git commit -m "[verified] Add service" completed with exit_code 0'
      })
    ];
    await store.importEvents(sourceEvents);
    const scratchPath = ['', 'tmp', 'customer', 'reviewed-work'].join('/');
    const tokenAssignment = `${'to' + 'ken'}=${['fixture', 'value'].join('-')}`;
    const candidate = reviewedCandidate({
      candidateId: 'candidate-reviewed-payload',
      projectHash,
      name: 'Workflow pattern: reviewed payload',
      trigger: `When reviewed workflow repeats from ${scratchPath} with ${tokenAssignment}`,
      steps: [`Inspect ${scratchPath}`, 'Run focused tests'],
      confidence: 0.95,
      sourceEventIds: sourceEvents.map((event) => event.id),
      failureModes: [`Do not paste ${tokenAssignment} in reports`]
    });

    const first = await lessonService.promoteCandidate({
      projectHash,
      actor: 'auto-rule',
      candidate,
      allowHighConfidenceRule: true,
      minHighConfidence: 0.9
    });
    const second = await lessonService.promoteCandidate({
      projectHash,
      actor: 'auto-rule',
      candidate: { ...candidate, steps: [...candidate.steps, 'Run full suite'] },
      allowHighConfidenceRule: true,
      minHighConfidence: 0.9
    });
    const storedLesson = sqliteGet<Record<string, unknown>>(store.getDatabase(), `SELECT * FROM memory_lessons WHERE lesson_id = ?`, [first.lessonId]);
    const storedAuditRows = auditRows(store);
    await cleanup();

    expect(second.lessonId).toBe(first.lessonId);
    expect(second.steps).toEqual(['Inspect [REDACTED]', 'Run focused tests', 'Run full suite']);
    expect(JSON.parse(String(storedLesson?.steps_json))).toEqual(['Inspect [REDACTED]', 'Run focused tests', 'Run full suite']);
    expect(second.trigger).toContain('[REDACTED]');
    expect(second.failureModes[0]).toContain('[REDACTED]');
    expect(storedAuditRows).toHaveLength(2);
    expect(JSON.parse(String(storedAuditRows[1].after_json)).steps).toEqual(second.steps);
  });

  it('rejects source events marked by the privacy filter before writing', async () => {
    const { store, lessonService, cleanup } = await createFixture();
    const projectHash = 'project-privacy-filtered-source';
    const filteredEvent = memoryEvent({
      sessionId: 'session-filtered-source',
      eventType: 'tool_observation',
      index: 0,
      metadata: projectMetadata(projectHash, {
        privacy: {
          hasPrivateTags: true,
          privateTagCount: 1,
          patternMatchCount: 0,
          hasUnmatchedTags: false
        }
      }),
      content: 'terminal: npm run typecheck completed with exit_code 0'
    });
    await store.importEvents([filteredEvent]);

    await expect(lessonService.promoteCandidate({
      projectHash,
      actor: 'reviewer',
      approved: true,
      candidate: reviewedCandidate({
        projectHash,
        sourceEventIds: [filteredEvent.id]
      })
    })).rejects.toThrow(/privacy conflict/i);
    const storedLessons = lessonRows(store);
    const storedAuditRows = auditRows(store);
    await cleanup();

    expect(storedLessons).toHaveLength(0);
    expect(storedAuditRows).toHaveLength(0);
  });

  it('rejects cross-project candidate payloads or source refs before writing', async () => {
    const { store, lessonService, cleanup } = await createFixture();
    const projectA = 'project-source-a';
    const projectB = 'project-source-b';
    const foreignEvent = memoryEvent({
      sessionId: 'session-foreign',
      eventType: 'tool_observation',
      index: 0,
      metadata: projectMetadata(projectA),
      content: 'terminal: npm run build completed with exit_code 0'
    });
    await store.importEvents([foreignEvent]);

    await expect(lessonService.promoteCandidate({
      projectHash: projectB,
      actor: 'reviewer',
      approved: true,
      candidate: reviewedCandidate({
        projectHash: projectB,
        sourceEventIds: [foreignEvent.id]
      })
    })).rejects.toThrow(/source event.*project/i);
    await expect(lessonService.promoteCandidate({
      projectHash: projectB,
      actor: 'reviewer',
      approved: true,
      candidate: reviewedCandidate({
        projectHash: projectA,
        sourceEventIds: [foreignEvent.id]
      })
    })).rejects.toThrow(/candidate projectHash/i);
    const storedLessons = lessonRows(store);
    const storedAuditRows = auditRows(store);
    await cleanup();

    expect(storedLessons).toHaveLength(0);
    expect(storedAuditRows).toHaveLength(0);
  });
});
