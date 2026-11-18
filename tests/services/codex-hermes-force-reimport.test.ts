// @load-sensitive: imports 600-line sessions twice into a real sqlite store (#227 repro);
// under a loaded parallel run one test can pass the 15s unit timeout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database = require('better-sqlite3');
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

function writeCodexSession(file: string, sessionId: string, cwd: string, pairs: number): void {
  appendFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd } })}\n`);
  for (let i = 0; i < pairs; i++) {
    const at = (second: number) => new Date(Date.UTC(2026, 9, 1, 9, 0, 0) + (i * 60 + second) * 1000).toISOString();
    appendFileSync(file, `${JSON.stringify({ type: 'response_item', timestamp: at(0), payload: { type: 'message', role: 'user', content: `please review ${sessionId} release step number ${i}` } })}\n`);
    appendFileSync(file, `${JSON.stringify({ type: 'response_item', timestamp: at(30), payload: { type: 'message', role: 'assistant', content: answer(i) } })}\n`);
  }
}

describe('Codex force reimport', () => {
  const sessionId = 'codex-force-session';
  let file = '';

  beforeEach(() => {
    file = path.join(root, `rollout-2026-10-01T09-00-00-${sessionId}.jsonl`);
    writeCodexSession(file, sessionId, root, PAIRS);
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

  it('with a limit the session cannot reach replaces the imported rows and keeps the hook rows', async () => {
    const importer = createCodexSessionHistoryImporter(memoryService, { sessionsDir: root });
    await importer.importSessionFile(file);
    await storeHookRows(sessionId);
    const before = await counts(sessionId);

    const result = await importer.importSessionFile(file, { force: true, limit: 2 * PAIRS + 1 });

    expect(result).toMatchObject({ importedPrompts: PAIRS, importedResponses: PAIRS, errors: [] });
    expect(await counts(sessionId)).toEqual(before);
  });

  it.each([
    [120, 'refuses every session', true],
    [121, 'replaces every session', false]
  ])('across two 30-pair sessions, limit %i %s', async (limit, _label, refused) => {
    const projectPath = path.join(root, 'project');
    const sessionsDir = path.join(root, 'project-sessions');
    mkdirSync(projectPath);
    mkdirSync(sessionsDir);
    for (const id of ['codex-a', 'codex-b']) {
      writeCodexSession(path.join(sessionsDir, `rollout-2026-10-01T09-00-00-${id}.jsonl`), id, projectPath, 30);
    }
    const importer = createCodexSessionHistoryImporter(memoryService, { sessionsDir });
    await importer.importProject(projectPath);
    await storeHookRows('codex-a');
    await storeHookRows('codex-b');
    const before = [await counts('codex-a'), await counts('codex-b')];

    const result = await importer.importProject(projectPath, { force: true, limit });

    if (refused) {
      expect(result.errors).toEqual([
        expect.stringContaining('Skipped force reimport (a message limit'),
        expect.stringContaining('Skipped force reimport (a message limit')
      ]);
      expect(result).toMatchObject({ importedPrompts: 0, importedResponses: 0 });
    } else {
      expect(result).toMatchObject({ importedPrompts: 60, importedResponses: 60, errors: [] });
    }
    expect([await counts('codex-a'), await counts('codex-b')]).toEqual(before);
  });
});

describe('Codex force reimport pre-count', () => {
  it('counts task start, abort and completion, scaffolds and notifications as the import does', async () => {
    const sessionId = 'codex-mixed';
    const file = path.join(root, `rollout-2026-10-01T09-00-00-${sessionId}.jsonl`);
    const event = (payload: Record<string, unknown>) => ({ type: 'event_msg', payload });
    const message = (role: string, content: string, phase?: string) => ({
      type: 'response_item', payload: { type: 'message', role, content, ...(phase ? { phase } : {}) }
    });
    const lines = [
      { type: 'session_meta', payload: { id: sessionId, cwd: root } },
      event({ type: 'task_started', turn_id: 't1' }),
      message('user', 'please review the first release step'),
      message('assistant', 'Looking at the guard first.', 'commentary'),
      message('assistant', answer(1), 'final_answer'),
      event({ type: 'task_complete', turn_id: 't1', last_agent_message: answer(1) }),
      event({ type: 'task_started', turn_id: 't2' }),
      message('user', '<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>'),
      message('user', 'please check the second release step'),
      message('assistant', answer(2)),
      event({ type: 'turn_aborted', turn_id: 't2' }),
      event({ type: 'task_started', turn_id: 't3' }),
      message('user', '<task-notification>background job finished</task-notification>'),
      event({ type: 'task_complete', turn_id: 't3', last_agent_message: 'Background job finished and the results look good.' })
    ];
    lines.forEach((line, i) => appendFileSync(file, `${JSON.stringify({ timestamp: new Date(Date.UTC(2026, 9, 1, 9, i)).toISOString(), ...line })}\n`));
    const importer = createCodexSessionHistoryImporter(memoryService, { sessionsDir: root });
    const first = await importer.importSessionFile(file);
    // The unit of the limit Codex sessions share: stored, recognized and skipped entries.
    const counted = first.importedPrompts + first.importedResponses + first.skippedDuplicates;
    expect(first).toMatchObject({ importedPrompts: 2, importedResponses: 2, skippedDuplicates: 2 });
    const before = await counts(sessionId);

    const atCount = await importer.importSessionFile(file, { force: true, limit: counted });
    expect(atCount.errors).toEqual([expect.stringContaining('Skipped force reimport (a message limit')]);
    const aboveCount = await importer.importSessionFile(file, { force: true, limit: counted + 1 });
    expect(aboveCount).toMatchObject({ importedPrompts: 2, importedResponses: 2, errors: [] });
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

  it.each([
    [2 * PAIRS, true],
    [2 * PAIRS + 1, false]
  ])('with limit %i refuses only when the limit can be reached', async (limit, refused) => {
    const importer = createHermesSessionHistoryImporter(memoryService, { stateDbPath });
    await importer.importSession(sessionId);
    await storeHookRows(memorySessionId);
    const before = await counts(memorySessionId);

    const result = await importer.importSession(sessionId, { force: true, limit });

    if (refused) expect(result.errors).toEqual([expect.stringContaining('Skipped force reimport (a message limit')]);
    else expect(result).toMatchObject({ importedPrompts: PAIRS, importedResponses: PAIRS, errors: [] });
    expect(await counts(memorySessionId)).toEqual(before);
  });

  it('counts notifications, short replies, tool and empty messages as the import does', async () => {
    const mixed = 'hermes-mixed';
    const db = new Database(stateDbPath);
    db.prepare('INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)').run(mixed, 'cli', 1_790_100_000);
    const insert = db.prepare('INSERT INTO messages (session_id, role, content, tool_name, timestamp) VALUES (?, ?, ?, ?, ?)');
    [
      ['user', 'please review the first release step', null],
      ['tool', 'terminal output', 'terminal'],
      ['assistant', answer(1), null],
      ['user', '<task-notification>background job finished</task-notification>', null],
      ['assistant', 'Noted.', null],
      ['user', 'ok', null],
      ['assistant', '', null],
      ['user', 'please check the second release step', null],
      ['assistant', answer(2), null]
    ].forEach(([role, content, tool], i) => insert.run(mixed, role, content, tool, 1_790_100_000 + i));
    db.close();
    const importer = createHermesSessionHistoryImporter(memoryService, { stateDbPath });
    const first = await importer.importSession(mixed);
    const counted = first.importedPrompts + first.importedResponses;
    expect(counted).toBe(5);
    const before = await counts(`hermes:${mixed}`);

    const atCount = await importer.importSession(mixed, { force: true, limit: counted });
    expect(atCount.errors).toEqual([expect.stringContaining('Skipped force reimport (a message limit')]);
    const aboveCount = await importer.importSession(mixed, { force: true, limit: counted + 1 });
    expect(aboveCount).toMatchObject({ importedPrompts: first.importedPrompts, importedResponses: first.importedResponses, errors: [] });
    expect(await counts(`hermes:${mixed}`)).toEqual(before);
  });
});
