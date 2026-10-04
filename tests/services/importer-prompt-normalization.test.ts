import Database = require('better-sqlite3');
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DISABLED_SHARED_STORE_CONFIG, MemoryService } from '../../src/services/memory-service.js';
import { SessionHistoryImporter } from '../../src/services/session-history-importer.js';
import { createCodexSessionHistoryImporter } from '../../src/services/codex-session-history-importer.js';
import { createHermesSessionHistoryImporter } from '../../src/services/hermes-session-history-importer.js';
import { redactPromptForStorage } from '../../src/core/prompt-normalizer.js';

/**
 * specs/memory-usage-followup-2026-10-03 R1: every importer applies the same
 * normalizer -> privacy policy as the native hook, opens a turn for automated
 * notifications without storing them, and recognizes legacy raw/redacted rows.
 */

const TOKEN = 'stg_import0123456789abcdefghijklmn';
const WRAPPER = `If this turn corrects an earlier mistake or verifies recovery from a failure, you may propose one reusable project lesson before finishing. Use mcp__happy__propose_lesson with token="${TOKEN}" and proposal containing name. Do not perform extra work just to generate a lesson.`;
const TITLE = 'Based on this message, call functions.happy__change_title once to generate a concise chat session title. The title locks after it is first set, so do not call this function again.';
const NOTIFICATION = '<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>';
const REQUEST = '배포 워크플로우를 고쳐줘 password=hunter2-fixture';
const STORED_REQUEST = redactPromptForStorage(REQUEST);
const LONG_REPLY = (label: string) => `${label}: ${'the release workflow now runs from the tag push and the manual publish path is removed. '.repeat(3)}`;

const dirs: string[] = [];
const services: MemoryService[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cml-import-normalize-'));
  dirs.push(dir);
  return dir;
}
function realService(): MemoryService {
  const service = new MemoryService({
    storagePath: tempDir(),
    sharedStoreConfig: DISABLED_SHARED_STORE_CONFIG,
    lightweightMode: true
  });
  services.push(service);
  return service;
}
function writeJsonl(filePath: string, records: unknown[]): void {
  writeFileSync(filePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
}

afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function claudeRecords() {
  const user = (content: string) => ({ type: 'user', timestamp: '2026-10-01T00:00:00.000Z', message: { role: 'user', content } });
  const assistant = (text: string) => ({ type: 'assistant', timestamp: '2026-10-01T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  return [
    user(`${WRAPPER}\n\n${REQUEST}\n\n${TITLE}`),
    assistant(LONG_REPLY('first answer')),
    user(NOTIFICATION),
    assistant(LONG_REPLY('notification reply')),
    user(`${WRAPPER}\n\n${TITLE}`)
  ];
}

async function sessionEvents(service: MemoryService, sessionId: string) {
  const events = await service.getSessionHistory(sessionId);
  return {
    prompts: events.filter((event) => event.eventType === 'user_prompt'),
    responses: events.filter((event) => event.eventType === 'agent_response')
  };
}

describe('importer prompt normalization', () => {
  it.each([
    ['claude', 'legacy'], ['codex', 'legacy'], ['hermes', 'legacy'],
    ['claude', 'normalized'], ['codex', 'normalized'], ['hermes', 'normalized']
  ] as const)('%s: an assistant copy of the %s prompt does not suppress the actual user prompt', async (source, copyForm) => {
    const service = realService();
    const dir = tempDir();
    const sessionId = 'role-collision';
    const memorySessionId = source === 'hermes' ? `hermes:${sessionId}` : sessionId;
    const request = '메모리 조회 로직의 오류를 검토하고 고쳐줘';
    const raw = `${WRAPPER}\n\n${request}`;
    await service.storeAgentResponse(memorySessionId, copyForm === 'legacy' ? redactPromptForStorage(raw) : request, { turnId: 'earlier-answer' });

    if (source === 'claude') {
      const file = join(dir, `${sessionId}.jsonl`);
      writeJsonl(file, [{ type: 'user', message: { role: 'user', content: raw } }]);
      await new SessionHistoryImporter(service).importSessionFile(file);
    } else if (source === 'codex') {
      const file = join(dir, `rollout-${sessionId}.jsonl`);
      writeJsonl(file, [
        { type: 'session_meta', payload: { id: sessionId, cwd: dir } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: raw }] } }
      ]);
      await createCodexSessionHistoryImporter(service, { sessionsDir: dir }).importSessionFile(file);
    } else {
      const stateDbPath = join(dir, 'state.db');
      const db = new Database(stateDbPath);
      db.exec(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, user_id TEXT, model TEXT, system_prompt TEXT,
          started_at REAL, ended_at REAL, title TEXT);
        CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_name TEXT, timestamp REAL);
      `);
      db.prepare(`INSERT INTO sessions VALUES (?, 'cli', NULL, NULL, NULL, 1779000000, NULL, NULL)`).run(sessionId);
      db.prepare(`INSERT INTO messages VALUES (1, ?, 'user', ?, NULL, 1779000001)`).run(sessionId, raw);
      db.close();
      await createHermesSessionHistoryImporter(service, { stateDbPath }).importSession(sessionId);
    }

    expect((await sessionEvents(service, memorySessionId)).prompts.map((event) => event.content)).toEqual([request]);
  });

  it('Claude: stores the normalized redacted request, splits notification turns, and is idempotent', async () => {
    const service = realService();
    const file = join(tempDir(), 'claude-session.jsonl');
    writeJsonl(file, claudeRecords());
    const importer = new SessionHistoryImporter(service);

    const first = await importer.importSessionFile(file);
    expect(first).toMatchObject({ importedPrompts: 1, importedResponses: 2, errors: [] });
    const { prompts, responses } = await sessionEvents(service, 'claude-session');
    expect(prompts.map((event) => event.content)).toEqual([STORED_REQUEST]);
    expect(prompts[0].content).not.toContain('hunter2-fixture');
    expect(prompts[0].metadata).toMatchObject({ promptClassifier: { version: 2, kind: 'user', removed: ['lesson_proposal_wrapper', 'title_directive'] } });
    const promptTurn = prompts[0].metadata?.turnId;
    const answer = responses.find((event) => event.content.startsWith('first answer'))!;
    const notificationReply = responses.find((event) => event.content.startsWith('notification reply'))!;
    expect(answer.metadata?.turnId).toBe(promptTurn);
    expect(answer.metadata?.turnTrigger).toBeUndefined();
    expect(notificationReply.metadata?.turnId).not.toBe(promptTurn);
    expect(notificationReply.metadata?.turnTrigger).toBe('task_notification');
    expect(JSON.stringify(await service.getSessionHistory('claude-session'))).not.toContain(TOKEN);

    const second = await importer.importSessionFile(file);
    expect(second).toMatchObject({ importedPrompts: 0, importedResponses: 0 });
    expect((await sessionEvents(service, 'claude-session')).prompts).toHaveLength(1);

    // force keeps its delete-then-reimport behavior.
    const forced = await importer.importSessionFile(file, { force: true });
    expect(forced).toMatchObject({ importedPrompts: 1, importedResponses: 2 });
    expect((await sessionEvents(service, 'claude-session')).prompts).toHaveLength(1);
  });

  it('Claude: skips prompts already stored raw by older imports or redacted by the older hook', async () => {
    for (const legacyContent of [`${WRAPPER}\n\n${REQUEST}\n\n${TITLE}`, redactPromptForStorage(`${WRAPPER}\n\n${REQUEST}\n\n${TITLE}`)]) {
      const service = realService();
      const file = join(tempDir(), 'legacy-session.jsonl');
      writeJsonl(file, claudeRecords());
      await service.storeUserPrompt('legacy-session', legacyContent, { turnId: 'old-turn' });

      const result = await new SessionHistoryImporter(service).importSessionFile(file);
      expect(result.importedPrompts).toBe(0);
      expect((await sessionEvents(service, 'legacy-session')).prompts.map((event) => event.content)).toEqual([legacyContent]);
    }
  });

  it('Claude: a hook-stored normalized prompt is not duplicated by a later import', async () => {
    const service = realService();
    const file = join(tempDir(), 'hook-session.jsonl');
    writeJsonl(file, claudeRecords());
    await service.storeUserPrompt('hook-session', STORED_REQUEST, { turnId: 'hook-turn' });
    const result = await new SessionHistoryImporter(service).importSessionFile(file);
    expect(result.importedPrompts).toBe(0);
    expect((await sessionEvents(service, 'hook-session')).prompts).toHaveLength(1);
  });

  it('Codex: applies the same policy with its existing (no trivial-length) filter', async () => {
    const service = realService();
    const sessionsDir = tempDir();
    const file = join(sessionsDir, 'rollout-2026-10-01T00-00-00-codex-session.jsonl');
    const message = (role: string, text: string) => ({
      type: 'response_item', timestamp: '2026-10-01T00:00:00.000Z',
      payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] }
    });
    writeJsonl(file, [
      { type: 'session_meta', payload: { id: 'codex-session', cwd: sessionsDir } },
      message('user', `${WRAPPER}\n\n${REQUEST}`),
      message('assistant', LONG_REPLY('codex answer')),
      message('user', NOTIFICATION),
      message('assistant', LONG_REPLY('codex notification reply')),
      message('user', 'ok')
    ]);
    const importer = createCodexSessionHistoryImporter(service, { sessionsDir });

    const first = await importer.importSessionFile(file);
    expect(first.errors).toEqual([]);
    const { prompts, responses } = await sessionEvents(service, 'codex-session');
    expect(prompts.map((event) => event.content)).toEqual([STORED_REQUEST, 'ok']);
    expect(responses.find((event) => event.content.startsWith('codex notification reply'))?.metadata?.turnTrigger).toBe('task_notification');

    const second = await importer.importSessionFile(file);
    expect(second.importedPrompts).toBe(0);
  });

  it('Hermes: normalizes before the trivial and privacy filters and checks legacy content', async () => {
    const dir = tempDir();
    const stateDbPath = join(dir, 'state.db');
    const projectPath = join(dir, 'project');
    const db = new Database(stateDbPath);
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, model TEXT, model_config TEXT,
        system_prompt TEXT, parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL, end_reason TEXT,
        message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0, title TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, token_count INTEGER,
        finish_reason TEXT, reasoning TEXT, reasoning_content TEXT, reasoning_details TEXT, codex_reasoning_items TEXT,
        codex_message_items TEXT);
    `);
    db.prepare(`INSERT INTO sessions (id, source, system_prompt, started_at, message_count) VALUES (?, 'cli', ?, 1779000000, 4)`)
      .run('h1', `Project Context\n${projectPath}`);
    const insert = db.prepare(`INSERT INTO messages (session_id, role, content, timestamp) VALUES ('h1', ?, ?, ?)`);
    insert.run('user', `${WRAPPER}\n\n${REQUEST}\n\n${TITLE}`, 1779000001);
    insert.run('assistant', 'answered the request with the release workflow', 1779000002);
    insert.run('user', NOTIFICATION, 1779000003);
    insert.run('assistant', 'reply to the background notification', 1779000004);
    insert.run('user', `${WRAPPER}\n\nok`, 1779000005);
    db.close();

    const memoryService = {
      startSession: vi.fn(async () => undefined),
      endSession: vi.fn(async () => undefined),
      evaluateSessionHelpfulness: vi.fn(async () => undefined),
      deleteSessionEvents: vi.fn(async () => 0),
      hasSessionUserPrompt: vi.fn(async () => false),
      storeUserPrompt: vi.fn(async (_s: string, _c: string, _m?: Record<string, unknown>) => ({ success: true, isDuplicate: false })),
      storeAgentResponse: vi.fn(async (_s: string, _c: string, _m?: Record<string, unknown>) => ({ success: true, isDuplicate: false }))
    };
    await createHermesSessionHistoryImporter(memoryService as never, { stateDbPath }).importProject(projectPath);

    expect(memoryService.storeUserPrompt).toHaveBeenCalledTimes(1);
    const [, content, metadata] = memoryService.storeUserPrompt.mock.calls[0];
    expect(content).toBe(STORED_REQUEST);
    expect(metadata).toMatchObject({ promptClassifier: { kind: 'user' }, source: 'hermes' });
    expect(memoryService.hasSessionUserPrompt).toHaveBeenCalledWith('hermes:h1', [expect.not.stringContaining('hunter2-fixture')]);
    const replies = memoryService.storeAgentResponse.mock.calls.map(([, text, meta]) => ({ text, trigger: meta?.turnTrigger }));
    expect(replies).toEqual([
      { text: 'answered the request with the release workflow', trigger: undefined },
      { text: 'reply to the background notification', trigger: 'task_notification' }
    ]);
    expect(JSON.stringify(memoryService.storeUserPrompt.mock.calls)).not.toContain(TOKEN);
  });

  it('Hermes: redacts a credential that crosses the content bound instead of storing its prefix', async () => {
    const dir = tempDir();
    const stateDbPath = join(dir, 'state.db');
    const projectPath = join(dir, 'project');
    const credential = `ghp_${'A1b2C3d4E5'.repeat(3)}abcdef`;
    expect(credential).toMatch(/^ghp_[a-zA-Z0-9]{36}$/);
    // Place the credential so the 10,000-character bound cuts it in half.
    const request = `${WRAPPER}\n\n${'배포 설정 '.repeat(1)}${'x'.repeat(10_000 - 20)} ${credential} tail`;
    const db = new Database(stateDbPath);
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, model TEXT, model_config TEXT,
        system_prompt TEXT, parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL, end_reason TEXT,
        message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0, title TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, token_count INTEGER,
        finish_reason TEXT, reasoning TEXT, reasoning_content TEXT, reasoning_details TEXT, codex_reasoning_items TEXT,
        codex_message_items TEXT);
    `);
    db.prepare(`INSERT INTO sessions (id, source, system_prompt, started_at, message_count) VALUES ('h2', 'cli', ?, 1779000000, 1)`)
      .run(`Project Context\n${projectPath}`);
    db.prepare(`INSERT INTO messages (session_id, role, content, timestamp) VALUES ('h2', 'user', ?, 1779000001)`).run(request);
    db.close();

    const memoryService = {
      startSession: vi.fn(async () => undefined),
      endSession: vi.fn(async () => undefined),
      evaluateSessionHelpfulness: vi.fn(async () => undefined),
      deleteSessionEvents: vi.fn(async () => 0),
      hasSessionUserPrompt: vi.fn(async () => false),
      storeUserPrompt: vi.fn(async (_s: string, _c: string, _m?: Record<string, unknown>) => ({ success: true, isDuplicate: false })),
      storeAgentResponse: vi.fn(async () => ({ success: true, isDuplicate: false }))
    };
    await createHermesSessionHistoryImporter(memoryService as never, { stateDbPath }).importProject(projectPath);

    expect(memoryService.storeUserPrompt).toHaveBeenCalledTimes(1);
    const stored = memoryService.storeUserPrompt.mock.calls[0][1];
    expect(stored).not.toContain('ghp_');
    expect(stored).not.toContain(credential.slice(0, 12));
    expect(stored).not.toContain(TOKEN);
  });

  it('Claude: a short reply after a notification opens a user turn without storing the short prompt', async () => {
    const service = realService();
    const file = join(tempDir(), 'claude-short.jsonl');
    const user = (content: string) => ({ type: 'user', message: { role: 'user', content } });
    const assistant = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
    writeJsonl(file, [
      user(NOTIFICATION),
      assistant(LONG_REPLY('notification reply')),
      user('ok thanks'),
      assistant(LONG_REPLY('human reply'))
    ]);
    await new SessionHistoryImporter(service).importSessionFile(file);
    const { prompts, responses } = await sessionEvents(service, 'claude-short');
    expect(prompts).toHaveLength(0);
    const automated = responses.find((event) => event.content.startsWith('notification reply'))!;
    const human = responses.find((event) => event.content.startsWith('human reply'))!;
    expect(automated.metadata?.turnTrigger).toBe('task_notification');
    expect(human.metadata?.turnTrigger).toBeUndefined();
    expect(human.metadata?.turnId).toBeDefined();
    expect(human.metadata?.turnId).not.toBe(automated.metadata?.turnId);
  });

  it('Hermes: a short reply after a notification opens a user turn without storing the short prompt', async () => {
    const dir = tempDir();
    const stateDbPath = join(dir, 'state.db');
    const projectPath = join(dir, 'project');
    const db = new Database(stateDbPath);
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, model TEXT, model_config TEXT,
        system_prompt TEXT, parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL, end_reason TEXT,
        message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0, title TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, token_count INTEGER,
        finish_reason TEXT, reasoning TEXT, reasoning_content TEXT, reasoning_details TEXT, codex_reasoning_items TEXT,
        codex_message_items TEXT);
    `);
    db.prepare(`INSERT INTO sessions (id, source, system_prompt, started_at, message_count) VALUES ('h3', 'cli', ?, 1779000000, 5)`)
      .run(`Project Context\n${projectPath}`);
    const insert = db.prepare(`INSERT INTO messages (session_id, role, content, timestamp) VALUES ('h3', ?, ?, ?)`);
    insert.run('user', `${REQUEST} 배포 순서를 정리해줘`, 1779000001);
    insert.run('assistant', 'answer to the real request', 1779000002);
    insert.run('user', NOTIFICATION, 1779000003);
    insert.run('assistant', 'reply to the notification', 1779000004);
    insert.run('user', 'ok thanks', 1779000005);
    insert.run('assistant', 'reply to the short human message', 1779000006);
    db.close();

    const memoryService = {
      startSession: vi.fn(async () => undefined),
      endSession: vi.fn(async () => undefined),
      evaluateSessionHelpfulness: vi.fn(async () => undefined),
      deleteSessionEvents: vi.fn(async () => 0),
      hasSessionUserPrompt: vi.fn(async () => false),
      storeUserPrompt: vi.fn(async (_s: string, _c: string, _m?: Record<string, unknown>) => ({ success: true, isDuplicate: false })),
      storeAgentResponse: vi.fn(async (_s: string, _c: string, _m?: Record<string, unknown>) => ({ success: true, isDuplicate: false }))
    };
    await createHermesSessionHistoryImporter(memoryService as never, { stateDbPath }).importProject(projectPath);

    expect(memoryService.storeUserPrompt).toHaveBeenCalledTimes(1);
    expect(memoryService.storeUserPrompt.mock.calls[0][1]).not.toBe('ok thanks');
    const replies = memoryService.storeAgentResponse.mock.calls.map(([, text, meta]) => ({ text, turnId: meta?.turnId, trigger: meta?.turnTrigger }));
    expect(replies.map(({ text, trigger }) => ({ text, trigger }))).toEqual([
      { text: 'answer to the real request', trigger: undefined },
      { text: 'reply to the notification', trigger: 'task_notification' },
      { text: 'reply to the short human message', trigger: undefined }
    ]);
    expect(new Set(replies.map((reply) => reply.turnId)).size).toBe(3);
  });
});
