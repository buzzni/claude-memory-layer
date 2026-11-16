import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
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

let root = '';
let transcriptPath = '';

async function service(): Promise<MemoryService> {
  const memoryService = await import('../../src/services/memory-service.js');
  return memoryService.getLightweightMemoryServiceForProject(root);
}

function writeTranscript(): void {
  for (let i = 0; i < PAIRS; i++) {
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
  writeTranscript();
});

afterEach(async () => {
  await (fixture.service as { shutdown?: () => Promise<void> } | null)?.shutdown?.();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(root, { recursive: true, force: true });
});

describe('Claude force reimport', () => {
  it('keeps the session summary and tool observations the hooks wrote', async () => {
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
    await (await service()).storeUserPrompt(SESSION, 'please review release step number 0', { turnId: 'hook-turn' });
    await importSession();
    const before = await counts();
    expect(before).toMatchObject({ user_prompt: PAIRS });

    await importSession({ force: true });

    expect(await counts()).toEqual(before);
  });

  it('refuses to run with a message limit and deletes nothing', async () => {
    await importSession();
    await storeHookRows();
    const before = await counts();

    const result = await importSession({ force: true, limit: 20 });

    expect(result.errors).toEqual([expect.stringContaining('Skipped force reimport (a message limit')]);
    expect(result).toMatchObject({ importedPrompts: 0, importedResponses: 0 });
    expect(await counts()).toEqual(before);
  });
});
