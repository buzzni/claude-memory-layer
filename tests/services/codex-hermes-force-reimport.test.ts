import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database = require('better-sqlite3');
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { DISABLED_SHARED_STORE_CONFIG, MemoryService } from '../../src/services/memory-service.js';
import { createCodexSessionHistoryImporter } from '../../src/services/codex-session-history-importer.js';
import { createHermesSessionHistoryImporter } from '../../src/services/hermes-session-history-importer.js';

/**
 * #227 for the Codex and Hermes importers: a force reimport with the MCP
 * default limit (200) must not delete the hook rows or the rows past the
 * limit, and an unlimited one must keep the hook rows.
 */

vi.mock('../../src/adapters/claude/hooks/semantic-daemon-client.js', () => ({
  scheduleSessionSummary: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('../../src/adapters/llm/session-summary-llm.js', () => ({ isLlmSummaryEnabled: () => false }));

const PAIRS = 300;
const answer = (i: number) => `Step ${i}: ${'The release guard checks the tag against the package version. '.repeat(3)}`;

let root = '';
let memoryService: MemoryService;

async function counts(sessionId: string): Promise<Record<string, number>> {
  const events = await memoryService.getSessionHistory(sessionId);
  const byType: Record<string, number> = { total: events.length };
  for (const event of events) byType[event.eventType] = (byType[event.eventType] ?? 0) + 1;
  return byType;
}

async function storeHookRows(sessionId: string): Promise<void> {
  await memoryService.storeSessionSummary(sessionId, 'Reviewed every release step and fixed the tag guard.');
  await memoryService.storeToolObservation(sessionId, {
    toolName: 'Bash', toolInput: {}, toolOutput: 'ok', durationMs: 1, success: true
  });
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cml-codex-hermes-force-reimport-'));
  vi.stubEnv('HOME', root);
  memoryService = new MemoryService({
    storagePath: path.join(root, 'store'),
    projectHash: 'codex-hermes-force-reimport',
    lightweightMode: true,
    analyticsEnabled: false,
    sharedStoreConfig: DISABLED_SHARED_STORE_CONFIG
  });
});

afterEach(async () => {
  await memoryService.shutdown();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('Codex force reimport', () => {
  const sessionId = 'codex-force-session';
  let file = '';

  beforeEach(() => {
    file = path.join(root, `rollout-2026-10-01T09-00-00-${sessionId}.jsonl`);
    appendFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: root } })}\n`);
    for (let i = 0; i < PAIRS; i++) {
      const at = (second: number) => new Date(Date.UTC(2026, 9, 1, 9, 0, 0) + (i * 60 + second) * 1000).toISOString();
      appendFileSync(file, `${JSON.stringify({ type: 'response_item', timestamp: at(0), payload: { type: 'message', role: 'user', content: `please review release step number ${i}` } })}\n`);
      appendFileSync(file, `${JSON.stringify({ type: 'response_item', timestamp: at(30), payload: { type: 'message', role: 'assistant', content: answer(i) } })}\n`);
    }
  });

  it('with limit 200 deletes nothing and says why', async () => {
    const importer = createCodexSessionHistoryImporter(memoryService, { sessionsDir: root });
    await importer.importSessionFile(file);
    await storeHookRows(sessionId);
    const before = await counts(sessionId);
    expect(before).toEqual({ total: 602, user_prompt: 300, agent_response: 300, session_summary: 1, tool_observation: 1 });

    const result = await importer.importSessionFile(file, { force: true, limit: 200 });

    expect(result.errors).toEqual([expect.stringContaining('Skipped force reimport (a message limit')]);
    expect(await counts(sessionId)).toEqual(before);
  });

  it('without a limit replaces the imported rows and keeps the hook rows', async () => {
    const importer = createCodexSessionHistoryImporter(memoryService, { sessionsDir: root });
    await importer.importSessionFile(file);
    await storeHookRows(sessionId);
    const before = await counts(sessionId);

    const result = await importer.importSessionFile(file, { force: true });

    expect(result).toMatchObject({ importedPrompts: PAIRS, importedResponses: PAIRS, errors: [] });
    expect(await counts(sessionId)).toEqual(before);
  });
});

describe('Hermes force reimport', () => {
  const sessionId = 'hermes-force-session';
  const memorySessionId = `hermes:${sessionId}`;
  let stateDbPath = '';

  beforeEach(() => {
    stateDbPath = path.join(root, 'state.db');
    const db = new Database(stateDbPath);
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, model TEXT, model_config TEXT,
        system_prompt TEXT, parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL, end_reason TEXT,
        message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0, title TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT, tool_name TEXT, timestamp REAL NOT NULL);
    `);
    db.prepare('INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)').run(sessionId, 'cli', 1_790_000_000);
    const insert = db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < PAIRS; i++) {
      insert.run(sessionId, 'user', `please review release step number ${i}`, 1_790_000_000 + i * 60);
      insert.run(sessionId, 'assistant', answer(i), 1_790_000_030 + i * 60);
    }
    db.close();
  });

  it('with limit 200 deletes nothing and says why', async () => {
    const importer = createHermesSessionHistoryImporter(memoryService, { stateDbPath });
    await importer.importSession(sessionId);
    await storeHookRows(memorySessionId);
    const before = await counts(memorySessionId);
    expect(before).toEqual({ total: 602, user_prompt: 300, agent_response: 300, session_summary: 1, tool_observation: 1 });

    const result = await importer.importSession(sessionId, { force: true, limit: 200 });

    expect(result.errors).toEqual([expect.stringContaining('Skipped force reimport (a message limit')]);
    expect(await counts(memorySessionId)).toEqual(before);
  });

  it('without a limit replaces the imported rows and keeps the hook rows', async () => {
    const importer = createHermesSessionHistoryImporter(memoryService, { stateDbPath });
    await importer.importSession(sessionId);
    await storeHookRows(memorySessionId);
    const before = await counts(memorySessionId);

    const result = await importer.importSession(sessionId, { force: true });

    expect(result).toMatchObject({ importedPrompts: PAIRS, importedResponses: PAIRS, errors: [] });
    expect(await counts(memorySessionId)).toEqual(before);
  });
});
