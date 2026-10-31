import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createSQLiteDatabase, sqliteAll, sqliteClose } from '../../src/core/sqlite-wrapper.js';
import { makeDedupeKey } from '../../src/core/canonical-key.js';
import { truncateAgentResponse } from '../../src/services/turn-buffering.js';

/**
 * SessionEnd reads the whole transcript once more and stores the assistant
 * messages Stop never did (a first Stop that failed before the next prompt,
 * a backlog past Stop's read cap, a turn the session ended in). It must store
 * them exactly as Stop would have — same content, so the same dedupe key, at
 * their transcript time and under the turn they were written in.
 */

const fixture = vi.hoisted(() => ({ storagePath: '', service: null as unknown }));

vi.mock('../../src/services/memory-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/memory-service.js')>();
  return {
    ...actual,
    getLightweightMemoryServiceForProject: () => {
      fixture.service ??= new actual.MemoryService({
        storagePath: fixture.storagePath,
        projectHash: 'session-end-reconcile-project',
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

const SESSION = 'session-end-reconcile';

let root = '';
let transcriptPath = '';
let clock = 0;

/** Advance the shared clock so transcript entries and stored events interleave in a known order. */
function tick(): string {
  clock += 1;
  const now = new Date(Date.UTC(2026, 9, 1, 9, 0, clock));
  vi.setSystemTime(now);
  return now.toISOString();
}

function longText(label: string): string {
  return `${label}: ${'The importer skips rows whose cursor sits below the pull mark, so the fix compares by origin. '.repeat(3)}`;
}

function append(entry: Record<string, unknown>): void {
  appendFileSync(transcriptPath, `${JSON.stringify({ sessionId: SESSION, ...entry })}\n`, 'utf8');
}

async function service() {
  const memoryService = await import('../../src/services/memory-service.js');
  return memoryService.getLightweightMemoryServiceForProject(root);
}

/** What UserPromptSubmit does: open the turn, then store the prompt under it. */
async function submitPrompt(text: string, turnId: string): Promise<void> {
  append({ type: 'user', timestamp: tick(), message: { content: text } });
  const turnState = await import('../../src/core/turn-state.js');
  turnState.writeTurnState(SESSION, turnId, text.startsWith('<task-notification>') ? 'task_notification' : 'user');
  tick();
  if (!text.startsWith('<task-notification>')) await (await service()).storeUserPrompt(SESSION, text, { turnId });
}

function answer(text: string): void {
  append({ type: 'assistant', timestamp: tick(), message: { content: [{ type: 'text', text }] } });
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

/** What the SessionEnd hook captures before it detaches the worker. */
async function snapshotAtSessionEnd() {
  const turnState = await import('../../src/core/turn-state.js');
  return {
    transcriptBytes: statSync(transcriptPath).size,
    endedAt: tick(),
    openTurn: turnState.readTurnStateDetails(SESSION)
  };
}

async function reconcile(snapshot?: Awaited<ReturnType<typeof snapshotAtSessionEnd>>) {
  const { reconcileSessionTranscript } = await import('../../src/adapters/claude/hooks/session-end-reconcile.js');
  return reconcileSessionTranscript(await service(), SESSION, transcriptPath, snapshot ?? await snapshotAtSessionEnd());
}

interface StoredResponse {
  content: string;
  dedupe_key: string;
  metadata: string;
}

function readResponses(): StoredResponse[] {
  const db = createSQLiteDatabase(path.join(fixture.storagePath, 'events.sqlite'), { readonly: true });
  try {
    return sqliteAll<StoredResponse>(
      db,
      `SELECT content, dedupe_key, metadata FROM events WHERE event_type = 'agent_response' ORDER BY content`
    );
  } finally {
    sqliteClose(db);
  }
}

function metadataOf(content: string): Record<string, unknown> {
  const row = readResponses().find((stored) => stored.content === content);
  if (!row) throw new Error(`not stored: ${content.slice(0, 40)}`);
  return JSON.parse(row.metadata) as Record<string, unknown>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  root = mkdtempSync(path.join(tmpdir(), 'cml-session-end-reconcile-'));
  fixture.storagePath = path.join(root, 'store');
  fixture.service = null;
  transcriptPath = path.join(root, 'transcript.jsonl');
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

describe('SessionEnd transcript reconcile', () => {
  it('stores nothing new after Stop stored every message, including truncated and filtered ones', async () => {
    const long = `${'A long explanation of the release guard. '.repeat(200)}`;
    const secret = longText('Rotate it with password=hunter2 before the deploy');
    await submitPrompt('first request', 'turn-1');
    answer(long);
    answer(secret);
    answer('done');
    await runStop();
    const afterStop = readResponses();

    const result = await reconcile();

    expect(result).toMatchObject({ recovered: 0, failed: 0 });
    expect(result.alreadyStored).toBe(3);
    expect(readResponses()).toEqual(afterStop);
    // The importer's truncation would have produced a different key for the same message.
    const stopKey = afterStop.find((row) => row.content.startsWith('A long'))!.dedupe_key;
    expect(makeDedupeKey(truncateAgentResponse(long), SESSION, 'agent_response')).not.toBe(stopKey);
  });

  it('recovers a turn whose Stop failed before the next prompt, at its transcript time and under its turn', async () => {
    const lost = longText('lost first answer');
    await submitPrompt('first request', 'turn-1');
    answer(lost);
    const lostAt = new Date(Date.UTC(2026, 9, 1, 9, 0, clock)).toISOString();
    answer('first done');
    const memoryService = await service();
    vi.spyOn(memoryService, 'storeAgentResponse').mockResolvedValueOnce({ success: false, error: 'database is locked' });
    await runStop();
    vi.mocked(memoryService.storeAgentResponse).mockRestore();

    await submitPrompt('second request', 'turn-2');
    answer(longText('second answer'));
    await runStop();
    expect(readResponses().map((row) => row.content)).not.toContain(lost);

    const result = await reconcile();

    // The failed Stop stored 'first done'; only the message that failed is missing.
    expect(result).toMatchObject({ recovered: 1, failed: 0 });
    expect(metadataOf(lost)).toMatchObject({ turnId: 'turn-1', originalTimestamp: lostAt });
    expect(metadataOf('first done')).toMatchObject({ turnId: 'turn-1' });
    expect(metadataOf(longText('second answer'))).toMatchObject({ turnId: 'turn-2' });
  });

  it('recovers the start of a turn cut off by the read cap under the turn of the messages Stop kept', async () => {
    // An automated turn stores no prompt; the only trace of its turn is what
    // Stop stored from the newest bytes it could read.
    await submitPrompt('<task-notification>\n<task-id>abc</task-id>\n</task-notification>', 'turn-capped');
    answer(longText('beyond the cap'));
    answer(longText('within the cap'));
    tick();
    await (await service()).storeAgentResponse(SESSION, longText('within the cap'), {
      originalTimestamp: new Date(Date.UTC(2026, 9, 1, 9, 0, clock - 1)).toISOString(),
      turnId: 'turn-capped',
      turnTrigger: 'task_notification'
    });
    await submitPrompt('next request', 'turn-next');

    expect(await reconcile()).toMatchObject({ recovered: 1, alreadyStored: 1 });
    expect(metadataOf(longText('beyond the cap'))).toMatchObject({
      turnId: 'turn-capped',
      turnTrigger: 'task_notification',
      recoveredAtSessionEnd: true
    });
  });

  it('keeps an automated turn tagged with its trigger and skips short text that is not the last of its turn', async () => {
    await submitPrompt('<task-notification>\n<task-id>abc</task-id>\n</task-notification>', 'turn-notification');
    // A tool call stores an observation under the turn, as PostToolUse does.
    tick();
    await (await service()).storeToolObservation(SESSION, {
      toolName: 'Bash', toolInput: {}, toolOutput: 'ok', durationMs: 1, success: true,
      metadata: { turnId: 'turn-notification' }
    });
    answer('checking');
    answer(longText('notification reply'));
    await submitPrompt('next request', 'turn-next');

    const result = await reconcile();

    expect(result.recovered).toBe(1);
    expect(metadataOf(longText('notification reply'))).toMatchObject({
      turnId: 'turn-notification',
      turnTrigger: 'task_notification'
    });
    expect(readResponses().map((row) => row.content)).not.toContain('checking');
  });

  it('attributes the turn the session ended in to the open turn state', async () => {
    await submitPrompt('<task-notification>\n<task-id>abc</task-id>\n</task-notification>', 'turn-open');
    answer('ended mid-turn');

    const result = await reconcile();

    expect(result.recovered).toBe(1);
    expect(metadataOf('ended mid-turn')).toMatchObject({ turnId: 'turn-open', turnTrigger: 'task_notification' });
  });

  it('leaves what a session resumed after SessionEnd writes to that session', async () => {
    await submitPrompt('<task-notification>\n<task-id>abc</task-id>\n</task-notification>', 'turn-ending');
    answer('ended mid-turn');
    const snapshot = await snapshotAtSessionEnd();
    // Resumed before the worker read anything: a new turn and its prompt.
    await submitPrompt('resumed request', 'turn-resumed');
    answer(longText('resumed answer'));

    expect(await reconcile(snapshot)).toMatchObject({ recovered: 1 });
    expect(metadataOf('ended mid-turn')).toMatchObject({ turnId: 'turn-ending' });
    expect(readResponses().map((row) => row.content)).not.toContain(longText('resumed answer'));
  });

  it('is a no-op the second time', async () => {
    await submitPrompt('first request', 'turn-1');
    answer(longText('answer'));
    await reconcile();
    const first = readResponses();

    expect(await reconcile()).toMatchObject({ recovered: 0, alreadyStored: 1 });
    expect(readResponses()).toEqual(first);
  });
});
