import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/**
 * A UserPromptSubmit hook killed during retrieval never reaches the point
 * where it stores the prompt. The turn still runs, so the Stop hook at its end
 * is the first chance to store what the killed hook left on disk.
 */

const service = {
  storeUserPrompt: vi.fn().mockResolvedValue({ success: true, isDuplicate: false }),
  storeAgentResponse: vi.fn().mockResolvedValue({ success: true, isDuplicate: false }),
  evaluateSessionHelpfulness: vi.fn().mockResolvedValue(undefined),
  generateSessionSummary: vi.fn().mockResolvedValue(undefined),
  processPendingEmbeddings: vi.fn().mockResolvedValue(undefined)
};

vi.mock('../../src/services/memory-service.js', () => ({
  getLightweightMemoryServiceForProject: () => service
}));
vi.mock('../../src/adapters/claude/transcript/stop-transcript-cursor.js', () => ({
  readUnprocessedAssistantMessages: vi.fn(() => ({
    messages: [{ text: 'The import stalled on a lock held by the nightly vacuum.' }],
    commit: () => {}
  }))
}));
vi.mock('../../src/adapters/claude/hooks/semantic-daemon-client.js', () => ({
  scheduleSessionSummary: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('../../src/adapters/llm/session-summary-llm.js', () => ({ isLlmSummaryEnabled: () => false }));

const SESSION = 'session-stop-pending';
const killedPrompt = 'Why did the nightly import stall on the ledger table?';
const roots: string[] = [];

async function runStop(): Promise<void> {
  const runtime = await import('../../src/adapters/claude/hooks/hook-runtime.js');
  vi.spyOn(runtime, 'readStdin').mockResolvedValue(JSON.stringify({ session_id: SESSION, transcript_path: '/unused', cwd: '/repo/app' }));
  const { main } = await import('../../src/adapters/claude/hooks/stop.js');
  await main();
}

beforeEach(() => {
  const home = mkdtempSync(path.join(tmpdir(), 'cml-stop-pending-'));
  roots.push(home);
  vi.stubEnv('HOME', home);
  for (const fn of Object.values(service)) fn.mockClear();
});

afterEach(() => {
  service.storeUserPrompt.mockReset().mockResolvedValue({ success: true, isDuplicate: false });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Stop hook pending prompt recovery', () => {
  it('stores the prompt a killed hook left behind, ahead of the answer to it', async () => {
    const turnState = await import('../../src/core/turn-state.js');
    turnState.writePendingPrompt(SESSION, killedPrompt, { turnId: 'turn-killed' });
    const left = turnState.readPendingPrompt(SESSION)!;

    await runStop();

    expect(service.storeUserPrompt).toHaveBeenCalledWith(SESSION, killedPrompt, {
      turnId: 'turn-killed',
      originalTimestamp: left.createdAt
    });
    expect(service.storeUserPrompt.mock.invocationCallOrder[0])
      .toBeLessThan(service.storeAgentResponse.mock.invocationCallOrder[0]);
    expect(turnState.readPendingPrompt(SESSION)).toBeNull();
  });

  it('stores no prompt when the hook finished normally', async () => {
    await runStop();

    expect(service.storeUserPrompt).not.toHaveBeenCalled();
  });

  it('keeps the prompt for the next hook when storing it fails, and still stores the answer', async () => {
    const turnState = await import('../../src/core/turn-state.js');
    turnState.writePendingPrompt(SESSION, killedPrompt, { turnId: 'turn-killed' });
    service.storeUserPrompt.mockRejectedValue(new Error('database is locked'));

    await runStop();

    expect(turnState.readPendingPrompt(SESSION)).toMatchObject({ content: killedPrompt });
    expect(service.storeAgentResponse).toHaveBeenCalledOnce();
  });
});
