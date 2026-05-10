import Database = require('better-sqlite3');
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createHermesSessionHistoryImporter,
  HERMES_IMPORTABLE_SESSION_SCAN_FACTOR,
  validateHermesSessions
} from '../../src/services/hermes-session-history-importer.js';

const tempDirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cml-hermes-validation-'));
  tempDirs.push(dir);
  return dir;
}

function createHermesStateDb(dbPath: string, projectA: string, projectB: string) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      user_id TEXT,
      model TEXT,
      model_config TEXT,
      system_prompt TEXT,
      parent_session_id TEXT,
      started_at REAL NOT NULL,
      ended_at REAL,
      end_reason TEXT,
      message_count INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0,
      title TEXT
    );

    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_call_id TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      timestamp REAL NOT NULL,
      token_count INTEGER,
      finish_reason TEXT,
      reasoning TEXT,
      reasoning_content TEXT,
      reasoning_details TEXT,
      codex_reasoning_items TEXT,
      codex_message_items TEXT
    );
  `);

  const insertSession = db.prepare(`
    INSERT INTO sessions (id, source, user_id, model, system_prompt, started_at, title, message_count)
    VALUES (@id, @source, @userId, @model, @systemPrompt, @startedAt, @title, @messageCount)
  `);
  const insertMessage = db.prepare(`
    INSERT INTO messages (session_id, role, content, tool_name, timestamp)
    VALUES (@sessionId, @role, @content, @toolName, @timestamp)
  `);

  insertSession.run({
    id: 'session-a',
    source: 'discord',
    userId: 'user-a',
    model: 'gpt-5.5',
    systemPrompt: `Project Context\nCurrent Session Context\n${projectA}`,
    startedAt: 1_779_000_000,
    title: 'claude-memory-layer thread',
    messageCount: 4
  });
  insertMessage.run({
    sessionId: 'session-a',
    role: 'user',
    content: `please build Hermes SessionDB adapter password=sensitive-fixture-value for ${projectA}`,
    toolName: null,
    timestamp: 1_779_000_001
  });
  insertMessage.run({
    sessionId: 'session-a',
    role: 'assistant',
    content: 'implemented a safe adapter with token=sensitive-fixture-value and no live sync by default',
    toolName: null,
    timestamp: 1_779_000_002
  });
  insertMessage.run({
    sessionId: 'session-a',
    role: 'tool',
    content: 'raw terminal output should never be imported',
    toolName: 'terminal',
    timestamp: 1_779_000_003
  });
  insertMessage.run({
    sessionId: 'session-a',
    role: 'assistant',
    content: '',
    toolName: null,
    timestamp: 1_779_000_004
  });

  insertSession.run({
    id: 'session-b',
    source: 'discord',
    userId: 'user-b',
    model: 'gpt-5.5',
    systemPrompt: `Project Context\n${projectB}`,
    startedAt: 1_779_000_100,
    title: 'other project thread',
    messageCount: 1
  });
  insertMessage.run({
    sessionId: 'session-b',
    role: 'user',
    content: 'this belongs to another project and should not match project a',
    toolName: null,
    timestamp: 1_779_000_101
  });

  insertSession.run({
    id: 'session-no-project',
    source: 'cli',
    userId: 'user-c',
    model: 'gpt-5.5',
    systemPrompt: null,
    startedAt: 1_779_000_200,
    title: null,
    messageCount: 1
  });
  insertMessage.run({
    sessionId: 'session-no-project',
    role: 'user',
    content: 'session without project context should be counted as missing context',
    toolName: null,
    timestamp: 1_779_000_201
  });

  db.close();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Hermes SessionDB validation/import', () => {
  it('dry-runs matching Hermes sessions by project context without exposing transcript content', async () => {
    const dir = tempDir();
    const stateDbPath = join(dir, 'state.db');
    const projectA = join(dir, 'project-a');
    const projectB = join(dir, 'project-b');
    createHermesStateDb(stateDbPath, projectA, projectB);

    const report = await validateHermesSessions({
      stateDbPath,
      projectPath: projectA,
      now: new Date('2026-05-05T00:00:00.000Z')
    });

    expect(report.dryRun).toBe(true);
    expect(report.willMutate).toBe(false);
    expect(report.source.stateDbPath).toBe(stateDbPath);
    expect(report.source.projectPath).toBe(projectA);
    expect(report.source.projectFilterApplied).toBe(true);
    expect(report.totals.sessionsScanned).toBe(3);
    expect(report.totals.sessionsMatched).toBe(1);
    expect(report.totals.messagesRead).toBe(4);
    expect(report.totals.messagesNormalized).toBe(2);
    expect(report.totals.turnsNormalized).toBe(1);
    expect(report.totals.userMessages).toBe(1);
    expect(report.totals.assistantMessages).toBe(1);
    expect(report.totals.skippedUnsupportedMessages).toBe(1);
    expect(report.totals.emptyAssistantMessages).toBe(1);
    expect(report.totals.missingProjectContext).toBe(1);
    expect(report.topSources[0]).toMatchObject({ source: 'discord', sessions: 1, userMessages: 1, assistantMessages: 1 });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('please build Hermes SessionDB adapter');
    expect(serialized).not.toContain('implemented a safe adapter');
    expect(serialized).not.toContain('sensitive-fixture-value');
    expect(serialized).not.toContain('raw terminal output');
    expect(serialized).not.toContain('another project');
  });

  it('imports only matched user/assistant turns, redacts secrets, and skips tool messages', async () => {
    const dir = tempDir();
    const stateDbPath = join(dir, 'state.db');
    const projectA = join(dir, 'project-a');
    const projectB = join(dir, 'project-b');
    createHermesStateDb(stateDbPath, projectA, projectB);

    const memoryService = {
      startSession: vi.fn(async (_sessionId: string, _projectPath?: string) => undefined),
      endSession: vi.fn(async (_sessionId: string) => undefined),
      deleteSessionEvents: vi.fn(async (_sessionId: string) => 0),
      storeUserPrompt: vi.fn(async (
        _sessionId: string,
        _content: string,
        _metadata?: Record<string, unknown>
      ) => ({ success: true, isDuplicate: false })),
      storeAgentResponse: vi.fn(async (
        _sessionId: string,
        _content: string,
        _metadata?: Record<string, unknown>
      ) => ({ success: true, isDuplicate: false }))
    };

    const importer = createHermesSessionHistoryImporter(memoryService as never, { stateDbPath });
    const result = await importer.importProject(projectA, { force: true });

    expect(memoryService.deleteSessionEvents).toHaveBeenCalledWith('hermes:session-a');
    expect(memoryService.startSession).toHaveBeenCalledWith('hermes:session-a', projectA);
    expect(memoryService.endSession).toHaveBeenCalledWith('hermes:session-a');
    expect(memoryService.storeUserPrompt).toHaveBeenCalledTimes(1);
    expect(memoryService.storeAgentResponse).toHaveBeenCalledTimes(1);

    const [promptSessionId, promptContent, promptMetadata] = memoryService.storeUserPrompt.mock.calls[0];
    expect(promptSessionId).toBe('hermes:session-a');
    expect(promptContent).toContain('[REDACTED]');
    expect(promptContent).not.toContain('sensitive-fixture-value');
    expect(promptMetadata).toMatchObject({
      source: 'hermes',
      hermesSource: 'discord',
      sourceSessionId: 'session-a',
      projectPath: projectA,
      importedFrom: stateDbPath
    });

    const [, responseContent, responseMetadata] = memoryService.storeAgentResponse.mock.calls[0];
    expect(responseContent).toContain('[REDACTED]');
    expect(responseContent).not.toContain('sensitive-fixture-value');
    expect(responseMetadata).toMatchObject({
      source: 'hermes',
      hermesSource: 'discord',
      sourceSessionId: 'session-a',
      projectPath: projectA,
      importedFrom: stateDbPath
    });

    expect(result).toMatchObject({
      totalSessions: 1,
      totalMessages: 4,
      importedPrompts: 1,
      importedResponses: 1,
      skippedDuplicates: 0,
      errors: []
    });
  });

  it('imports only the latest matching Hermes session when sessionLimit is set', async () => {
    const dir = tempDir();
    const stateDbPath = join(dir, 'state.db');
    const projectA = join(dir, 'project-a');
    const projectB = join(dir, 'project-b');
    createHermesStateDb(stateDbPath, projectA, projectB);

    const db = new Database(stateDbPath);
    db.prepare(`
      INSERT INTO sessions (id, source, user_id, model, system_prompt, started_at, title, message_count)
      VALUES (@id, @source, @userId, @model, @systemPrompt, @startedAt, @title, @messageCount)
    `).run({
      id: 'session-newer-a',
      source: 'discord',
      userId: 'user-newer',
      model: 'gpt-5.5',
      systemPrompt: `Project Context\n${projectA}`,
      startedAt: 1_779_000_300,
      title: 'newer project a thread',
      messageCount: 1
    });
    db.prepare(`
      INSERT INTO messages (session_id, role, content, tool_name, timestamp)
      VALUES (@sessionId, @role, @content, @toolName, @timestamp)
    `).run({
      sessionId: 'session-newer-a',
      role: 'user',
      content: 'latest Hermes project session should be imported now',
      toolName: null,
      timestamp: 1_779_000_301
    });
    db.close();

    const memoryService = {
      startSession: vi.fn(async (_sessionId: string, _projectPath?: string) => undefined),
      endSession: vi.fn(async (_sessionId: string) => undefined),
      deleteSessionEvents: vi.fn(async (_sessionId: string) => 0),
      storeUserPrompt: vi.fn(async () => ({ success: true, isDuplicate: false })),
      storeAgentResponse: vi.fn(async () => ({ success: true, isDuplicate: false }))
    };

    const importer = createHermesSessionHistoryImporter(memoryService as never, { stateDbPath });
    const result = await importer.importProject(projectA, { sessionLimit: 1 });

    expect(result.totalSessions).toBe(1);
    expect(memoryService.startSession).toHaveBeenCalledTimes(1);
    expect(memoryService.startSession).toHaveBeenCalledWith('hermes:session-newer-a', projectA);
    expect(memoryService.storeUserPrompt).toHaveBeenCalledTimes(1);
  });

  it('skips newer empty Hermes sessions when selecting latest project sessions for import', async () => {
    const dir = tempDir();
    const stateDbPath = join(dir, 'state.db');
    const projectA = join(dir, 'project-a');
    const projectB = join(dir, 'project-b');
    createHermesStateDb(stateDbPath, projectA, projectB);

    const db = new Database(stateDbPath);
    db.prepare(`
      INSERT INTO sessions (id, source, user_id, model, system_prompt, started_at, title, message_count)
      VALUES (@id, @source, @userId, @model, @systemPrompt, @startedAt, @title, @messageCount)
    `).run({
      id: 'session-empty-newest-a',
      source: 'discord',
      userId: 'user-empty',
      model: 'gpt-5.5',
      systemPrompt: `Project Context\n${projectA}`,
      startedAt: 1_779_000_400,
      title: 'newest empty project a routing shell',
      messageCount: 0
    });
    db.prepare(`
      INSERT INTO sessions (id, source, user_id, model, system_prompt, started_at, title, message_count)
      VALUES (@id, @source, @userId, @model, @systemPrompt, @startedAt, @title, @messageCount)
    `).run({
      id: 'session-newer-nonempty-a',
      source: 'discord',
      userId: 'user-newer',
      model: 'gpt-5.5',
      systemPrompt: `Project Context\n${projectA}`,
      startedAt: 1_779_000_300,
      title: 'newer non-empty project a thread',
      messageCount: 1
    });
    db.prepare(`
      INSERT INTO messages (session_id, role, content, tool_name, timestamp)
      VALUES (@sessionId, @role, @content, @toolName, @timestamp)
    `).run({
      sessionId: 'session-newer-nonempty-a',
      role: 'user',
      content: 'latest non-empty Hermes project session should be imported despite newer empty shells',
      toolName: null,
      timestamp: 1_779_000_301
    });
    db.close();

    const memoryService = {
      startSession: vi.fn(async (_sessionId: string, _projectPath?: string) => undefined),
      endSession: vi.fn(async (_sessionId: string) => undefined),
      deleteSessionEvents: vi.fn(async (_sessionId: string) => 0),
      storeUserPrompt: vi.fn(async () => ({ success: true, isDuplicate: false })),
      storeAgentResponse: vi.fn(async () => ({ success: true, isDuplicate: false }))
    };

    const importer = createHermesSessionHistoryImporter(memoryService as never, { stateDbPath });
    const result = await importer.importProject(projectA, { sessionLimit: 1 });

    expect(result.totalSessions).toBe(1);
    expect(result.totalMessages).toBe(1);
    expect(memoryService.startSession).toHaveBeenCalledTimes(1);
    expect(memoryService.startSession).toHaveBeenCalledWith('hermes:session-newer-nonempty-a', projectA);
    expect(memoryService.startSession).not.toHaveBeenCalledWith('hermes:session-empty-newest-a', projectA);
    expect(memoryService.storeUserPrompt).toHaveBeenCalledTimes(1);
  });

  it('skips newer Hermes sessions that cannot store any prompt or response when selecting latest imports', async () => {
    const dir = tempDir();
    const stateDbPath = join(dir, 'state.db');
    const projectA = join(dir, 'project-a');
    const projectB = join(dir, 'project-b');
    createHermesStateDb(stateDbPath, projectA, projectB);

    const db = new Database(stateDbPath);
    const insertSession = db.prepare(`
      INSERT INTO sessions (id, source, user_id, model, system_prompt, started_at, title, message_count)
      VALUES (@id, @source, @userId, @model, @systemPrompt, @startedAt, @title, @messageCount)
    `);
    const insertMessage = db.prepare(`
      INSERT INTO messages (session_id, role, content, tool_name, timestamp)
      VALUES (@sessionId, @role, @content, @toolName, @timestamp)
    `);

    insertSession.run({
      id: 'session-assistant-only-newest-a',
      source: 'discord',
      userId: 'user-assistant-only',
      model: 'gpt-5.5',
      systemPrompt: `Project Context\n${projectA}`,
      startedAt: 1_779_000_500,
      title: 'assistant-only shell',
      messageCount: 1
    });
    insertMessage.run({
      sessionId: 'session-assistant-only-newest-a',
      role: 'assistant',
      content: 'assistant-only content should not make this session consume the freshness slot',
      toolName: null,
      timestamp: 1_779_000_501
    });

    insertSession.run({
      id: 'session-trivial-user-newer-a',
      source: 'discord',
      userId: 'user-trivial',
      model: 'gpt-5.5',
      systemPrompt: `Project Context\n${projectA}`,
      startedAt: 1_779_000_400,
      title: 'trivial user shell',
      messageCount: 2
    });
    insertMessage.run({
      sessionId: 'session-trivial-user-newer-a',
      role: 'user',
      content: 'ok',
      toolName: null,
      timestamp: 1_779_000_401
    });
    insertMessage.run({
      sessionId: 'session-trivial-user-newer-a',
      role: 'assistant',
      content: 'assistant response after trivial prompt should not be stored without a real turn',
      toolName: null,
      timestamp: 1_779_000_402
    });

    insertSession.run({
      id: 'session-meaningful-older-a',
      source: 'discord',
      userId: 'user-meaningful',
      model: 'gpt-5.5',
      systemPrompt: `Project Context\n${projectA}`,
      startedAt: 1_779_000_300,
      title: 'meaningful project a thread',
      messageCount: 2
    });
    insertMessage.run({
      sessionId: 'session-meaningful-older-a',
      role: 'user',
      content: 'meaningful Hermes prompt should be selected after newer non-storable shells',
      toolName: null,
      timestamp: 1_779_000_301
    });
    insertMessage.run({
      sessionId: 'session-meaningful-older-a',
      role: 'assistant',
      content: 'meaningful Hermes response should be imported after the selected prompt',
      toolName: null,
      timestamp: 1_779_000_302
    });
    db.close();

    const memoryService = {
      startSession: vi.fn(async (_sessionId: string, _projectPath?: string) => undefined),
      endSession: vi.fn(async (_sessionId: string) => undefined),
      deleteSessionEvents: vi.fn(async (_sessionId: string) => 0),
      storeUserPrompt: vi.fn(async () => ({ success: true, isDuplicate: false })),
      storeAgentResponse: vi.fn(async () => ({ success: true, isDuplicate: false }))
    };

    const importer = createHermesSessionHistoryImporter(memoryService as never, { stateDbPath });
    const result = await importer.importProject(projectA, { sessionLimit: 1 });

    expect(result.totalSessions).toBe(1);
    expect(result.totalMessages).toBe(2);
    expect(result.importedPrompts).toBe(1);
    expect(result.importedResponses).toBe(1);
    expect(memoryService.startSession).toHaveBeenCalledTimes(1);
    expect(memoryService.startSession).toHaveBeenCalledWith('hermes:session-meaningful-older-a', projectA);
    expect(memoryService.startSession).not.toHaveBeenCalledWith('hermes:session-assistant-only-newest-a', projectA);
    expect(memoryService.startSession).not.toHaveBeenCalledWith('hermes:session-trivial-user-newer-a', projectA);
  });

  it('bounds finite sessionLimit freshness selection to the newest candidate window', async () => {
    const dir = tempDir();
    const stateDbPath = join(dir, 'state.db');
    const projectA = join(dir, 'project-a');
    const projectB = join(dir, 'project-b');
    createHermesStateDb(stateDbPath, projectA, projectB);

    const db = new Database(stateDbPath);
    const insertSession = db.prepare(`
      INSERT INTO sessions (id, source, user_id, model, system_prompt, started_at, title, message_count)
      VALUES (@id, @source, @userId, @model, @systemPrompt, @startedAt, @title, @messageCount)
    `);
    const insertMessage = db.prepare(`
      INSERT INTO messages (session_id, role, content, tool_name, timestamp)
      VALUES (@sessionId, @role, @content, @toolName, @timestamp)
    `);

    const freshnessScanWindow = HERMES_IMPORTABLE_SESSION_SCAN_FACTOR;
    for (let index = 0; index < freshnessScanWindow + 1; index++) {
      const sessionId = `session-assistant-shell-${index}`;
      insertSession.run({
        id: sessionId,
        source: 'discord',
        userId: `user-shell-${index}`,
        model: 'gpt-5.5',
        systemPrompt: `Project Context\n${projectA}`,
        startedAt: 1_779_001_000 - index,
        title: `assistant-only shell ${index}`,
        messageCount: 1
      });
      insertMessage.run({
        sessionId,
        role: 'assistant',
        content: 'assistant-only shell content should not trigger deep freshness scans',
        toolName: null,
        timestamp: 1_779_001_000 - index + 0.1
      });
    }

    insertSession.run({
      id: 'session-meaningful-beyond-window-a',
      source: 'discord',
      userId: 'user-meaningful',
      model: 'gpt-5.5',
      systemPrompt: `Project Context\n${projectA}`,
      startedAt: 1_779_000_100,
      title: 'meaningful but outside freshness window',
      messageCount: 1
    });
    insertMessage.run({
      sessionId: 'session-meaningful-beyond-window-a',
      role: 'user',
      content: 'meaningful Hermes prompt should not be reached beyond the bounded freshness scan window',
      toolName: null,
      timestamp: 1_779_000_101
    });
    db.close();

    const memoryService = {
      startSession: vi.fn(async (_sessionId: string, _projectPath?: string) => undefined),
      endSession: vi.fn(async (_sessionId: string) => undefined),
      deleteSessionEvents: vi.fn(async (_sessionId: string) => 0),
      storeUserPrompt: vi.fn(async () => ({ success: true, isDuplicate: false })),
      storeAgentResponse: vi.fn(async () => ({ success: true, isDuplicate: false }))
    };

    const importer = createHermesSessionHistoryImporter(memoryService as never, { stateDbPath });
    const result = await importer.importProject(projectA, { sessionLimit: 1 });

    expect(result.totalSessions).toBe(0);
    expect(memoryService.startSession).not.toHaveBeenCalled();
    expect(memoryService.storeUserPrompt).not.toHaveBeenCalled();
  });

  it('applies Hermes import limit per selected matching session', async () => {
    const dir = tempDir();
    const stateDbPath = join(dir, 'state.db');
    const projectA = join(dir, 'project-a');
    const projectB = join(dir, 'project-b');
    createHermesStateDb(stateDbPath, projectA, projectB);

    const db = new Database(stateDbPath);
    db.prepare(`
      INSERT INTO sessions (id, source, user_id, model, system_prompt, started_at, title, message_count)
      VALUES (@id, @source, @userId, @model, @systemPrompt, @startedAt, @title, @messageCount)
    `).run({
      id: 'session-newer-a',
      source: 'discord',
      userId: 'user-newer',
      model: 'gpt-5.5',
      systemPrompt: `Project Context\n${projectA}`,
      startedAt: 1_779_000_300,
      title: 'newer project a thread',
      messageCount: 2
    });
    const insertMessage = db.prepare(`
      INSERT INTO messages (session_id, role, content, tool_name, timestamp)
      VALUES (@sessionId, @role, @content, @toolName, @timestamp)
    `);
    insertMessage.run({
      sessionId: 'session-newer-a',
      role: 'user',
      content: 'latest Hermes project prompt should be imported under per-session limit',
      toolName: null,
      timestamp: 1_779_000_301
    });
    insertMessage.run({
      sessionId: 'session-newer-a',
      role: 'assistant',
      content: 'latest Hermes response should be skipped by a per-session limit of one',
      toolName: null,
      timestamp: 1_779_000_302
    });
    db.close();

    const memoryService = {
      startSession: vi.fn(async (_sessionId: string, _projectPath?: string) => undefined),
      endSession: vi.fn(async (_sessionId: string) => undefined),
      deleteSessionEvents: vi.fn(async (_sessionId: string) => 0),
      storeUserPrompt: vi.fn(async () => ({ success: true, isDuplicate: false })),
      storeAgentResponse: vi.fn(async () => ({ success: true, isDuplicate: false }))
    };

    const importer = createHermesSessionHistoryImporter(memoryService as never, { stateDbPath });
    const result = await importer.importProject(projectA, { sessionLimit: 2, limit: 1 });

    expect(result.totalSessions).toBe(2);
    expect(memoryService.startSession).toHaveBeenCalledTimes(2);
    expect(memoryService.startSession).toHaveBeenCalledWith('hermes:session-newer-a', projectA);
    expect(memoryService.startSession).toHaveBeenCalledWith('hermes:session-a', projectA);
    expect(memoryService.storeUserPrompt).toHaveBeenCalledTimes(2);
    expect(memoryService.storeAgentResponse).not.toHaveBeenCalled();
  });
});
