import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/**
 * specs/memory-usage-followup-2026-10-03 R1: the native UserPromptSubmit hook
 * retrieves, rewrites, tracks adherence, and stores with the same normalized
 * request text, and never retrieves or stores for automated notifications.
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

const TOKEN = 'stg_secret0123456789abcdefghijklmnop';
const WRAPPER = `If this turn corrects an earlier mistake or verifies recovery from a failure, you may propose one reusable project lesson before finishing. Use mcp__happy__propose_lesson with token="${TOKEN}" and proposal containing name. Do not perform extra work just to generate a lesson.`;
const TITLE = 'Based on this message, call functions.happy__change_title once to generate a concise chat session title. The title locks after it is first set, so do not call this function again.';
const NOTIFICATION = '<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>Agent "Fix deployment workflow" finished</summary>\n</task-notification>';
const SESSION = 'session-normalize';

let home = '';
const roots: string[] = [];

async function runPromptHook(prompt: string): Promise<void> {
  const stdin = JSON.stringify({ session_id: SESSION, prompt, cwd: '/repo/app' });
  vi.spyOn(process.stdin, 'setEncoding').mockReturnValue(process.stdin);
  const { main } = await import('../../src/adapters/claude/hooks/user-prompt-submit.js');
  const runtime = await import('../../src/adapters/claude/hooks/hook-runtime.js');
  vi.spyOn(runtime, 'readStdin').mockResolvedValue(stdin);
  await main();
}

function memoryDirFiles(): string[] {
  const dir = path.join(home, '.claude-code', 'memory');
  return existsSync(dir) ? readdirSync(dir) : [];
}

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(home, '.claude-code', 'memory', name), 'utf8'));
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'cml-hook-normalize-'));
  roots.push(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('CLAUDE_MEMORY_EVAL_MODE', '');
  vi.stubEnv('CLAUDE_MEMORY_RETRIEVAL_MODE', 'keyword');
  for (const fn of Object.values(service)) fn.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('UserPromptSubmit prompt normalization', () => {
  it('retrieves and stores only the request inside the host wrapper, without the token', async () => {
    await runPromptHook(`${WRAPPER}\n\n배포 워크플로우의 승인 단계를 수정해줘\n\n${TITLE}`);

    const trace = service.recordQueryTrace.mock.calls[0]?.[0];
    expect(trace.rawQueryText).toBe('배포 워크플로우의 승인 단계를 수정해줘');
    expect(service.keywordSearch.mock.calls.every((call) => !String(call[0]).includes('propose'))).toBe(true);
    expect(service.storeUserPrompt).toHaveBeenCalledTimes(1);
    const [, content, metadata] = service.storeUserPrompt.mock.calls[0];
    expect(content).toBe('배포 워크플로우의 승인 단계를 수정해줘');
    expect(metadata.promptClassifier).toEqual({ version: 2, kind: 'user', removed: ['lesson_proposal_wrapper', 'title_directive'] });

    const adherenceFile = memoryDirFiles().find((file) => file.startsWith('.adherence-state-'));
    expect(adherenceFile).toBeDefined();
    expect(readJson(adherenceFile!)).toMatchObject({ turnCount: 1, lastPrompt: '배포 워크플로우의 승인 단계를 수정해줘' });
    const everything = JSON.stringify([
      service.storeUserPrompt.mock.calls,
      service.recordQueryTrace.mock.calls,
      service.keywordSearch.mock.calls,
      ...memoryDirFiles().map(readJson)
    ]);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain('change_title');
  });

  it('does not let wrapper length push a trivial request past the store threshold', async () => {
    await runPromptHook(`${WRAPPER}\n\nok\n\n${TITLE}`);
    expect(service.storeUserPrompt).not.toHaveBeenCalled();
  });

  it('opens a new turn for a task notification without retrieval, storage, or adherence updates', async () => {
    await runPromptHook('배포 워크플로우의 승인 단계를 수정해줘');
    const adherenceFile = memoryDirFiles().find((file) => file.startsWith('.adherence-state-'))!;
    const before = readJson(adherenceFile);
    const firstTurn = readJson(`.turn-state-${SESSION}.json`);
    for (const fn of Object.values(service)) fn.mockClear();

    for (const prompt of [NOTIFICATION, `${WRAPPER}\n\n${TITLE}`]) {
      await runPromptHook(prompt);
      expect(service.keywordSearch).not.toHaveBeenCalled();
      expect(service.recordQueryTrace).not.toHaveBeenCalled();
      expect(service.storeUserPrompt).not.toHaveBeenCalled();
      expect(readJson(adherenceFile)).toEqual(before);
    }

    const turn = readJson(`.turn-state-${SESSION}.json`);
    expect(turn.turnId).not.toBe(firstTurn.turnId);
    expect(turn.turnTrigger).toBe('scaffold_only');
    const { readTurnStateDetails } = await import('../../src/core/turn-state.js');
    expect(readTurnStateDetails(SESSION)).toMatchObject({ turnTrigger: 'scaffold_only' });
  });
});
