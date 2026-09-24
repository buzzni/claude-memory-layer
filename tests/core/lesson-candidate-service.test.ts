import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LessonCandidateService,
  type ExtractedLesson,
  type LessonExtractionSource
} from '../../src/core/operations/lesson-candidate-service.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import type { MemoryEvent } from '../../src/core/types.js';

const tempDirs: string[] = [];
const baseTime = Date.parse('2026-05-20T00:00:00.000Z');

interface StubExtractor {
  (source: LessonExtractionSource): Promise<ExtractedLesson | null>;
  calls: LessonExtractionSource[];
}

/**
 * Stands in for the CLI-backed extractor. Deterministic so assertions can be
 * exact, and it records what it was handed so privacy checks can inspect the
 * transcript that would have left the process.
 */
function stubExtractor(
  result: ExtractedLesson | null = {
    name: '검증 루프를 갖춘 코드 변경 절차',
    trigger: '소스와 테스트를 함께 수정한 뒤 커밋해야 할 때',
    steps: ['변경한 파일에 해당하는 테스트를 먼저 실행한다', '타입체크와 빌드를 통과시킨다'],
    failureModes: ['검증이 통과하기 전에 커밋하지 마라']
  }
): StubExtractor {
  const calls: LessonExtractionSource[] = [];
  const extractor = async (source: LessonExtractionSource) => {
    calls.push(source);
    return result;
  };
  return Object.assign(extractor, { calls });
}

async function createFixture(
  extractor: StubExtractor = stubExtractor()
): Promise<{
  store: SQLiteEventStore;
  service: LessonCandidateService;
  extractor: StubExtractor;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-lesson-candidates-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  return {
    store,
    service: new LessonCandidateService(store.getDatabase(), { lessonExtractor: extractor }),
    extractor,
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

function implementationSession(
  sessionId: string,
  projectHash: string,
  offset: number,
  extraMetadata: Record<string, unknown> = {},
  contentSuffix = ''
): MemoryEvent[] {
  const sourceFile = ['src', 'core', 'operations', `${sessionId}-service.ts`].join('/');
  const testFile = ['tests', 'core', `${sessionId}-service.test.ts`].join('/');
  const scratchPath = ['', 'tmp', 'customer', sessionId].join('/');
  const sensitiveValue = ['fixture', 'value'].join('-');
  const tokenAssignment = `${'to' + 'ken'}=${sensitiveValue}`;
  const metadata = projectMetadata(projectHash, extraMetadata);

  return [
    memoryEvent({
      sessionId,
      eventType: 'user_prompt',
      index: offset,
      metadata,
      content: `Implement a TypeScript service touching ${sourceFile} and ${testFile} from ${scratchPath} with ${tokenAssignment}. ${contentSuffix}`
    }),
    memoryEvent({
      sessionId,
      eventType: 'tool_observation',
      index: offset + 1,
      metadata,
      content: `terminal: npm test -- --run ${testFile} completed with exit_code 0 and 5 tests passed`
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
      content: 'terminal: npm test -- --run completed with exit_code 0; 99 files and 506 tests passed'
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
      content: 'terminal: git commit -m "[verified] Add deterministic service" completed with exit_code 0'
    })
  ];
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('LessonCandidateService', () => {
  it('generates deterministic privacy-safe candidates from repeated successful project workflows', async () => {
    const { store, service, cleanup } = await createFixture();
    const projectHash = 'project-lesson-candidates';
    await store.importEvents([
      ...implementationSession('session-alpha', projectHash, 0, {}, 'Task 6 implementation.'),
      ...implementationSession('session-beta', projectHash, 20, {}, 'Task 7 implementation.'),
      ...implementationSession('session-other-project', 'other-project', 40, {}, 'Same workflow outside requested scope.')
    ]);

    const result = await service.findCandidates({ projectHash });
    await cleanup();

    expect(result.scannedSessions).toBe(2);
    expect(result.skippedSessions).toBe(0);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      projectHash,
      skillCandidate: true,
      sourceSessionIds: ['session-alpha', 'session-beta']
    });
    expect(result.candidates[0].confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.candidates[0].sourceEventIds.length).toBeGreaterThanOrEqual(4);
    // The lesson text now comes from the extractor rather than a tool-name template.
    expect(result.candidates[0].name).toBe('검증 루프를 갖춘 코드 변경 절차');
    expect(result.candidates[0].steps).toEqual([
      '변경한 파일에 해당하는 테스트를 먼저 실행한다',
      '타입체크와 빌드를 통과시킨다'
    ]);
    expect(result.candidates[0].failureModes).toEqual(['검증이 통과하기 전에 커밋하지 마라']);
    // The deterministic mining half is unchanged.
    expect(result.candidates[0].reasons.join(' ')).toContain('2 successful sessions');
    expect(result.candidates[0].pattern.tools).toEqual(expect.arrayContaining(['typecheck', 'build']));
    const serialized = JSON.stringify(result.candidates[0]);
    expect(serialized).not.toContain('fixture-value');
    expect(serialized).not.toContain('customer');
    expect(serialized).not.toContain('session-other-project');
  });

  it('redacts credentials and absolute paths before the transcript leaves the process', async () => {
    const { store, service, extractor, cleanup } = await createFixture();
    const projectHash = 'project-transcript-privacy';
    await store.importEvents([
      ...implementationSession('session-alpha', projectHash, 0, {}, 'Task 6 implementation.'),
      ...implementationSession('session-beta', projectHash, 20, {}, 'Task 7 implementation.')
    ]);

    await service.findCandidates({ projectHash });
    await cleanup();

    expect(extractor.calls).toHaveLength(1);
    const { transcript } = extractor.calls[0];
    expect(transcript.length).toBeGreaterThan(0);
    expect(transcript).not.toContain('fixture-value');
    expect(transcript).not.toContain('customer');
    // Sessions are labelled positionally rather than by id. (The fixture names
    // its source files after the session, so the id still legitimately appears
    // inside relative paths — what must not appear is a session-id heading.)
    expect(transcript).toContain('## 세션 1');
    expect(transcript).toContain('## 세션 2');
    expect(transcript).not.toMatch(/^##\s+session-/m);
  });

  it('sanitizes lesson text the extractor returns', async () => {
    const leaky = stubExtractor({
      name: 'Leaky lesson',
      trigger: 'When configuring the client with token=super-secret-value',
      steps: ['Read the config from /Users/someone/private/config.json'],
      failureModes: []
    });
    const { store, service, cleanup } = await createFixture(leaky);
    const projectHash = 'project-output-sanitize';
    await store.importEvents([
      ...implementationSession('session-alpha', projectHash, 0),
      ...implementationSession('session-beta', projectHash, 20)
    ]);

    const result = await service.findCandidates({ projectHash });
    await cleanup();

    expect(result.candidates).toHaveLength(1);
    const serialized = JSON.stringify(result.candidates[0]);
    expect(serialized).not.toContain('super-secret-value');
    expect(serialized).not.toContain('/Users/someone');
    expect(serialized).toContain('[REDACTED]');
  });

  it('omits the candidate when no lesson text can be produced', async () => {
    const { store, service, cleanup } = await createFixture(stubExtractor(null));
    const projectHash = 'project-no-extraction';
    await store.importEvents([
      ...implementationSession('session-alpha', projectHash, 0),
      ...implementationSession('session-beta', projectHash, 20)
    ]);

    const result = await service.findCandidates({ projectHash });
    await cleanup();

    // The grouping still succeeded; only the text is missing, and templated
    // filler is exactly what this path must not fall back to.
    expect(result.eligibleSessions).toBe(2);
    expect(result.groupedPatterns).toBe(1);
    expect(result.candidates).toEqual([]);
  });

  it('omits the candidate when the extractor throws', async () => {
    const failing = Object.assign(
      async (source: LessonExtractionSource) => {
        failing.calls.push(source);
        throw new Error('provider CLI was not found');
      },
      { calls: [] as LessonExtractionSource[] }
    );
    const { store, service, cleanup } = await createFixture(failing);
    const projectHash = 'project-extractor-throws';
    await store.importEvents([
      ...implementationSession('session-alpha', projectHash, 0),
      ...implementationSession('session-beta', projectHash, 20)
    ]);

    const result = await service.findCandidates({ projectHash });
    await cleanup();

    expect(failing.calls).toHaveLength(1);
    expect(result.candidates).toEqual([]);
  });

  it('caches the no-lesson verdict so listings stop re-running the extractor for the same group', async () => {
    const { store, service, extractor, cleanup } = await createFixture(stubExtractor(null));
    const projectHash = 'project-negative-cache';
    await store.importEvents([
      ...implementationSession('session-alpha', projectHash, 0),
      ...implementationSession('session-beta', projectHash, 20)
    ]);

    const first = await service.findCandidates({ projectHash });
    const second = await service.findCandidates({ projectHash });
    await cleanup();

    // One subprocess-equivalent run total: the verdict is as deterministic as
    // a positive extraction for the same fingerprint.
    expect(extractor.calls).toHaveLength(1);
    expect(first.extraction).toMatchObject({ freshAttempts: 1, noLesson: 1 });
    expect(second.extraction).toMatchObject({ freshAttempts: 0, cacheHits: 1, noLesson: 1 });
    expect(second.candidates).toEqual([]);
  });

  it('does not cache a thrown provider failure, so the next listing retries', async () => {
    const failing = Object.assign(
      async (source: LessonExtractionSource) => {
        failing.calls.push(source);
        throw new Error('provider CLI was not found');
      },
      { calls: [] as LessonExtractionSource[] }
    );
    const { store, service, cleanup } = await createFixture(failing);
    const projectHash = 'project-transient-failure';
    await store.importEvents([
      ...implementationSession('session-alpha', projectHash, 0),
      ...implementationSession('session-beta', projectHash, 20)
    ]);

    const first = await service.findCandidates({ projectHash });
    const second = await service.findCandidates({ projectHash });
    await cleanup();

    expect(failing.calls).toHaveLength(2);
    expect(first.extraction.failures).toBe(1);
    expect(second.extraction.failures).toBe(1);
  });

  it('backfills from lower-ranked groups when a higher-ranked group yields no lesson', async () => {
    // Two distinct groups: the full workflow ranks first (more shared tools);
    // the extractor rejects it and accepts the reduced workflow. With the old
    // slice-before-extract order, limit=1 returned nothing at all.
    const selective = Object.assign(
      async (source: LessonExtractionSource) => {
        selective.calls.push(source);
        if (source.tools.includes('build')) return null;
        return {
          name: '백필 절차',
          trigger: '하위 그룹',
          steps: ['검증한다'],
          failureModes: []
        };
      },
      { calls: [] as LessonExtractionSource[] }
    );
    const { store, service, cleanup } = await createFixture(selective);
    const projectHash = 'project-backfill';
    const withoutBuild = (sessionId: string, offset: number): MemoryEvent[] =>
      implementationSession(sessionId, projectHash, offset)
        .filter((event) => !event.content.includes('npm run build'));
    await store.importEvents([
      ...implementationSession('session-full-a', projectHash, 0),
      ...implementationSession('session-full-b', projectHash, 20),
      ...withoutBuild('session-lite-a', 40),
      ...withoutBuild('session-lite-b', 60)
    ]);

    const result = await service.findCandidates({ projectHash, limit: 1 });
    await cleanup();

    expect(result.groupedPatterns).toBe(2);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].name).toBe('백필 절차');
    expect(result.extraction).toMatchObject({ freshAttempts: 2, noLesson: 1 });
  });

  it('caps fresh extractions per call and reports the skipped groups', async () => {
    const { store, service, extractor, cleanup } = await createFixture();
    const projectHash = 'project-budget';
    const withoutBuild = (sessionId: string, offset: number): MemoryEvent[] =>
      implementationSession(sessionId, projectHash, offset)
        .filter((event) => !event.content.includes('npm run build'));
    await store.importEvents([
      ...implementationSession('session-full-a', projectHash, 0),
      ...implementationSession('session-full-b', projectHash, 20),
      ...withoutBuild('session-lite-a', 40),
      ...withoutBuild('session-lite-b', 60)
    ]);

    const first = await service.findCandidates({ projectHash, maxFreshExtractions: 1 });
    // The second call serves the first group from cache and spends its budget
    // on the group the first call skipped.
    const second = await service.findCandidates({ projectHash, maxFreshExtractions: 1 });
    await cleanup();

    expect(first.candidates).toHaveLength(1);
    expect(first.extraction).toMatchObject({ freshAttempts: 1, skippedByBudget: 1 });
    expect(extractor.calls).toHaveLength(2);
    expect(second.candidates).toHaveLength(2);
    expect(second.extraction).toMatchObject({ cacheHits: 1, freshAttempts: 1, skippedByBudget: 0 });
  });

  it('reports cache misses that could not run because no extractor is wired', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cml-lesson-candidates-'));
    tempDirs.push(dir);
    const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
    await store.initialize();
    const service = new LessonCandidateService(store.getDatabase());
    const projectHash = 'project-no-extractor';
    await store.importEvents([
      ...implementationSession('session-alpha', projectHash, 0),
      ...implementationSession('session-beta', projectHash, 20)
    ]);

    const result = await service.findCandidates({ projectHash });
    await store.close();

    expect(result.candidates).toEqual([]);
    expect(result.extraction.skippedNoExtractor).toBe(1);
  });

  it('reuses the cached extraction so review and promotion see the same text', async () => {
    const { store, service, extractor, cleanup } = await createFixture();
    const projectHash = 'project-extraction-cache';
    await store.importEvents([
      ...implementationSession('session-alpha', projectHash, 0),
      ...implementationSession('session-beta', projectHash, 20)
    ]);

    const first = await service.findCandidates({ projectHash });
    const second = await service.findCandidates({ projectHash });
    await cleanup();

    expect(extractor.calls).toHaveLength(1);
    expect(second.candidates).toEqual(first.candidates);
  });

  it('re-extracts once a new session joins the group', async () => {
    const { store, service, extractor, cleanup } = await createFixture();
    const projectHash = 'project-extraction-refresh';
    await store.importEvents([
      ...implementationSession('session-alpha', projectHash, 0),
      ...implementationSession('session-beta', projectHash, 20)
    ]);
    await service.findCandidates({ projectHash });

    await store.importEvents([...implementationSession('session-gamma', projectHash, 40)]);
    const refreshed = await service.findCandidates({ projectHash });
    await cleanup();

    expect(extractor.calls).toHaveLength(2);
    expect(refreshed.candidates[0].sourceSessionIds).toEqual([
      'session-alpha',
      'session-beta',
      'session-gamma'
    ]);
  });

  it('requires at least two successful sessions with source refs', async () => {
    const { store, service, cleanup } = await createFixture();
    const projectHash = 'project-success-required';
    const failedSession = implementationSession('session-failed', projectHash, 20).map((event) => (
      event.content.includes('exit_code 0') || event.content.includes('passed') || event.content.includes('[verified]')
        ? { ...event, content: event.content.replace(/exit_code 0/g, 'exit_code 1').replace(/passed/g, 'failed').replace('[verified]', '[blocked]') }
        : event
    ));
    await store.importEvents([
      ...implementationSession('session-single-success', projectHash, 0),
      ...failedSession
    ]);

    const result = await service.findCandidates({ projectHash });
    await cleanup();

    expect(result.candidates).toHaveLength(0);
    expect(result.skippedSessions).toBeGreaterThanOrEqual(1);
  });

  it('skips sessions with active privacy or quarantine conflicts', async () => {
    const { store, service, cleanup } = await createFixture();
    const projectHash = 'project-privacy-conflict';
    await store.importEvents([
      ...implementationSession('session-clean', projectHash, 0),
      ...implementationSession('session-private', projectHash, 20, { private: true }),
      ...implementationSession('session-quarantined', projectHash, 40, { quarantine: { status: 'active', reason: 'manual review' } })
    ]);

    const result = await service.findCandidates({ projectHash });
    await cleanup();

    expect(result.scannedSessions).toBe(3);
    expect(result.skippedSessions).toBe(2);
    expect(result.candidates).toHaveLength(0);
  });
});

describe('LessonCandidateService failure recovery semantics', () => {
  it('keeps sessions that hit a failure and then recovered', async () => {
    const { store, service, cleanup } = await createFixture();
    const projectHash = 'project-recovery';
    const withEarlyFailure = (sessionId: string, offset: number): MemoryEvent[] => [
      memoryEvent({
        sessionId,
        eventType: 'tool_observation',
        index: offset - 1,
        metadata: projectMetadata(projectHash),
        content: 'terminal: npm test -- --run failed with exit_code 1; 2 tests failed'
      }),
      ...implementationSession(sessionId, projectHash, offset)
    ];

    await store.importEvents([
      ...withEarlyFailure('session-recovered-a', 1),
      ...withEarlyFailure('session-recovered-b', 21)
    ]);

    const result = await service.findCandidates({ projectHash });
    await cleanup();

    // The whole-session failure veto used to drop exactly these sessions, which
    // are the ones worth learning from.
    expect(result.eligibleSessions).toBe(2);
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it('drops sessions whose last signal is still a failure', async () => {
    const { store, service, cleanup } = await createFixture();
    const projectHash = 'project-unrecovered';
    const endingInFailure = (sessionId: string, offset: number): MemoryEvent[] => [
      ...implementationSession(sessionId, projectHash, offset),
      memoryEvent({
        sessionId,
        eventType: 'tool_observation',
        index: offset + 10,
        metadata: projectMetadata(projectHash),
        content: 'terminal: npm run build failed with exit_code 1'
      })
    ];

    await store.importEvents([
      ...endingInFailure('session-broken-a', 1),
      ...endingInFailure('session-broken-b', 21)
    ]);

    const result = await service.findCandidates({ projectHash });
    await cleanup();

    expect(result.eligibleSessions).toBe(0);
    expect(result.candidates).toEqual([]);
  });

  it('scans the most recent events rather than the oldest window', async () => {
    const { store, service, cleanup } = await createFixture();
    const projectHash = 'project-recent-window';
    const filler: MemoryEvent[] = Array.from({ length: 30 }, (_, index) => memoryEvent({
      sessionId: `session-ancient-${index}`,
      eventType: 'user_prompt',
      index,
      metadata: projectMetadata(projectHash),
      content: 'ancient unrelated chatter'
    }));

    await store.importEvents([
      ...filler,
      ...implementationSession('session-recent-a', projectHash, 100),
      ...implementationSession('session-recent-b', projectHash, 120)
    ]);

    // A window smaller than the whole corpus must still reach the newest work.
    const result = await service.findCandidates({ projectHash, eventLimit: 20 });
    await cleanup();

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0].sourceSessionIds).toEqual(['session-recent-a', 'session-recent-b']);
  });
});
