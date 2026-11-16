import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/**
 * The prompt is stored after retrieval so it cannot be retrieved as its own
 * exact match. That ordering must not make the prompt depend on retrieval
 * succeeding: recall is best-effort, the record of what the user asked is not.
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

vi.mock('../../src/services/memory-service.js', () => ({
  getLightweightMemoryService: () => service,
  getLightweightMemoryServiceForProject: () => service
}));

vi.mock('../../src/adapters/claude/hooks/semantic-daemon-client.js', () => ({
  retrieveSemanticMemories: vi.fn().mockResolvedValue([]),
  scheduleSemanticGraduation: vi.fn().mockResolvedValue(undefined)
}));

const roots: string[] = [];
const prompt = 'Please explain the deployment approval workflow in detail.';

const SESSION = 'session-persistence';

async function runPromptHook(options: { persistPrompt?: boolean; prompt?: string } = {}): Promise<string> {
  const stdin = JSON.stringify({ session_id: SESSION, prompt: options.prompt ?? prompt, cwd: '/repo/app' });
  const { main } = await import('../../src/adapters/claude/hooks/user-prompt-submit.js');
  const hookRuntime = await import('../../src/adapters/claude/hooks/hook-runtime.js');
  vi.spyOn(hookRuntime, 'readStdin').mockResolvedValue(stdin);
  return main(options.persistPrompt === undefined ? {} : { persistPrompt: options.persistPrompt });
}

/** What is on disk for the session's prompt at the moment retrieval runs. */
async function pendingPromptDuringRetrieval(run: () => Promise<unknown>): Promise<unknown> {
  const { readPendingPrompt } = await import('../../src/core/turn-state.js');
  let seen: unknown = 'retrieval did not run';
  service.keywordSearch.mockImplementation(async () => {
    seen = readPendingPrompt(SESSION);
    return [];
  });
  await run();
  return seen;
}

beforeEach(() => {
  const root = mkdtempSync(path.join(tmpdir(), 'cml-hook-persistence-'));
  roots.push(root);
  vi.stubEnv('HOME', root);
  vi.stubEnv('CLAUDE_MEMORY_EVAL_MODE', '');
  vi.stubEnv('CLAUDE_MEMORY_RETRIEVAL_MODE', 'keyword');
  for (const fn of Object.values(service)) fn.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  service.keywordSearch.mockReset().mockResolvedValue([]);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('UserPromptSubmit prompt persistence', () => {
  it('stores the prompt when retrieval finds nothing', async () => {
    await runPromptHook();

    expect(service.storeUserPrompt).toHaveBeenCalledWith(SESSION, prompt, expect.any(Object));
  });

  it('still stores the prompt when retrieval throws', async () => {
    service.keywordSearch.mockRejectedValue(new Error('database is locked'));

    const output = await runPromptHook();

    expect(service.storeUserPrompt).toHaveBeenCalledWith(SESSION, prompt, expect.any(Object));
    expect(JSON.parse(output)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } });
  });

  it('reports the retrieval failure instead of an empty result', async () => {
    service.keywordSearch.mockRejectedValue(new Error('database is locked'));

    await runPromptHook();

    const diagnostics = vi.mocked(console.error).mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith('[cml-recall] '))
      .map((line) => JSON.parse(line.slice('[cml-recall] '.length)));
    expect(diagnostics).toEqual([
      expect.objectContaining({ event: 'UserPromptSubmit', stage: 'retrieval', outcome: 'error' })
    ]);
  });
});

/**
 * The host kills a hook that overruns its timeout. Retrieval runs before the
 * prompt is stored, so a hook killed there took the prompt with it: on one
 * machine 43 prompts in 12 days, each of them a long, detailed request.
 */
describe('UserPromptSubmit prompt survives a killed hook', () => {
  it('leaves the prompt on disk while retrieval runs', async () => {
    const pending = await pendingPromptDuringRetrieval(() => runPromptHook());

    expect(pending).toMatchObject({
      content: prompt,
      metadata: { turnId: expect.any(String), adherence: { turn: 1 } }
    });
  });

  it('removes the on-disk copy once the prompt is stored', async () => {
    await runPromptHook();

    const { readPendingPrompt } = await import('../../src/core/turn-state.js');
    expect(readPendingPrompt(SESSION)).toBeNull();
  });

  it('stores a prompt left by a killed hook before handling the next one', async () => {
    const { writePendingPrompt, readPendingPrompt } = await import('../../src/core/turn-state.js');
    writePendingPrompt(SESSION, 'Why did the nightly import stall on the ledger table?', { turnId: 'turn-killed' });
    const left = readPendingPrompt(SESSION)!;

    await runPromptHook();

    expect(service.storeUserPrompt.mock.calls.map((call) => [call[1], call[2].turnId, call[2].originalTimestamp])).toEqual([
      ['Why did the nightly import stall on the ledger table?', 'turn-killed', left.createdAt],
      [prompt, expect.any(String), undefined]
    ]);
    expect(readPendingPrompt(SESSION)).toBeNull();
  });

  it('keeps nothing on disk for a host that stores prompts itself', async () => {
    const pending = await pendingPromptDuringRetrieval(() => runPromptHook({ persistPrompt: false }));

    expect(pending).toBeNull();
  });
});
