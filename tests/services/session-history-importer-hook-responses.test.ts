import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { normalizeAgentResponse } from '../../src/adapters/claude/hooks/agent-response-normalization.js';
import { mergeAgentResponseBlocks } from '../../src/services/turn-buffering.js';
import type { MemoryService } from '../../src/services/memory-service.js';

/**
 * #134: the hooks store a Claude session's assistant messages one row each
 * (privacy filtered, cut at 5000 chars); the importer merges a turn's text
 * blocks into one row. Different content means a different dedupe key, so a
 * manual import of a session the hooks already stored added a second,
 * merged copy of the same answers. A turn the hooks stored must not gain one;
 * a turn they never saw must still import as before.
 */

const fixture = vi.hoisted(() => ({ storagePath: '', service: null as unknown }));

vi.mock('../../src/services/memory-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/memory-service.js')>();
  return {
    ...actual,
    getLightweightMemoryServiceForProject: () => {
      fixture.service ??= new actual.MemoryService({
        storagePath: fixture.storagePath,
        projectHash: 'importer-hook-responses-project',
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

const SESSION = 'importer-hook-responses';

let root = '';
let transcriptPath = '';
let clock = 0;

function tick(): string {
  clock += 1;
  const now = new Date(Date.UTC(2026, 9, 1, 9, 0, clock));
  vi.setSystemTime(now);
  return now.toISOString();
}

function longText(label: string): string {
  return `${label}: ${'The importer merges every text block of a turn, so its row never matches the hook rows. '.repeat(3)}`;
}

function append(entry: Record<string, unknown>): void {
  appendFileSync(transcriptPath, `${JSON.stringify({ sessionId: SESSION, ...entry })}\n`, 'utf8');
}

async function service(): Promise<MemoryService> {
  const memoryService = await import('../../src/services/memory-service.js');
  return memoryService.getLightweightMemoryServiceForProject(root);
}

function prompt(text: string): void {
  append({ type: 'user', timestamp: tick(), message: { role: 'user', content: text } });
}

/** What UserPromptSubmit does: open the turn, then store the prompt under it (unless it is too short to keep). */
async function submitPrompt(text: string, turnId: string, { store = true } = {}): Promise<void> {
  prompt(text);
  const turnState = await import('../../src/core/turn-state.js');
  turnState.writeTurnState(SESSION, turnId, 'user');
  tick();
  if (store) await (await service()).storeUserPrompt(SESSION, text, { turnId });
}

function answer(text: string): string {
  const timestamp = tick();
  append({ type: 'assistant', timestamp, message: { role: 'assistant', content: [{ type: 'text', text }] } });
  return timestamp;
}

async function importedPromptTurn(text: string): Promise<unknown> {
  const events = await (await service()).getSessionHistory(SESSION);
  return events.find((event) => event.eventType === 'user_prompt' && event.content === text)?.metadata?.turnId;
}

async function runStop(): Promise<void> {
  const runtime = await import('../../src/adapters/claude/hooks/hook-runtime.js');
  vi.spyOn(runtime, 'readStdin').mockResolvedValue(JSON.stringify({
    session_id: SESSION, transcript_path: transcriptPath, cwd: root
  }));
  const { main } = await import('../../src/adapters/claude/hooks/stop.js');
  await main();
  vi.mocked(runtime.readStdin).mockRestore();
}

async function importSession() {
  // The import runs after the transcript was written.
  tick();
  const { SessionHistoryImporter } = await import('../../src/services/session-history-importer.js');
  return new SessionHistoryImporter(await service()).importSessionFile(transcriptPath);
}

async function responses() {
  const events = await (await service()).getSessionHistory(SESSION);
  return events
    .filter((event) => event.eventType === 'agent_response')
    .map((event) => ({ content: event.content, metadata: event.metadata ?? {} }))
    .sort((a, b) => a.content.localeCompare(b.content));
}

async function contents(): Promise<string[]> {
  return (await responses()).map((row) => row.content);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  root = mkdtempSync(path.join(tmpdir(), 'cml-importer-hook-responses-'));
  fixture.storagePath = path.join(root, 'store');
  fixture.service = null;
  // The importer takes the session id from the file name.
  transcriptPath = path.join(root, `${SESSION}.jsonl`);
  clock = 0;
  vi.stubEnv('HOME', root);
});

afterEach(async () => {
  await (fixture.service as { shutdown?: () => Promise<void> } | null)?.shutdown?.();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(root, { recursive: true, force: true });
});

describe('Claude session import after the hooks stored the session', () => {
  it('adds no response rows for turns the hooks stored, including truncated and filtered ones', async () => {
    const long = `${'A long explanation of the release guard. '.repeat(200)}`;
    const secret = longText('Rotate it with password=hunter2 before the deploy');
    await submitPrompt('please fix the release workflow guard', 'turn-1');
    answer(longText('first block'));
    answer(secret);
    await runStop();
    await submitPrompt('now explain the guard in detail please', 'turn-2');
    answer(long);
    await runStop();
    const afterHooks = await contents();
    expect(afterHooks).toHaveLength(3);

    const first = await importSession();
    expect(first).toMatchObject({ importedResponses: 0, errors: [] });
    expect(await contents()).toEqual(afterHooks);
    expect((await contents()).join('\n')).not.toContain('hunter2');

    const second = await importSession();
    expect(second).toMatchObject({ importedPrompts: 0, importedResponses: 0 });
    expect(await contents()).toEqual(afterHooks);
  });

  it('stores the messages the hooks missed in a turn, once and as the hooks store them', async () => {
    // Stop before the per-session cursor read a 200KB tail and could lose a
    // turn's earlier text while still storing its final answer.
    const lost = longText('earlier analysis Stop never read');
    const final = longText('final answer');
    await submitPrompt('please review the import pipeline', 'turn-1');
    answer(lost);
    answer(final);
    await (await service()).storeAgentResponse(SESSION, normalizeAgentResponse(final).content, { turnId: 'turn-1' });

    const first = await importSession();
    expect(first).toMatchObject({ importedResponses: 1, errors: [] });
    const rows = await responses();
    expect(rows.map((row) => row.content)).toEqual([normalizeAgentResponse(lost).content, normalizeAgentResponse(final).content].sort());
    const recovered = rows.find((row) => row.content.startsWith('earlier analysis'))!;
    expect(recovered.metadata).toMatchObject({ turnId: 'turn-1', importedFrom: transcriptPath });

    const second = await importSession();
    expect(second).toMatchObject({ importedResponses: 0 });
    expect(await responses()).toEqual(rows);
  });

  it('stores the turns from before the hooks were installed as the hooks would have, under their own prompt', async () => {
    const before = [longText('pre-install analysis'), longText('pre-install answer')];
    prompt('please audit the vector store first');
    before.forEach(answer);
    await submitPrompt('now fix the vector store bug please', 'turn-2');
    answer(longText('hooked block one'));
    answer(longText('hooked block two'));
    await runStop();
    const afterHooks = await contents();
    expect(afterHooks).toHaveLength(2);

    const first = await importSession();
    expect(first).toMatchObject({ importedPrompts: 1, importedResponses: 2, errors: [] });
    const expected = [...afterHooks, ...before.map((text) => normalizeAgentResponse(text).content)].sort();
    expect(await contents()).toEqual(expected);
    const promptTurn = await importedPromptTurn('please audit the vector store first');
    expect(promptTurn).toEqual(expect.any(String));
    for (const row of (await responses()).filter((row) => row.content.startsWith('pre-install'))) {
      expect(row.metadata).toMatchObject({ turnId: promptTurn, importedFrom: transcriptPath });
    }

    const second = await importSession();
    expect(second).toMatchObject({ importedResponses: 0 });
    expect(await contents()).toEqual(expected);
  });

  it('does not take a pre-hook turn for a hook turn because both end with the same text', async () => {
    prompt('please audit the vector store first');
    answer(longText('pre-hook analysis'));
    answer('Done.');
    await submitPrompt('now fix the vector store bug please', 'turn-2');
    answer(longText('hooked answer'));
    answer('Done.');
    await runStop();

    await importSession();

    const analysis = (await responses()).find((row) => row.content.startsWith('pre-hook analysis'));
    expect(analysis?.metadata.turnId).toBe(await importedPromptTurn('please audit the vector store first'));
    expect(analysis?.metadata.turnId).not.toBe('turn-2');
  });

  it('stores a message the hooks missed under its own turn when a short prompt opened that turn', async () => {
    await submitPrompt('please fix the importer turn grouping', 'turn-A');
    answer(longText('turn A answer'));
    await runStop();
    // The hooks open a turn for every prompt but do not store a short one.
    await submitPrompt('ok go on', 'turn-B', { store: false });
    const lost = longText('turn B analysis Stop never read');
    answer(lost);
    const final = longText('turn B final answer');
    const finalAt = answer(final);
    await (await service()).storeAgentResponse(SESSION, normalizeAgentResponse(final).content, { turnId: 'turn-B', originalTimestamp: finalAt });

    const first = await importSession();
    expect(first).toMatchObject({ importedResponses: 1, errors: [] });
    const recovered = (await responses()).find((row) => row.content.startsWith('turn B analysis'));
    expect(recovered?.metadata).toMatchObject({ turnId: 'turn-B', importedFrom: transcriptPath });
  });
});

describe('Claude session import of a session the hooks never saw', () => {
  it('imports each turn as one merged response and stays idempotent', async () => {
    const blocks = [longText('analysis'), longText('answer')];
    prompt('please audit the vector store first');
    blocks.forEach(answer);

    const first = await importSession();
    expect(first).toMatchObject({ importedPrompts: 1, importedResponses: 1, errors: [] });
    expect(await contents()).toEqual([mergeAgentResponseBlocks(blocks)]);

    const second = await importSession();
    expect(second).toMatchObject({ importedPrompts: 0, importedResponses: 0 });
    expect(await contents()).toEqual([mergeAgentResponseBlocks(blocks)]);
  });
});
