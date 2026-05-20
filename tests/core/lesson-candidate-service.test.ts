import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { LessonCandidateService } from '../../src/core/operations/lesson-candidate-service.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import type { MemoryEvent } from '../../src/core/types.js';

const tempDirs: string[] = [];
const baseTime = Date.parse('2026-05-20T00:00:00.000Z');

async function createFixture(): Promise<{ store: SQLiteEventStore; service: LessonCandidateService; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-lesson-candidates-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  return { store, service: new LessonCandidateService(store.getDatabase()), cleanup: async () => store.close() };
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
    expect(result.candidates[0].steps).toEqual(expect.arrayContaining([
      'Run focused tests for the changed files',
      'Run typecheck',
      'Run build',
      'Run the full test suite',
      'Run the static/privacy scan',
      'Commit verified changes'
    ]));
    expect(result.candidates[0].reasons.join(' ')).toContain('2 successful sessions');
    const serialized = JSON.stringify(result.candidates[0]);
    expect(serialized).not.toContain('fixture-value');
    expect(serialized).not.toContain('customer');
    expect(serialized).not.toContain('session-other-project');
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
