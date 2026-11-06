import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A resumed session reloads its own transcript, so SessionStart must not spend
 * the recent-memory slots on that session's events. After a compaction the
 * transcript is only a summary, so those events stay eligible.
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

const OWN_ANSWER = 'Own-session answer: the replay A/B ran on two store copies.';
const PAST_ANSWER = 'Past-session answer: releases go through publish-npm.yml on tag push.';

function answer(id: string, sessionId: string, content: string, timestamp: string) {
  return { id, eventType: 'agent_response', sessionId, content, timestamp: new Date(timestamp), metadata: {} };
}

function createService() {
  return {
    startSession: vi.fn().mockResolvedValue(undefined),
    getSessionsWithoutSummary: vi.fn().mockResolvedValue([]),
    backfillMissingSummaries: vi.fn().mockResolvedValue(undefined),
    getCoreMemoryBlockInjections: vi.fn().mockResolvedValue([]),
    listProjectLessonInjections: vi.fn().mockResolvedValue([]),
    getSessionStartLessonUsage: vi.fn().mockResolvedValue(new Map()),
    listProjectRunbookIds: vi.fn().mockResolvedValue([]),
    getRecentEvents: vi.fn().mockResolvedValue([
      answer('own', 'session-now', OWN_ANSWER, '2026-11-07T01:00:00.000Z'),
      answer('past', 'session-past', PAST_ANSWER, '2026-11-01T01:00:00.000Z')
    ]),
    recordRetrieval: vi.fn().mockResolvedValue(undefined),
    recordQueryTrace: vi.fn().mockResolvedValue('trace-id'),
    recordDeliveryOutcome: vi.fn().mockResolvedValue(1),
    close: vi.fn().mockResolvedValue(undefined)
  };
}

let home: string;

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), 'cml-session-start-resume-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('CLAUDE_MEMORY_RECALL_OWNER', '');
  vi.stubEnv('CLAUDE_MEMORY_LESSON_OWNER', '');
  vi.stubEnv('CLAUDE_MEMORY_EVAL_MODE', 'true');
  vi.stubEnv('CLAUDE_MEMORY_EVAL_DISABLE_SESSION_CONTEXT', '');
  vi.stubEnv('CLAUDE_MEMORY_INJECT_SAME_SESSION', '');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  fixture.service = createService();
});

afterEach(async () => {
  const { reportHookDelivery } = await import('../../src/adapters/claude/hooks/hook-output.js');
  await reportHookDelivery({ status: 'failed', error: new Error('fixture cleanup') });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(home, { recursive: true, force: true });
});

async function sessionStartContext(source: string): Promise<string> {
  fixture.input = JSON.stringify({ cwd: '/repo/a', session_id: 'session-now', hook_event_name: 'SessionStart', source });
  const { main } = await import('../../src/adapters/claude/hooks/session-start.js');
  const output = JSON.parse(await main({ persistPrompt: false }));
  return output.hookSpecificOutput.additionalContext ?? '';
}

describe('SessionStart recent memories by start source', () => {
  it('leaves out the session’s own events on resume', async () => {
    const context = await sessionStartContext('resume');

    expect(context).toContain(PAST_ANSWER);
    expect(context).not.toContain(OWN_ANSWER);
  });

  it('keeps the session’s own events after a compaction', async () => {
    const context = await sessionStartContext('compact');

    expect(context).toContain(OWN_ANSWER);
    expect(context).toContain(PAST_ANSWER);
  });

  it('keeps them on resume when CLAUDE_MEMORY_INJECT_SAME_SESSION=true', async () => {
    vi.stubEnv('CLAUDE_MEMORY_INJECT_SAME_SESSION', 'true');

    expect(await sessionStartContext('resume')).toContain(OWN_ANSWER);
  });
});
