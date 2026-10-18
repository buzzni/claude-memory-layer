import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The SessionStart hook must list lessons in rankSessionStartLessons order using
 * the store's listing usage, and keep the index when usage cannot be read.
 */

const fixture = vi.hoisted(() => ({
  input: '',
  service: null as null | Record<string, ReturnType<typeof vi.fn>>
}));

vi.mock('../../src/services/memory-service.js', () => ({
  getLightweightMemoryServiceForProject: () => fixture.service,
  createMemoryService: () => fixture.service,
  getProjectStoragePath: (project: string) => `/fixture-storage${project}`,
  hashProjectPath: () => 'hash-a',
  DISABLED_SHARED_STORE_CONFIG: { enabled: false },
  getLightweightMemoryService: () => { throw new Error('cwd-bearing hooks must not use the session registry'); }
}));
vi.mock('../../src/core/registry/session-registry.js', () => ({ registerSession: vi.fn().mockReturnValue('hash-a') }));
vi.mock('../../src/adapters/claude/hooks/hook-runtime.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/adapters/claude/hooks/hook-runtime.js')>(),
  readStdin: vi.fn(async () => fixture.input)
}));
vi.mock('../../src/adapters/claude/hooks/semantic-daemon-client.js', () => ({
  ensureDaemonRunning: vi.fn().mockResolvedValue(undefined),
  scheduleSessionSummary: vi.fn().mockResolvedValue(undefined),
  retrieveSemanticMemories: vi.fn().mockResolvedValue([]),
  scheduleSemanticGraduation: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('../../src/adapters/claude/hooks/tool-observation-vector-auto-heal-client.js', () => ({
  spawnToolObservationVectorAutoHealIfNeeded: vi.fn().mockResolvedValue(undefined)
}));

function lesson(lessonId: string, name: string, confidence: number, updatedAt: string) {
  return {
    canonicalType: 'lesson',
    canonicalId: lessonId,
    value: {
      lessonId, name, trigger: `when ${name} applies`, steps: ['step'], confidence,
      sourceSessionIds: [], sourceEventIds: [], failureModes: [], skillCandidate: false, sourceClass: 'curated',
      revision: 1, recallEnabled: true, validation: [], validVersions: [],
      createdAt: new Date(updatedAt), updatedAt: new Date(updatedAt)
    }
  };
}

function createService(usage: () => Promise<Map<string, { exposures: number; engaged: number }>>) {
  return {
    startSession: vi.fn().mockResolvedValue(undefined),
    evaluatePendingSessions: vi.fn().mockResolvedValue(undefined),
    getSessionsWithoutSummary: vi.fn().mockResolvedValue([]),
    backfillMissingSummaries: vi.fn().mockResolvedValue(undefined),
    getCoreMemoryBlockInjections: vi.fn().mockResolvedValue([]),
    listProjectLessonInjections: vi.fn().mockResolvedValue([
      lesson('a', 'old-pinned-lesson', 1, '2026-09-01T00:00:00.000Z'),
      lesson('b', 'newest-lesson', 0.5, '2026-10-10T00:00:00.000Z'),
      lesson('c', 'middle-lesson', 0.9, '2026-10-01T00:00:00.000Z')
    ]),
    getSessionStartLessonUsage: vi.fn(usage),
    listProjectRunbookIds: vi.fn().mockResolvedValue(['c']),
    searchGraduatedEvidence: vi.fn().mockResolvedValue([]),
    keywordSearch: vi.fn().mockResolvedValue([]),
    getEvent: vi.fn().mockResolvedValue(null),
    getRecentEvents: vi.fn().mockResolvedValue([]),
    incrementMemoryAccess: vi.fn().mockResolvedValue(undefined),
    recordRetrieval: vi.fn().mockResolvedValue(undefined),
    recordQueryTrace: vi.fn().mockResolvedValue('trace-id'),
    recordDeliveryOutcome: vi.fn().mockResolvedValue(1),
    storeUserPrompt: vi.fn().mockResolvedValue(undefined),
    getSessionHistory: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined)
  };
}

let home: string;

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), 'cml-session-start-lessons-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('CLAUDE_MEMORY_RECALL_OWNER', '');
  vi.stubEnv('CLAUDE_MEMORY_LESSON_OWNER', '');
  vi.stubEnv('CLAUDE_MEMORY_SESSION_START_LESSON_BUDGET', '');
  vi.stubEnv('CLAUDE_MEMORY_EVAL_MODE', 'true');
  vi.stubEnv('CLAUDE_MEMORY_EVAL_DISABLE_SESSION_CONTEXT', '');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  const { reportHookDelivery } = await import('../../src/adapters/claude/hooks/hook-output.js');
  await reportHookDelivery({ status: 'failed', error: new Error('fixture cleanup') });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(home, { recursive: true, force: true });
});

async function sessionStartContext(): Promise<string> {
  fixture.input = JSON.stringify({ cwd: '/repo/a', session_id: 'session-lessons', hook_event_name: 'SessionStart', source: 'startup' });
  const { main } = await import('../../src/adapters/claude/hooks/session-start.js');
  const output = JSON.parse(await main({ persistPrompt: false, contextPresentation: 'reference' }));
  return output.hookSpecificOutput.additionalContext ?? '';
}

async function listedLessons(): Promise<string[]> {
  return [...(await sessionStartContext()).matchAll(/^- (\S+) — /gm)].map((match) => match[1]);
}

describe('SessionStart lesson index order', () => {
  it('rotates lessons by recent listings instead of confidence', async () => {
    fixture.service = createService(async () => new Map([['b', { exposures: 3, engaged: 0 }]]));

    expect(await listedLessons()).toEqual(['middle-lesson', 'old-pinned-lesson', 'newest-lesson']);
    const since = fixture.service.getSessionStartLessonUsage.mock.calls[0][0] as Date;
    expect(Date.now() - since.getTime()).toBeGreaterThan(13 * 24 * 60 * 60 * 1000);
    expect(Date.now() - since.getTime()).toBeLessThan(15 * 24 * 60 * 60 * 1000);
  });

  it('lists only runbooks when the host owns per-turn lessons, under their own trace label', async () => {
    vi.stubEnv('CLAUDE_MEMORY_LESSON_OWNER', 'host');
    // Traces are written only outside evaluation mode.
    vi.stubEnv('CLAUDE_MEMORY_EVAL_MODE', '');
    fixture.service = createService(async () => new Map());

    const context = await sessionStartContext();
    expect(context).toContain('## Project Runbooks');
    expect([...context.matchAll(/^- (\S+) — /gm)].map((match) => match[1])).toEqual(['middle-lesson']);
    expect(fixture.service.recordQueryTrace.mock.calls.map((call) => call[0])).toContainEqual(expect.objectContaining({ queryText: '[session-start] runbook index', strategy: 'session-start-lessons', selectedEventIds: ['c'] }));
  });

  it('lists nothing in host mode while the project has no runbooks', async () => {
    vi.stubEnv('CLAUDE_MEMORY_LESSON_OWNER', 'host');
    fixture.service = createService(async () => new Map());
    fixture.service.listProjectRunbookIds.mockResolvedValue([]);

    expect(await sessionStartContext()).not.toContain('## Project');
  });

  it('keeps the index, newest first, when usage cannot be read', async () => {
    fixture.service = createService(() => { throw new Error('usage unavailable'); });

    expect(await listedLessons()).toEqual(['newest-lesson', 'middle-lesson', 'old-pinned-lesson']);
  });
});
