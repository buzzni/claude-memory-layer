// @load-sensitive: imports 600-line sessions twice into a real sqlite store (#227 repro);
// under a loaded parallel run one test can pass the 15s unit timeout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import type { MemoryService } from '../../src/services/memory-service.js';

/**
 * #227: a force reimport deleted every row of the session, then re-imported
 * only what the transcript holds, up to the message limit. Rows the hooks or
 * the daemon wrote (session summaries, tool observations) and rows past the
 * limit were lost for good. A force reimport must replace only the rows an
 * import wrote, and must not run when a message limit would cut it short.
 */

const fixture = vi.hoisted(() => ({ storagePath: '', service: null as unknown }));

vi.mock('../../src/services/memory-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/memory-service.js')>();
  return {
    ...actual,
    getLightweightMemoryServiceForProject: () => {
      fixture.service ??= new actual.MemoryService({
        storagePath: fixture.storagePath,
        projectHash: 'importer-force-reimport-project',
        lightweightMode: true,
        analyticsEnabled: false,
        sharedStoreConfig: actual.DISABLED_SHARED_STORE_CONFIG
      });
      return fixture.service;
    }
  };
});
vi.mock('../../src/adapters/claude/hooks/semantic-daemon-client.js', () => ({
  scheduleSessionSummary: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('../../src/adapters/llm/session-summary-llm.js', () => ({ isLlmSummaryEnabled: () => false }));

const SESSION = 'importer-force-reimport';
const PAIRS = 30;
// The #227 measurement: 300 prompt/response pairs, 600 transcript lines.
const ISSUE_PAIRS = 300;

let root = '';
let transcriptPath = '';

async function service(): Promise<MemoryService> {
  const memoryService = await import('../../src/services/memory-service.js');
  return memoryService.getLightweightMemoryServiceForProject(root);
}

function writeTranscript(pairs = PAIRS): void {
  for (let i = 0; i < pairs; i++) {
    appendFileSync(transcriptPath, `${JSON.stringify({
      sessionId: SESSION, type: 'user', timestamp: new Date(Date.UTC(2026, 9, 1, 9, i, 0)).toISOString(),
      message: { role: 'user', content: `please review release step number ${i}` }
    })}\n`, 'utf8');
    appendFileSync(transcriptPath, `${JSON.stringify({
      sessionId: SESSION, type: 'assistant', timestamp: new Date(Date.UTC(2026, 9, 1, 9, i, 30)).toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: `Step ${i}: ${'The release guard checks the tag against the package version. '.repeat(3)}` }] }
    })}\n`, 'utf8');
  }
}

async function importSession(options: { limit?: number; force?: boolean } = {}) {
  const { SessionHistoryImporter } = await import('../../src/services/session-history-importer.js');
  return new SessionHistoryImporter(await service()).importSessionFile(transcriptPath, options);
}

async function contentsOf(eventType: string): Promise<string[]> {
  const events = await (await service()).getSessionHistory(SESSION);
  return events.filter((event) => event.eventType === eventType).map((event) => event.content).sort();
}

async function counts(): Promise<Record<string, number>> {
  const events = await (await service()).getSessionHistory(SESSION);
  const byType: Record<string, number> = { total: events.length };
  for (const event of events) byType[event.eventType] = (byType[event.eventType] ?? 0) + 1;
  return byType;
}

async function storeHookRows(): Promise<void> {
  const memoryService = await service();
  await memoryService.storeSessionSummary(SESSION, 'Reviewed every release step and fixed the tag guard.');
  await memoryService.storeToolObservation(SESSION, {
    toolName: 'Bash', toolInput: {}, toolOutput: 'ok', durationMs: 1, success: true
  });
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cml-importer-force-reimport-'));
  fixture.storagePath = path.join(root, 'store');
  fixture.service = null;
  // The importer takes the session id from the file name.
  transcriptPath = path.join(root, `${SESSION}.jsonl`);
  vi.stubEnv('HOME', root);
});

afterEach(async () => {
  await (fixture.service as { shutdown?: () => Promise<void> } | null)?.shutdown?.();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(root, { recursive: true, force: true });
});

describe('Claude force reimport', () => {
  it('reproduces #227: force with limit 200 keeps the summary, the observation and the rows past the limit', async () => {
    writeTranscript(ISSUE_PAIRS);
    await importSession();
    await storeHookRows();
    const before = await counts();
    expect(before).toEqual({ total: 602, user_prompt: 300, agent_response: 300, session_summary: 1, tool_observation: 1 });

    const result = await importSession({ force: true, limit: 200 });

    expect(result.errors).toEqual([expect.stringContaining('Skipped force reimport (a message limit')]);
    expect(await counts()).toEqual(before);
  });

  it('keeps the session summary and tool observations the hooks wrote', async () => {
    writeTranscript();
    await importSession();
    await storeHookRows();
    const before = await counts();
    expect(before).toMatchObject({ user_prompt: PAIRS, agent_response: PAIRS, session_summary: 1, tool_observation: 1 });

    const result = await importSession({ force: true });

    // The imported rows were replaced, not skipped as duplicates.
    expect(result).toMatchObject({ importedPrompts: PAIRS, importedResponses: PAIRS, errors: [] });
    expect(await counts()).toEqual(before);
  });

  it('does not duplicate a prompt the hook stored', async () => {
    writeTranscript();
    await (await service()).storeUserPrompt(SESSION, 'please review release step number 0', { turnId: 'hook-turn' });
    await importSession();
    const before = await counts();
    expect(before).toMatchObject({ user_prompt: PAIRS });

    await importSession({ force: true });

    expect(await counts()).toEqual(before);
  });

  it('does not duplicate responses the Stop hook stored', async () => {
    writeTranscript();
    const memoryService = await service();
    await memoryService.storeUserPrompt(SESSION, 'please review release step number 0', { turnId: 'hook-turn' });
    await memoryService.storeAgentResponse(
      SESSION,
      `Step 0: ${'The release guard checks the tag against the package version. '.repeat(3)}`,
      { turnId: 'hook-turn' }
    );
    await importSession();
    const before = await counts();
    const responses = await contentsOf('agent_response');
    expect(before).toMatchObject({ user_prompt: PAIRS, agent_response: PAIRS });

    await importSession({ force: true });

    expect(await counts()).toEqual(before);
    expect(await contentsOf('agent_response')).toEqual(responses);
  });

  it('keeps an imported response a lesson cites, without a second copy', async () => {
    writeTranscript();
    await importSession();
    const memoryService = await service();
    const cited = (await memoryService.getSessionHistory(SESSION)).find((event) => event.eventType === 'agent_response');
    if (!cited) throw new Error('no imported response');
    const { LessonRepository } = await import('../../src/core/operations/lesson-repository.js');
    const { SQLiteEventStore } = await import('../../src/core/sqlite-event-store.js');
    const store = new SQLiteEventStore(path.join(fixture.storagePath, 'events.sqlite'));
    await store.initialize();
    try {
      await new LessonRepository(store.getDatabase()).upsert({
        projectHash: 'importer-force-reimport-project', name: 'Release guard', trigger: 'When tagging a release',
        steps: ['Check the tag against the package version'], confidence: 0.8, sourceSessionIds: [SESSION],
        sourceEventIds: [cited.id], failureModes: [], skillCandidate: false, actor: 'tester'
      });
    } finally {
      store.close();
    }
    const before = await counts();

    await importSession({ force: true });

    const after = await memoryService.getSessionHistory(SESSION);
    expect(after.some((event) => event.id === cited.id)).toBe(true);
    expect(await counts()).toEqual(before);
  });

  it('runs a force reimport the limit cannot cut short and keeps the hook rows', async () => {
    writeTranscript();
    await importSession();
    await storeHookRows();
    const before = await counts();

    // 30 prompts and 30 responses count 60 against the limit.
    const result = await importSession({ force: true, limit: 2 * PAIRS + 1 });

    expect(result).toMatchObject({ importedPrompts: PAIRS, importedResponses: PAIRS, errors: [] });
    expect(await counts()).toEqual(before);
  });

  it('refuses a force reimport the limit would reach, even at exactly the count', async () => {
    writeTranscript();
    await importSession();
    const before = await counts();

    const result = await importSession({ force: true, limit: 2 * PAIRS });

    expect(result.errors).toEqual([expect.stringContaining('Skipped force reimport (a message limit')]);
    expect(await counts()).toEqual(before);
  });

  it('refuses to run with a message limit and deletes nothing', async () => {
    writeTranscript();
    await importSession();
    await storeHookRows();
    const before = await counts();

    const result = await importSession({ force: true, limit: 20 });

    expect(result.errors).toEqual([expect.stringContaining('Skipped force reimport (a message limit')]);
    expect(result).toMatchObject({ importedPrompts: 0, importedResponses: 0 });
    expect(await counts()).toEqual(before);
  });

  it('reports the refusal from a project import, where the MCP and CLI read it', async () => {
    const projectPath = path.join(root, 'work', 'app');
    const projectDir = path.join(root, '.claude', 'projects', projectPath.replace(/[\\/]/g, '-'));
    mkdirSync(projectDir, { recursive: true });
    transcriptPath = path.join(projectDir, `${SESSION}.jsonl`);
    writeTranscript();
    const { SessionHistoryImporter } = await import('../../src/services/session-history-importer.js');

    const result = await new SessionHistoryImporter(await service()).importProject(projectPath, { force: true, limit: 20 });

    expect(result.errors).toEqual([expect.stringContaining('Skipped force reimport (a message limit')]);
  });

  it('counts a mixed transcript exactly as the import loop does', async () => {
    // Tool calls, thinking, an automated notification, a short reply after it,
    // and a short response: the pre-count must match what the loop counts.
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 9, minute, 0)).toISOString();
    const long = (label: string) => `${label}: ${'The release guard checks the tag against the package version. '.repeat(3)}`;
    const lines = [
      { type: 'user', message: { role: 'user', content: 'please review release step number 0' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: long('First answer') }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking' }] } },
      { type: 'user', message: { role: 'user', content: '<task-notification>background job finished</task-notification>' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }] } },
      { type: 'user', message: { role: 'user', content: 'ok' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: long('Follow-up') }] } },
      { type: 'user', message: { role: 'user', content: 'please check the second release step' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: long('Second answer') }] } }
    ];
    lines.forEach((line, i) => appendFileSync(transcriptPath, `${JSON.stringify({ sessionId: SESSION, timestamp: at(i), ...line })}\n`));
    const first = await importSession();
    const counted = first.importedPrompts + first.importedResponses;
    expect(counted).toBe(6);
    const before = await counts();

    const atCount = await importSession({ force: true, limit: counted });
    expect(atCount.errors).toEqual([expect.stringContaining('Skipped force reimport (a message limit')]);
    const aboveCount = await importSession({ force: true, limit: counted + 1 });
    expect(aboveCount).toMatchObject({ importedPrompts: first.importedPrompts, importedResponses: first.importedResponses, errors: [] });
    expect(await counts()).toEqual(before);
  });
});
