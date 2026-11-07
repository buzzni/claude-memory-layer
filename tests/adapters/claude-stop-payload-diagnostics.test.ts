import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/**
 * Measures how often the Stop payload's last_assistant_message is absent from
 * the transcript batch Stop reads (Beacon reads the payload because the
 * transcript is written asynchronously). The record must carry no message text.
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
vi.mock('../../src/adapters/claude/transcript/stop-transcript-cursor.js', () => ({
  readUnprocessedAssistantMessages: vi.fn(() => ({
    messages: transcript.messages.map((text) => ({ text })),
    commit: () => {}
  }))
}));
vi.mock('../../src/adapters/claude/hooks/semantic-daemon-client.js', () => ({
  scheduleSessionSummary: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('../../src/adapters/llm/session-summary-llm.js', () => ({ isLlmSummaryEnabled: () => false }));

let home = '';

function diagnosticsLines(): Array<Record<string, unknown>> {
  const file = path.join(home, '.claude-code', 'memory', 'stop-payload-diagnostics.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

async function runStop(messages: string[], payload: Record<string, unknown>): Promise<void> {
  transcript.messages = messages;
  const runtime = await import('../../src/adapters/claude/hooks/hook-runtime.js');
  vi.spyOn(runtime, 'readStdin').mockResolvedValue(JSON.stringify({
    session_id: 'session-stop-payload', transcript_path: '/unused', cwd: '/repo/app', ...payload
  }));
  const { main } = await import('../../src/adapters/claude/hooks/stop.js');
  await main();
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'cml-stop-payload-'));
  vi.stubEnv('HOME', home);
  for (const fn of Object.values(service)) fn.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(home, { recursive: true, force: true });
});

describe('classifyStopPayloadMessage', () => {
  it('reports no_payload when the field is missing or blank', async () => {
    const { classifyStopPayloadMessage } = await import('../../src/adapters/claude/hooks/stop-payload-diagnostics.js');
    expect(classifyStopPayloadMessage(undefined, [{ text: 'a' }])).toBe('no_payload');
    expect(classifyStopPayloadMessage('   ', [{ text: 'a' }])).toBe('no_payload');
  });

  it('reports in_batch when the batch holds the payload text, ignoring whitespace differences', async () => {
    const { classifyStopPayloadMessage } = await import('../../src/adapters/claude/hooks/stop-payload-diagnostics.js');
    expect(classifyStopPayloadMessage('Final  answer\n', [{ text: 'Earlier' }, { text: 'Final answer' }])).toBe('in_batch');
  });

  it('reports missing_from_batch when the batch lacks the payload text', async () => {
    const { classifyStopPayloadMessage } = await import('../../src/adapters/claude/hooks/stop-payload-diagnostics.js');
    expect(classifyStopPayloadMessage('Final answer', [{ text: 'Earlier reply' }])).toBe('missing_from_batch');
    expect(classifyStopPayloadMessage('Final answer', [])).toBe('missing_from_batch');
  });
});

describe('Stop hook payload diagnostics', () => {
  it('appends one content-free record per Stop', async () => {
    await runStop(['Earlier reply'], { last_assistant_message: 'Secret final answer' });
    await runStop(['Shown reply'], {});

    const lines = diagnosticsLines();
    expect(lines).toEqual([
      expect.objectContaining({ version: 1, outcome: 'missing_from_batch', batchMessages: 1, payloadChars: 19 }),
      expect.objectContaining({ version: 1, outcome: 'no_payload', batchMessages: 1, payloadChars: 0 })
    ]);
    expect(JSON.stringify(lines)).not.toContain('Secret');
    expect(JSON.stringify(lines)).not.toContain('session-stop-payload');
  });

  it('does not change what Stop stores', async () => {
    await runStop(['Earlier reply'], { last_assistant_message: 'Final answer' });
    expect(service.storeAgentResponse).toHaveBeenCalledTimes(1);
    expect(service.storeAgentResponse).toHaveBeenCalledWith('session-stop-payload', 'Earlier reply', expect.anything());
  });
});
