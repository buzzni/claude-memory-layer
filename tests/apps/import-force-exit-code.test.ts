import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import Database = require('better-sqlite3');
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tsxArgs, tsxCommand } from '../helpers/tsx-process.js';

/**
 * #227: a force reimport the --limit could cut short is skipped and the
 * command exits 1; one the limit cannot reach runs (exit 0); one skipped
 * because the source has nothing to read stays a warning (exit 0).
 * Each source below holds 3 prompts and 3 responses, so it counts 6.
 */

const LIMIT_SKIP = 'Skipped force reimport (a message limit';
const UNREADABLE_SKIP = 'Skipped force reimport (no parseable records)';
const answer = (i: number) => `Step ${i}: ${'The release guard checks the tag against the package version. '.repeat(3)}`;

let home = '';
let project = '';

function cli(...args: string[]): { status: number | null; output: string } {
  const result = spawnSync(tsxCommand, tsxArgs('src/apps/cli/index.ts', ...args), {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    encoding: 'utf8'
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'cml-import-force-exit-'));
  project = path.join(home, 'work', 'app');
  mkdirSync(project, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('import --force exit codes', () => {
  it('claude import', () => {
    const dir = path.join(home, '.claude', 'projects', project.replace(/[\\/]/g, '-'));
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 3; i++) {
      appendFileSync(path.join(dir, 'exit-session.jsonl'), [
        { type: 'user', message: { role: 'user', content: `please review release step number ${i}` } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: answer(i) }] } }
      ].map((line) => `${JSON.stringify({ sessionId: 'exit-session', timestamp: new Date(Date.UTC(2026, 9, 1, 9, i)).toISOString(), ...line })}\n`).join(''));
    }
    const torn = path.join(home, 'torn-session.jsonl');
    writeFileSync(torn, '{"type":"user","mess\n');

    const reached = cli('import', '--project', project, '--force', '--limit', '6');
    expect(reached.status).toBe(1);
    expect(reached.output).toContain(LIMIT_SKIP);
    expect(cli('import', '--project', project, '--force', '--limit', '7').status).toBe(0);
    const unreadable = cli('import', '--project', project, '--session', torn, '--force');
    expect(unreadable.status).toBe(0);
    expect(unreadable.output).toContain(UNREADABLE_SKIP);
  }, 120_000);

  it('codex import', () => {
    const sessionsDir = path.join(home, 'codex-sessions');
    mkdirSync(sessionsDir);
    const lines: Array<Record<string, unknown>> = [{ type: 'session_meta', payload: { id: 'codex-exit', cwd: project } }];
    for (let i = 0; i < 3; i++) {
      lines.push({ type: 'response_item', payload: { type: 'message', role: 'user', content: `please review release step number ${i}` } });
      lines.push({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: answer(i) } });
    }
    writeFileSync(path.join(sessionsDir, 'rollout-2026-10-01T09-00-00-codex-exit.jsonl'), lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
    const torn = path.join(home, 'rollout-2026-10-01T09-00-00-codex-torn.jsonl');
    writeFileSync(torn, `${JSON.stringify({ type: 'session_meta', payload: { id: 'codex-torn', cwd: project } })}\n{"type":"response_item","pay\n`);
    const codex = (...args: string[]) => cli('codex', 'import', '--project', project, '--sessions-dir', sessionsDir, '--no-process-embeddings', ...args);

    const reached = codex('--force', '--limit', '6');
    expect(reached.status).toBe(1);
    expect(reached.output).toContain(LIMIT_SKIP);
    expect(codex('--force', '--limit', '7').status).toBe(0);
    const unreadable = codex('--session', torn, '--force');
    expect(unreadable.status).toBe(0);
    expect(unreadable.output).toContain(UNREADABLE_SKIP);
  }, 120_000);

  it('hermes import', () => {
    const stateDb = path.join(home, 'state.db');
    const db = new Database(stateDb);
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, model TEXT, model_config TEXT,
        system_prompt TEXT, parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL, end_reason TEXT,
        message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0, title TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL);
    `);
    const insertSession = db.prepare('INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)');
    const insert = db.prepare('INSERT INTO messages (session_id, role, content, tool_name, timestamp) VALUES (?, ?, ?, ?, ?)');
    insertSession.run('hermes-exit', 'cli', 1_790_000_000);
    for (let i = 0; i < 3; i++) {
      insert.run('hermes-exit', 'user', `please review release step number ${i}`, null, 1_790_000_000 + i * 2);
      insert.run('hermes-exit', 'assistant', answer(i), null, 1_790_000_001 + i * 2);
    }
    insertSession.run('hermes-tools', 'cli', 1_790_000_100);
    insert.run('hermes-tools', 'tool', 'terminal output', 'terminal', 1_790_000_101);
    db.close();
    const hermes = (...args: string[]) => cli('hermes', 'import', '--project', project, '--state-db', stateDb, '--no-process-embeddings', ...args);

    const reached = hermes('--session', 'hermes-exit', '--force', '--limit', '6');
    expect(reached.status).toBe(1);
    expect(reached.output).toContain(LIMIT_SKIP);
    expect(hermes('--session', 'hermes-exit', '--force', '--limit', '7').status).toBe(0);
    const unreadable = hermes('--session', 'hermes-tools', '--force');
    expect(unreadable.status).toBe(0);
    expect(unreadable.output).toContain(UNREADABLE_SKIP);
  }, 120_000);
});
