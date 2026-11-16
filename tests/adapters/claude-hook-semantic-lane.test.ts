import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/**
 * What the UserPromptSubmit hook asks of the semantic daemon, and what it
 * records when the daemon does not answer. A timeout, a daemon that is not
 * running and a search that found nothing all used to be stored as
 * `vector: 0`, so a dead lane looked the same as an empty one.
 */

const service = {
  evaluatePendingSessions: vi.fn().mockResolvedValue(undefined),
  searchGraduatedEvidence: vi.fn().mockResolvedValue([]),
  listProjectLessonInjections: vi.fn().mockResolvedValue([]),
  keywordSearch: vi.fn().mockResolvedValue([]),
  getEvent: vi.fn().mockResolvedValue(null),
  getRecentEvents: vi.fn().mockResolvedValue([]),
  incrementMemoryAccess: vi.fn().mockResolvedValue(undefined),
  recordRetrieval: vi.fn().mockResolvedValue(undefined),
  recordQueryTrace: vi.fn().mockResolvedValue('trace-id'),
  recordDeliveryOutcome: vi.fn().mockResolvedValue(1),
  storeUserPrompt: vi.fn().mockResolvedValue(undefined),
  getSessionHistory: vi.fn().mockResolvedValue([])
};
const daemon = vi.hoisted(() => ({ retrieve: vi.fn() }));

vi.mock('../../src/services/memory-service.js', () => ({
  getLightweightMemoryService: () => service,
  getLightweightMemoryServiceForProject: () => service
}));
vi.mock('../../src/adapters/claude/hooks/semantic-daemon-client.js', () => ({
  retrieveSemanticMemories: daemon.retrieve,
  scheduleSemanticGraduation: vi.fn().mockResolvedValue(undefined)
}));

const roots: string[] = [];

async function runPromptHook(): Promise<void> {
  const stdin = JSON.stringify({
    session_id: 'session-lane', prompt: 'Please explain the deployment approval workflow in detail.', cwd: '/repo/app'
  });
  const { main } = await import('../../src/adapters/claude/hooks/user-prompt-submit.js');
  const hookRuntime = await import('../../src/adapters/claude/hooks/hook-runtime.js');
  vi.spyOn(hookRuntime, 'readStdin').mockResolvedValue(stdin);
  await main({ persistPrompt: false });
}

const diagnostics = () => service.recordQueryTrace.mock.calls[0][0].outcomeDiagnostics;
const withCode = (code: string) => Object.assign(new Error(code), { code });

beforeEach(() => {
  const root = mkdtempSync(path.join(tmpdir(), 'cml-hook-lane-'));
  roots.push(root);
  vi.stubEnv('HOME', root);
  vi.stubEnv('CLAUDE_MEMORY_EVAL_MODE', '');
  vi.stubEnv('CLAUDE_MEMORY_RETRIEVAL_MODE', 'hybrid');
  for (const fn of Object.values(service)) fn.mockClear();
  daemon.retrieve.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('UserPromptSubmit semantic lane', () => {
  it('asks the daemon for memories outside the prompt session', async () => {
    await runPromptHook();

    expect(daemon.retrieve.mock.calls[0][0]).toMatchObject({
      sessionId: 'session-lane',
      projectPath: '/repo/app',
      excludeSessionId: 'session-lane'
    });
  });

  it('records no lane failure when the daemon answered with nothing', async () => {
    await runPromptHook();

    expect(diagnostics().laneFailures).toBeUndefined();
  });

  it.each([
    ['timeout', withCode('ETIMEDOUT')],
    ['unavailable', withCode('ECONNREFUSED')],
    ['unavailable', withCode('ENOENT')],
    ['error', new Error('Embedding model cache is busy')]
  ])('records a %s when the daemon does not answer', async (failure, error) => {
    daemon.retrieve.mockRejectedValue(error);

    await runPromptHook();

    expect(diagnostics().laneFailures).toEqual({ vector: failure });
    expect(diagnostics().laneCandidateCounts.vector).toBe(0);
  });
});
