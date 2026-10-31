import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createSQLiteDatabase, sqliteAll, sqliteClose } from '../../src/core/sqlite-wrapper.js';

/**
 * Stop reads the transcript from where the previous Stop of the session left
 * off instead of re-scanning a fixed 200KB tail, so a long turn whose large
 * tool results push its earlier assistant text out of the tail still stores
 * every message, and repeated Stops never store a message twice.
 */

const fixture = vi.hoisted(() => ({ storagePath: '', service: null as unknown }));

vi.mock('../../src/services/memory-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/memory-service.js')>();
  return {
    ...actual,
    getLightweightMemoryServiceForProject: () => {
      fixture.service ??= new actual.MemoryService({
        storagePath: fixture.storagePath,
        projectHash: 'transcript-cursor-project',
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

const SESSION = 'session-stop-transcript-cursor';
const LARGE_TOOL_RESULT = 'x'.repeat(250 * 1024);

let root = '';
let transcriptPath = '';
let clock = 0;

function nextTimestamp(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 9, 1, 9, 0, clock)).toISOString();
}

function assistantText(text: string): Record<string, unknown> {
  return { type: 'assistant', timestamp: nextTimestamp(), message: { content: [{ type: 'text', text }] } };
}

function toolRoundTrip(id: string): Record<string, unknown>[] {
  return [
    { type: 'assistant', timestamp: nextTimestamp(), message: { content: [{ type: 'tool_use', id }] } },
    {
      type: 'user',
      timestamp: nextTimestamp(),
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: LARGE_TOOL_RESULT }] }
    }
  ];
}

function longText(label: string): string {
  return `${label}: ${'The importer skips rows whose cursor sits below the pull mark, so the fix compares by origin. '.repeat(3)}`;
}

function jsonl(entries: Record<string, unknown>[]): string {
  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
}

function appendTurn(entries: Record<string, unknown>[]): void {
  appendFileSync(transcriptPath, jsonl(entries), 'utf8');
}

/** One turn above the old 200KB tail: assistant text sits between large tool results. */
function largeTurn(prefix: string): { entries: Record<string, unknown>[]; texts: string[] } {
  const texts = [longText(`${prefix} first`), longText(`${prefix} middle`), `${prefix} final answer`];
  return {
    texts,
    entries: [
      { type: 'user', timestamp: nextTimestamp(), message: { content: `${prefix} request` } },
      assistantText(texts[0]),
      ...toolRoundTrip(`${prefix}-tool-1`),
      assistantText(texts[1]),
      ...toolRoundTrip(`${prefix}-tool-2`),
      assistantText(texts[2])
    ]
  };
}

async function runStop(): Promise<void> {
  const runtime = await import('../../src/adapters/claude/hooks/hook-runtime.js');
  vi.spyOn(runtime, 'readStdin').mockResolvedValue(JSON.stringify({
    session_id: SESSION, transcript_path: transcriptPath, cwd: root
  }));
  const { main } = await import('../../src/adapters/claude/hooks/stop.js');
  await main();
}

interface StoredResponse {
  content: string;
  metadata: string;
}

function readResponses(): StoredResponse[] {
  const db = createSQLiteDatabase(path.join(fixture.storagePath, 'events.sqlite'), { readonly: true });
  try {
    return sqliteAll<StoredResponse>(
      db,
      `SELECT content, metadata FROM events WHERE event_type = 'agent_response' ORDER BY content`
    );
  } finally {
    sqliteClose(db);
  }
}

function storedContents(): string[] {
  return readResponses().map((row) => row.content);
}

function cursorPath(): string {
  return path.join(root, '.claude-code', 'memory', `.stop-cursor-${SESSION}.json`);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cml-stop-cursor-'));
  fixture.storagePath = path.join(root, 'store');
  fixture.service = null;
  transcriptPath = path.join(root, 'transcript.jsonl');
  clock = 0;
  vi.stubEnv('HOME', root);
});

afterEach(async () => {
  await (fixture.service as { shutdown?: () => Promise<void> } | null)?.shutdown?.();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(root, { recursive: true, force: true });
});

describe('Stop hook transcript cursor', () => {
  it('stores every assistant message of a turn larger than the old 200KB tail', async () => {
    const firstAnswer = 'first turn answer';
    writeFileSync(transcriptPath, jsonl([
      { type: 'user', timestamp: nextTimestamp(), message: { content: 'first request' } },
      assistantText(firstAnswer)
    ]), 'utf8');
    await runStop();

    const turn = largeTurn('second');
    appendTurn(turn.entries);
    expect(statSync(transcriptPath).size).toBeGreaterThan(200 * 1024);
    await runStop();

    expect(storedContents()).toEqual([firstAnswer, ...turn.texts].sort());
  });

  it('keeps each message at its transcript time and stores nothing new when Stop repeats on the same transcript', async () => {
    writeFileSync(transcriptPath, jsonl([assistantText('opening answer')]), 'utf8');
    await runStop();
    const turn = largeTurn('repeat');
    appendTurn(turn.entries);

    await runStop();
    const first = readResponses();
    await runStop();
    await runStop();

    expect(readResponses()).toEqual(first);
    const authoredAt = new Map(
      turn.entries
        .filter((entry) => entry.type === 'assistant')
        .flatMap((entry) => {
          const content = (entry.message as { content: Array<{ type: string; text?: string }> }).content;
          return content.filter((block) => block.type === 'text').map((block) => [block.text, entry.timestamp]);
        })
    );
    for (const row of first.filter((row) => authoredAt.has(row.content))) {
      expect(JSON.parse(row.metadata).originalTimestamp).toBe(authoredAt.get(row.content));
    }
    expect(first.filter((row) => authoredAt.has(row.content))).toHaveLength(turn.texts.length);
  });

  it('reads the whole current turn on the first Stop of a session but no earlier turn', async () => {
    const earlier = largeTurn('earlier');
    const current = largeTurn('current');
    writeFileSync(transcriptPath, jsonl([...earlier.entries, ...current.entries]), 'utf8');

    await runStop();

    // Earlier turns belong to the Stops that already ran for them.
    expect(storedContents()).toEqual([...current.texts].sort());
    expect(existsSync(cursorPath())).toBe(true);

    const next = largeTurn('next');
    appendTurn(next.entries);
    await runStop();

    expect(storedContents()).toEqual([...current.texts, ...next.texts].sort());
  });

  it('resets the cursor without duplicates when the transcript is replaced by a shorter one', async () => {
    const turn = largeTurn('before-compact');
    writeFileSync(transcriptPath, jsonl([assistantText('opening answer')]), 'utf8');
    await runStop();
    appendTurn(turn.entries);
    await runStop();
    const before = storedContents();

    // Compaction or a rewritten file: shorter than the cursor, and it repeats
    // an answer that was already stored.
    const afterCompact = 'answer written after compaction';
    writeFileSync(transcriptPath, jsonl([assistantText(turn.texts[2]), assistantText(afterCompact)]), 'utf8');
    await runStop();

    expect(storedContents()).toEqual([...before, afterCompact].sort());
    expect(JSON.parse(readFileSync(cursorPath(), 'utf8')).offset).toBe(statSync(transcriptPath).size);
  });

  it('keeps the cursor when a message fails to store so the next Stop retries it', async () => {
    writeFileSync(transcriptPath, jsonl([assistantText('opening answer')]), 'utf8');
    await runStop();
    const turn = largeTurn('retry');
    appendTurn(turn.entries);
    const memoryService = await import('../../src/services/memory-service.js');
    const service = memoryService.getLightweightMemoryServiceForProject(root);
    vi.spyOn(service, 'storeAgentResponse').mockResolvedValueOnce({ success: false, error: 'database is locked' });

    await runStop();
    await runStop();

    expect(storedContents()).toEqual(['opening answer', ...turn.texts].sort());
  });

  it('stores each message once and leaves the cursor at the end when two Stops run at the same time', async () => {
    writeFileSync(transcriptPath, jsonl([assistantText('opening answer')]), 'utf8');
    await runStop();
    const turn = largeTurn('concurrent');
    appendTurn(turn.entries);

    await Promise.all([runStop(), runStop()]);

    expect(storedContents()).toEqual(['opening answer', ...turn.texts].sort());
    expect(JSON.parse(readFileSync(cursorPath(), 'utf8')).offset).toBe(statSync(transcriptPath).size);
  });
});
