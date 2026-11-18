import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { tsxArgs, tsxCommand } from '../helpers/tsx-process.js';

/**
 * Claude Code reports a tool call that started and then failed to
 * PostToolUseFailure, never to PostToolUse. That input has no
 * `tool_response`, only an `error` string (plus `is_interrupt` and
 * `duration_ms`), and is stored as a tool_observation with success: false
 * through the same tool filter, capture policy, privacy filter and
 * truncation as PostToolUse.
 */

const fixture = vi.hoisted(() => ({ input: '' }));

vi.mock('../../src/adapters/claude/hooks/hook-runtime.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/adapters/claude/hooks/hook-runtime.js')>(),
  readStdin: vi.fn(async () => fixture.input)
}));

const SESSION = 'session-failed';
const GITHUB_TOKEN = `ghp_${'a1B2c3D4e5F6'.repeat(3)}`;

let home: string;

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), 'cml-post-tool-use-failure-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('CLAUDE_MEMORY_OPERATIONS_CONFIG_PATH', join(home, 'operations.json'));
});

afterEach(async () => {
  const { shutdownMemoryServices } = await import('../../src/services/memory-service.js');
  await shutdownMemoryServices();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(home, { recursive: true, force: true });
});

function failure(body: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: SESSION,
    transcript_path: join(home, 't.jsonl'),
    cwd: home,
    permission_mode: 'default',
    hook_event_name: 'PostToolUseFailure',
    tool_use_id: 'toolu_1',
    is_interrupt: false,
    duration_ms: 12,
    ...body
  };
}

async function runFailureHook(input: unknown): Promise<string> {
  fixture.input = typeof input === 'string' ? input : JSON.stringify(input);
  const { readToolFailureInput } = await import('../../src/adapters/claude/hooks/post-tool-use-filter.js');
  const { captureToolFailure } = await import('../../src/adapters/claude/hooks/post-tool-use.js');
  const accepted = await readToolFailureInput();
  const output = accepted ? await captureToolFailure(accepted) : '{}';
  const { shutdownMemoryServices } = await import('../../src/services/memory-service.js');
  await shutdownMemoryServices();
  return output;
}

interface StoredObservation {
  content: {
    toolName: string;
    toolInput: Record<string, unknown>;
    toolOutput: string;
    durationMs: number;
    success: boolean;
    errorMessage?: string;
    metadata?: Record<string, unknown>;
  };
  metadata: Record<string, unknown>;
}

function storedObservations(): StoredObservation[] {
  const dbPath = join(home, '.claude-code', 'memory', 'events.sqlite');
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare("SELECT content, metadata FROM events WHERE event_type = 'tool_observation' ORDER BY rowid").all() as Array<{ content: string; metadata: string }>)
      .map((row) => ({ content: JSON.parse(row.content), metadata: JSON.parse(row.metadata) }));
  } finally {
    db.close();
  }
}

function captureSkips(): number {
  const db = new Database(join(home, '.claude-code', 'memory', 'events.sqlite'), { readonly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM pipeline_metrics WHERE stage = 'capture_skipped'").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe('PostToolUseFailure hook', () => {
  it('stores a failed Bash call as an unsuccessful tool observation, however short its error', async () => {
    expect(await runFailureHook(failure({ tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1' }))).toBe('{}');

    const [stored, ...rest] = storedObservations();
    expect(rest).toEqual([]);
    expect(stored.content).toMatchObject({
      toolName: 'Bash',
      toolInput: { command: 'npm test' },
      toolOutput: 'Exit code 1',
      durationMs: 12,
      success: false,
      errorMessage: 'Exit code 1'
    });
    expect(stored.metadata).toMatchObject({ toolName: 'Bash', success: false });
  });

  it('stores an edit that failed while writing with the file it targeted', async () => {
    const file = join(home, 'src', 'frozen.ts');
    await runFailureHook(failure({
      tool_name: 'Edit',
      tool_input: { file_path: file, old_string: 'frozen', new_string: 'thawed' },
      error: `EACCES: permission denied, open '${file}.tmp.8204.253cbb01d128'`
    }));

    const [stored] = storedObservations();
    expect(stored.content.success).toBe(false);
    expect(stored.content.errorMessage).toContain('EACCES: permission denied');
    expect(stored.content.toolInput.file_path).toBe(file);
    expect(stored.content.metadata?.filePath).toBe(file);
  });

  it('removes credentials and private sections from the error before storing it', async () => {
    await runFailureHook(failure({
      tool_name: 'Bash',
      tool_input: { command: 'git push' },
      error: `Exit code 128\nfatal: auth failed for ${GITHUB_TOKEN}\npassword=hunter2-secret\n<private>db host is prod-7</private>`
    }));

    const [stored] = storedObservations();
    for (const text of [stored.content.toolOutput, stored.content.errorMessage ?? '']) {
      expect(text).toContain('Exit code 128');
      expect(text).not.toContain(GITHUB_TOKEN);
      expect(text).not.toContain('hunter2-secret');
      expect(text).not.toContain('prod-7');
    }
  });

  it('keeps the first and last 50 lines of an error longer than 100 lines, like PostToolUse output', async () => {
    const lines = ['Exit code 1', ...Array.from({ length: 299 }, (_, i) => `line ${i}`)];
    await runFailureHook(failure({ tool_name: 'Bash', tool_input: { command: 'npm test' }, error: lines.join('\n') }));

    const [stored] = storedObservations();
    const marker = '\n... [200 lines truncated] ...\n';
    expect(stored.content.toolOutput).toBe([...lines.slice(0, 50), marker, ...lines.slice(-50)].join('\n'));
    expect(stored.content.errorMessage).toBe(stored.content.toolOutput);
  });

  it('keeps the first and last 5000 characters of an error longer than 10000 characters, like PostToolUse output', async () => {
    const error = `Exit code 1\n${'a'.repeat(8000)}${'z'.repeat(8000)}`;
    await runFailureHook(failure({ tool_name: 'Bash', tool_input: { command: 'npm test' }, error }));

    const [stored] = storedObservations();
    const marker = `\n... [${error.length - 10_000} characters truncated] ...\n`;
    expect(stored.content.toolOutput).toBe(`${error.slice(0, 5000)}${marker}${error.slice(-5000)}`);
    expect(stored.content.errorMessage).toBe(stored.content.toolOutput);
  });

  it('stores the duration Claude Code reports, and 0 when it is missing or not a number', async () => {
    await runFailureHook(failure({ tool_name: 'Bash', tool_input: { command: 'a' }, error: 'Exit code 1', duration_ms: 4187 }));
    await runFailureHook(failure({ tool_name: 'Bash', tool_input: { command: 'b' }, error: 'Exit code 1', duration_ms: '4187' }));
    await runFailureHook(failure({ tool_name: 'Bash', tool_input: { command: 'c' }, error: 'Exit code 1', duration_ms: undefined }));

    expect(storedObservations().map((stored) => stored.content.durationMs)).toEqual([4187, 0, 0]);
  });

  it('stores one row for one aborted call (is_interrupt), with no error message when it has none', async () => {
    await runFailureHook(failure({ tool_name: 'Bash', tool_input: { command: 'sleep 100' }, is_interrupt: true }));

    const stored = storedObservations();
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toMatchObject({ success: false, toolOutput: '' });
    expect(stored[0].content).not.toHaveProperty('errorMessage');
  });

  it('skips tools PostToolUse does not store, including an env blocklist', async () => {
    await runFailureHook(failure({ tool_name: 'Read', tool_input: { file_path: join(home, 'none') }, error: 'File does not exist.' }));
    vi.stubEnv('CLAUDE_MEMORY_TOOL_BLOCKLIST', 'Bash');
    await runFailureHook(failure({ tool_name: 'Bash', tool_input: { command: 'false' }, error: 'Exit code 1' }));

    expect(storedObservations()).toEqual([]);
  });

  it('applies the capture policy: a skipped subagent type is counted, not stored', async () => {
    writeFileSync(join(home, 'operations.json'), JSON.stringify({ capturePolicy: { skipSubagentTypes: ['Explore'] } }));

    expect(await runFailureHook(failure({
      tool_name: 'Bash', tool_input: { command: 'false' }, error: 'Exit code 1', agent_id: 'a1', agent_type: 'Explore'
    }))).toBe('{}');

    expect(storedObservations()).toEqual([]);
    expect(captureSkips()).toBe(1);
  });

  it('stores nothing for malformed input', async () => {
    for (const input of ['not json', 'null', JSON.stringify({ session_id: SESSION, error: 'x' })]) {
      expect(await runFailureHook(input)).toBe('{}');
    }
    expect(storedObservations()).toEqual([]);
  });
});

describe('PostToolUseFailure and the pre-edit check, as processes', () => {
  function runProcess(entry: string, payload: Record<string, unknown>) {
    const result = spawnSync(tsxCommand, tsxArgs(join(process.cwd(), 'src', 'hooks', `${entry}.ts`)), {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, HOME: home, CLAUDE_MEMORY_OPERATIONS_CONFIG_PATH: join(home, 'operations.json') },
      timeout: 30_000
    });
    return { status: result.status, stdout: result.stdout };
  }

  it('an edit that failed in one session shows up when another session edits the file', async () => {
    const project = join(home, 'repo');
    const file = join(project, 'src', 'parser.ts');
    mkdirSync(join(project, 'src'), { recursive: true });
    writeFileSync(file, 'export {};\n');
    writeFileSync(join(home, 'operations.json'), JSON.stringify({ preEditCheck: { enabled: true } }));
    // What SessionStart records, so the failure is stored in this project's store.
    const { registerSession } = await import('../../src/core/registry/session-registry.js');
    registerSession(SESSION, project);

    const stored = runProcess('post-tool-use-failure', failure({
      cwd: project,
      tool_name: 'Edit',
      tool_input: { file_path: file, old_string: 'export {};', new_string: 'export const x = 1;' },
      error: `EACCES: permission denied, open '${file}.tmp.8204.253cbb01d128'`
    }));
    expect(stored).toEqual({ status: 0, stdout: '{}\n' });

    const check = runProcess('pre-tool-use', {
      session_id: 'session-next',
      cwd: project,
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: file, old_string: 'export {};', new_string: 'export const y = 2;' },
      tool_use_id: 'toolu_2'
    });
    expect(check.status).toBe(0);
    const context = JSON.parse(check.stdout).hookSpecificOutput.additionalContext as string;
    expect(context).toContain('## Memory About src/parser.ts');
    expect(context).toMatch(/- \[low-trust: tool output\] Edit on this file failed on \d{4}-\d\d-\d\d: EACCES: permission denied, open 'src\/parser\.ts\.tmp\.8204\.253cbb01d128'/);
  }, 60_000);
});
