import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Before and after a compaction: PreCompact saves a checkpoint into the real
 * project store, and the SessionStart that Claude Code fires with
 * source "compact" puts it back, once, ahead of the usual recap.
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

const LAST_PROMPT = 'Wire the PreCompact hook into install';
const LAST_ANSWER = 'Registered PreCompact next to the other five hooks.';
const PAST_ANSWER = 'Past-session answer: releases go through publish-npm.yml on tag push.';

function answer(id: string, sessionId: string, content: string, timestamp: Date) {
  return { id, eventType: 'agent_response', sessionId, content, timestamp, metadata: {} };
}

function createService(recentEvents: unknown[]) {
  return {
    startSession: vi.fn().mockResolvedValue(undefined),
    getSessionsWithoutSummary: vi.fn().mockResolvedValue([]),
    backfillMissingSummaries: vi.fn().mockResolvedValue(undefined),
    getCoreMemoryBlockInjections: vi.fn().mockResolvedValue([]),
    listProjectLessonInjections: vi.fn().mockResolvedValue([]),
    getSessionStartLessonUsage: vi.fn().mockResolvedValue(new Map()),
    listProjectRunbookIds: vi.fn().mockResolvedValue([]),
    getRecentEvents: vi.fn().mockResolvedValue(recentEvents),
    recordRetrieval: vi.fn().mockResolvedValue(undefined),
    recordQueryTrace: vi.fn().mockResolvedValue('trace-id'),
    recordDeliveryOutcome: vi.fn().mockResolvedValue(1),
    close: vi.fn().mockResolvedValue(undefined)
  };
}

let home: string;
let project: string;

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), 'cml-session-start-compaction-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('CLAUDE_MEMORY_RECALL_OWNER', '');
  vi.stubEnv('CLAUDE_MEMORY_LESSON_OWNER', '');
  vi.stubEnv('CLAUDE_MEMORY_EVAL_MODE', 'true');
  vi.stubEnv('CLAUDE_MEMORY_EVAL_DISABLE_SESSION_CONTEXT', '');
  vi.stubEnv('CLAUDE_MEMORY_INJECT_SAME_SESSION', '');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  project = join(home, 'repo');
  mkdirSync(project);
});

afterEach(async () => {
  const { reportHookDelivery } = await import('../../src/adapters/claude/hooks/hook-output.js');
  await reportHookDelivery({ status: 'failed', error: new Error('fixture cleanup') });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(home, { recursive: true, force: true });
});

/** Stores one turn of session-now and returns its agent_response event. */
async function seedCurrentSession() {
  const { getProjectStoragePath } = await import('../../src/core/registry/project-path.js');
  const { SQLiteEventStore } = await import('../../src/core/sqlite-event-store.js');
  const storagePath = getProjectStoragePath(project);
  mkdirSync(storagePath, { recursive: true });
  const store = new SQLiteEventStore(join(storagePath, 'events.sqlite'));
  try {
    const at = new Date(Date.now() - 60_000);
    await store.append({ eventType: 'user_prompt', sessionId: 'session-now', timestamp: at, content: LAST_PROMPT, metadata: { turnId: 't1' } });
    const response = await store.append({
      eventType: 'agent_response', sessionId: 'session-now', timestamp: new Date(at.getTime() + 1000), content: LAST_ANSWER, metadata: { turnId: 't1' }
    });
    return answer(response.eventId!, 'session-now', LAST_ANSWER, new Date(at.getTime() + 1000));
  } finally {
    await store.close();
  }
}

async function preCompact(): Promise<string> {
  fixture.input = JSON.stringify({ session_id: 'session-now', cwd: project, hook_event_name: 'PreCompact', trigger: 'auto' });
  const { main } = await import('../../src/adapters/claude/hooks/pre-compact.js');
  return main();
}

async function sessionStartContext(source: string): Promise<string> {
  fixture.input = JSON.stringify({ cwd: project, session_id: 'session-now', hook_event_name: 'SessionStart', source });
  const { main } = await import('../../src/adapters/claude/hooks/session-start.js');
  const output = JSON.parse(await main());
  return output.hookSpecificOutput.additionalContext ?? '';
}

describe('SessionStart after a compaction', () => {
  it('re-injects the PreCompact checkpoint first, without repeating its events in the recap', async () => {
    const ownAnswer = await seedCurrentSession();
    fixture.service = createService([
      ownAnswer,
      answer('past', 'session-past', PAST_ANSWER, new Date(Date.now() - 86_400_000))
    ]);

    expect(await preCompact()).toBe('');
    const context = await sessionStartContext('compact');

    expect(context.startsWith('## Before Compaction')).toBe(true);
    expect(context).toContain(LAST_PROMPT);
    expect(context.split(LAST_ANSWER)).toHaveLength(2);
    expect(context).toContain(PAST_ANSWER);
  });

  it('adds nothing when PreCompact left no checkpoint', async () => {
    fixture.service = createService([answer('past', 'session-past', PAST_ANSWER, new Date(Date.now() - 86_400_000))]);

    const context = await sessionStartContext('compact');

    expect(context).not.toContain('Before Compaction');
    expect(context).toContain(PAST_ANSWER);
  });

  it.each(['startup', 'resume', 'clear'])('does not inject the checkpoint on %s', async (source) => {
    await seedCurrentSession();
    fixture.service = createService([]);
    await preCompact();

    expect(await sessionStartContext(source)).not.toContain('Before Compaction');
  });

  it('respects CLAUDE_MEMORY_EVAL_DISABLE_SESSION_CONTEXT', async () => {
    await seedCurrentSession();
    fixture.service = createService([]);
    await preCompact();
    vi.stubEnv('CLAUDE_MEMORY_EVAL_DISABLE_SESSION_CONTEXT', 'true');

    expect(await sessionStartContext('compact')).toBe('');
  });
});
