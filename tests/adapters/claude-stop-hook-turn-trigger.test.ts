import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/**
 * specs/memory-usage-followup-2026-10-03 R1: a reply to an automated
 * notification is stored with its turnTrigger but must not replace the
 * snippet the next human prompt is enriched with.
 */

const service = {
  storeAgentResponse: vi.fn().mockResolvedValue({ success: true, isDuplicate: false }),
  evaluateSessionHelpfulness: vi.fn().mockResolvedValue(undefined),
  generateSessionSummary: vi.fn().mockResolvedValue(undefined),
  processPendingEmbeddings: vi.fn().mockResolvedValue(undefined)
};
const transcript = { messages: [] as string[] };

vi.mock('../../src/services/memory-service.js', () => ({
  getLightweightMemoryServiceForProject: () => service
}));
vi.mock('../../src/adapters/claude/transcript/turn-reconstructor.js', () => ({
  extractAssistantMessages: vi.fn(async () => transcript.messages)
}));
vi.mock('../../src/adapters/claude/hooks/semantic-daemon-client.js', () => ({
  scheduleSessionSummary: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('../../src/adapters/llm/session-summary-llm.js', () => ({ isLlmSummaryEnabled: () => false }));

const SESSION = 'session-stop-trigger';
const roots: string[] = [];

async function runStop(messages: string[]): Promise<void> {
  transcript.messages = messages;
  const runtime = await import('../../src/adapters/claude/hooks/hook-runtime.js');
  vi.spyOn(runtime, 'readStdin').mockResolvedValue(JSON.stringify({ session_id: SESSION, transcript_path: '/unused', cwd: '/repo/app' }));
  const { main } = await import('../../src/adapters/claude/hooks/stop.js');
  await main();
}

beforeEach(() => {
  const home = mkdtempSync(path.join(tmpdir(), 'cml-stop-trigger-'));
  roots.push(home);
  vi.stubEnv('HOME', home);
  for (const fn of Object.values(service)) fn.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Stop hook turn trigger', () => {
  it('keeps the human snippet across automated turns and updates it for user turns', async () => {
    const turnState = await import('../../src/core/turn-state.js');

    turnState.writeTurnState(SESSION, 'turn-user-1', 'user');
    await runStop(['Human answer about the release checklist']);
    expect(turnState.readLastAssistantSnippet(SESSION)).toBe('Human answer about the release checklist');

    for (const trigger of ['task_notification', 'scaffold_only'] as const) {
      service.storeAgentResponse.mockClear();
      turnState.writeTurnState(SESSION, `turn-${trigger}`, trigger);
      await runStop([`Automated reply for ${trigger}`]);
      expect(service.storeAgentResponse).toHaveBeenCalledWith(
        SESSION,
        `Automated reply for ${trigger}`,
        expect.objectContaining({ turnId: `turn-${trigger}`, turnTrigger: trigger })
      );
      expect(turnState.readLastAssistantSnippet(SESSION)).toBe('Human answer about the release checklist');
    }

    turnState.writeTurnState(SESSION, 'turn-user-2', 'user');
    await runStop(['Second human answer']);
    expect(turnState.readLastAssistantSnippet(SESSION)).toBe('Second human answer');

    // State files written before turnTrigger existed behave as user turns.
    turnState.writeTurnState(SESSION, 'turn-legacy');
    await runStop(['Legacy-state answer']);
    expect(turnState.readLastAssistantSnippet(SESSION)).toBe('Legacy-state answer');
  });
});
