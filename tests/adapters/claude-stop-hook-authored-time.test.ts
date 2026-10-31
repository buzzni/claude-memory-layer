import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { makeDedupeKey } from '../../src/core/canonical-key.js';
import { createSQLiteDatabase, sqliteAll, sqliteClose } from '../../src/core/sqlite-wrapper.js';

/**
 * Stop stores every assistant message of a turn at once, after the turn ends.
 * Each message keeps the instant it was written to the transcript as
 * `originalTimestamp`, the same field the importers fill, while the event
 * timestamp stays the store time: the grounding evaluator selects the
 * responses that followed an injection by that column, so moving it would
 * change what content_overlap_score measures.
 */

const fixture = vi.hoisted(() => ({ storagePath: '', service: null as unknown }));

vi.mock('../../src/services/memory-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/memory-service.js')>();
  return {
    ...actual,
    getLightweightMemoryServiceForProject: () => {
      fixture.service ??= new actual.MemoryService({
        storagePath: fixture.storagePath,
        projectHash: 'authored-time-project',
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

const SESSION = 'session-stop-authored-time';
const PROMPT_AT = '2026-10-01T09:00:00.000Z';
const FIRST_AT = '2026-10-01T09:00:05.000Z';
const FINAL_AT = '2026-10-01T09:03:40.000Z';
const FIRST_TEXT = `Investigating the failing import first. ${'The loader drops rows whose cursor sits below the pull mark. '.repeat(3)}`;
const FINAL_TEXT = 'Fixed the cursor comparison; the import test passes.';

let root = '';

function writeTranscript(): string {
  const transcriptPath = path.join(root, 'transcript.jsonl');
  const entries = [
    { type: 'user', timestamp: PROMPT_AT, message: { content: 'Fix the failing import' } },
    { type: 'assistant', timestamp: FIRST_AT, message: { content: [{ type: 'text', text: FIRST_TEXT }] } },
    { type: 'assistant', timestamp: '2026-10-01T09:00:06.000Z', message: { content: [{ type: 'tool_use', id: 'tool-1' }] } },
    { type: 'user', timestamp: '2026-10-01T09:01:00.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1' }] } },
    { type: 'assistant', timestamp: FINAL_AT, message: { content: [{ type: 'text', text: FINAL_TEXT }] } }
  ];
  writeFileSync(transcriptPath, entries.map((entry) => JSON.stringify(entry)).join('\n'), 'utf8');
  return transcriptPath;
}

async function runStop(transcriptPath: string): Promise<void> {
  const runtime = await import('../../src/adapters/claude/hooks/hook-runtime.js');
  vi.spyOn(runtime, 'readStdin').mockResolvedValue(JSON.stringify({
    session_id: SESSION, transcript_path: transcriptPath, cwd: root
  }));
  const { main } = await import('../../src/adapters/claude/hooks/stop.js');
  await main();
}

interface StoredResponse {
  id: string;
  timestamp: string;
  content: string;
  dedupe_key: string;
  turn_id: string | null;
  metadata: string;
}

function readResponses(): StoredResponse[] {
  const db = createSQLiteDatabase(path.join(fixture.storagePath, 'events.sqlite'), { readonly: true });
  try {
    return sqliteAll<StoredResponse>(
      db,
      `SELECT id, timestamp, content, dedupe_key, turn_id, metadata FROM events
       WHERE event_type = 'agent_response' ORDER BY content`
    );
  } finally {
    sqliteClose(db);
  }
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cml-stop-authored-'));
  fixture.storagePath = path.join(root, 'store');
  fixture.service = null;
  vi.stubEnv('HOME', root);
});

afterEach(async () => {
  await (fixture.service as { shutdown?: () => Promise<void> } | null)?.shutdown?.();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(root, { recursive: true, force: true });
});

describe('Stop hook authored time', () => {
  it('keeps each assistant message of a turn at its own transcript time without moving the event timestamp', async () => {
    const turnState = await import('../../src/core/turn-state.js');
    turnState.writeTurnState(SESSION, 'turn-authored', 'user');
    const storedAfter = Date.now();

    await runStop(writeTranscript());

    const rows = readResponses();
    expect(rows.map((row) => row.content)).toEqual([FINAL_TEXT, FIRST_TEXT].sort());
    const byContent = new Map(rows.map((row) => [row.content, row]));
    for (const [content, authoredAt] of [[FIRST_TEXT, FIRST_AT], [FINAL_TEXT, FINAL_AT]] as const) {
      const row = byContent.get(content)!;
      const metadata = JSON.parse(row.metadata);
      expect(metadata.originalTimestamp).toBe(authoredAt);
      expect(metadata.ingest.occurredAt).toBe(authoredAt);
      expect(row.turn_id).toBe('turn-authored');
      // The evaluator's ordering column is still the store time.
      expect(Date.parse(row.timestamp)).toBeGreaterThanOrEqual(storedAfter);
      expect(row.dedupe_key).toBe(makeDedupeKey(content, SESSION, 'agent_response'));
    }
  });

  it('does not store the same messages again when a later Stop re-reads the transcript tail', async () => {
    const turnState = await import('../../src/core/turn-state.js');
    const transcriptPath = writeTranscript();
    turnState.writeTurnState(SESSION, 'turn-authored', 'user');
    await runStop(transcriptPath);
    const first = readResponses();

    turnState.writeTurnState(SESSION, 'turn-next', 'user');
    await runStop(transcriptPath);

    expect(readResponses()).toEqual(first);
  });
});
