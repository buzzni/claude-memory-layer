import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/**
 * PostToolUse and PostToolUseFailure store three strings from a tool call:
 * its input, its output and its error (stderr, or the failure's `error`). All
 * three reach the local store and, through mongo-sync, MongoDB, so each one
 * goes through the same privacy filter the output always had: `<private>`
 * sections, credential patterns and the hook's exclude patterns are masked
 * before storage, and the filter runs before truncation so a cut can never
 * split a `<private>` section open.
 */

const fixture = vi.hoisted(() => ({ input: '' }));

vi.mock('../../src/adapters/claude/hooks/hook-runtime.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/adapters/claude/hooks/hook-runtime.js')>(),
  readStdin: vi.fn(async () => fixture.input)
}));

const SESSION = 'session-post-tool-use-privacy';
const GITHUB_TOKEN = `ghp_${'a1B2c3D4e5'.repeat(3)}abcdef`;

let home: string;

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), 'cml-post-tool-use-privacy-'));
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

interface StoredObservation {
  toolInput: Record<string, unknown>;
  toolOutput: string;
  success: boolean;
  errorMessage?: string;
}

async function runPostToolUse(body: Record<string, unknown>): Promise<StoredObservation> {
  fixture.input = JSON.stringify({ session_id: SESSION, cwd: home, hook_event_name: 'PostToolUse', tool_use_id: 'toolu_1', ...body });
  const { main } = await import('../../src/adapters/claude/hooks/post-tool-use.js');
  expect(await main()).toBe('{}');
  return storedObservation();
}

async function runPostToolUseFailure(body: Record<string, unknown>): Promise<StoredObservation> {
  fixture.input = JSON.stringify({ session_id: SESSION, cwd: home, hook_event_name: 'PostToolUseFailure', tool_use_id: 'toolu_1', ...body });
  const { readToolFailureInput } = await import('../../src/adapters/claude/hooks/post-tool-use-filter.js');
  const { captureToolFailure } = await import('../../src/adapters/claude/hooks/post-tool-use.js');
  const accepted = await readToolFailureInput();
  expect(accepted).not.toBeNull();
  expect(await captureToolFailure(accepted!)).toBe('{}');
  return storedObservation();
}

/** The one tool_observation row in the temp store. */
async function storedObservation(): Promise<StoredObservation> {
  const { shutdownMemoryServices } = await import('../../src/services/memory-service.js');
  await shutdownMemoryServices();
  const dbPath = join(home, '.claude-code', 'memory', 'events.sqlite');
  expect(existsSync(dbPath)).toBe(true);
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare("SELECT content FROM events WHERE event_type = 'tool_observation' ORDER BY rowid").all() as Array<{ content: string }>;
    expect(rows).toHaveLength(1);
    return JSON.parse(rows[0].content) as StoredObservation;
  } finally {
    db.close();
  }
}

/** 150 lines with a `<private>` section on lines 40-60, across the 50-line head the truncation keeps. */
function linesWithPrivateAcrossTruncation(): string {
  const lines = Array.from({ length: 150 }, (_, i) => `line ${i}`);
  lines[40] = `<private>${lines[40]}`;
  for (let i = 41; i < 60; i++) lines[i] = `codename-orchid-${i}`;
  lines[60] = `${lines[60]}</private>`;
  return lines.join('\n');
}

/** One line over 10000 characters with a `<private>` section across the 5000-character head the truncation keeps. */
function charsWithPrivateAcrossTruncation(): string {
  return `${'a'.repeat(4900)}<private>${'codename-orchid '.repeat(20)}</private>${'z'.repeat(8000)}`;
}

/**
 * A multi-line edit with a token and a `<private>` section on their own lines.
 * Stored, the markers keep the lines and indentation around them, so the code
 * after a redacted comment is not pulled onto the comment's line.
 */
const MULTILINE_EDIT = {
  file_path: '/tmp/client.ts',
  old_string: `  // ${GITHUB_TOKEN}\n  return 41;\n`,
  new_string: `  // ${GITHUB_TOKEN}\n  return 42;\n    <private>codename-orchid</private>\n  done();\n`
};

function expectMultilineEditKeepsLines(toolInput: Record<string, unknown>): void {
  expect(toolInput.old_string).toBe('  // [REDACTED]\n  return 41;\n');
  expect(toolInput.new_string).toBe('  // [REDACTED]\n  return 42;\n    [PRIVATE]\n  done();\n');
}

const PRIVATE_INPUT = {
  file_path: '/tmp/notes.md',
  content: 'public intro\n<private>internal-hostname-42</private>\npublic outro',
  edits: [{ new_string: 'value <private>card 4111-1111</private> end' }],
  tags: ['<private>codename-orchid</private>'],
  // `bearer` is one of the hook's exclude patterns; the credential patterns alone miss this form.
  note: 'bearer=opaque-value-77'
};

function expectPrivateInputMasked(toolInput: Record<string, unknown>): void {
  const serialized = JSON.stringify(toolInput);
  expect(serialized).not.toContain('internal-hostname-42');
  expect(serialized).not.toContain('card 4111-1111');
  expect(serialized).not.toContain('codename-orchid');
  expect(serialized).not.toContain('opaque-value-77');
  expect(serialized).toContain('[PRIVATE]');
  expect(toolInput.content).toContain('public intro');
  expect(toolInput.content).toContain('public outro');
  expect(toolInput.file_path).toBe('/tmp/notes.md');
}

describe('PostToolUse privacy filtering', () => {
  it('masks <private> sections and exclude patterns in tool input string values, nested ones included', async () => {
    const stored = await runPostToolUse({
      tool_name: 'Write',
      tool_input: PRIVATE_INPUT,
      tool_response: { content: 'File written' }
    });

    expectPrivateInputMasked(stored.toolInput);
  });

  it('masks <private> sections and credentials in stderr before storing it as errorMessage', async () => {
    const stderr = `fatal: auth failed for ${GITHUB_TOKEN}\n<private>db-password-hint</private>`;
    const stored = await runPostToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'git push' },
      tool_response: { stdout: '', stderr }
    });

    expect(stored.errorMessage).toContain('fatal: auth failed for');
    expect(stored.errorMessage).not.toContain(GITHUB_TOKEN);
    expect(stored.errorMessage).not.toContain('db-password-hint');
    expect(stored.toolOutput).not.toContain(GITHUB_TOKEN);
  });

  it('keeps the lines and indentation around masked parts of a multi-line edit', async () => {
    const stored = await runPostToolUse({
      tool_name: 'Edit',
      tool_input: MULTILINE_EDIT,
      tool_response: { filePath: MULTILINE_EDIT.file_path }
    });

    expectMultilineEditKeepsLines(stored.toolInput);
  });

  it('truncates stderr like the output, after masking, so a line cut never opens a <private> section', async () => {
    const stderr = linesWithPrivateAcrossTruncation();
    const stored = await runPostToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { stdout: '', stderr }
    });

    expect(stored.errorMessage).not.toContain('codename-orchid');
    expect(stored.errorMessage).toContain('[PRIVATE]');
    expect(stored.errorMessage).toContain('lines truncated');
    expect(stored.errorMessage).toContain('line 149');
  });

  it('truncates stderr like the output, after masking, so a character cut never opens a <private> section', async () => {
    const stored = await runPostToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { stdout: '', stderr: charsWithPrivateAcrossTruncation() }
    });

    for (const text of [stored.toolOutput, stored.errorMessage ?? '']) {
      expect(text).not.toContain('codename-orchid');
      expect(text).toContain('[PRIVATE]');
      expect(text).toContain('characters truncated');
    }
  });

  it('masks everything after an unclosed <private> tag in tool input, output and stderr', async () => {
    const stored = await runPostToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'echo start <private>input-orchid' },
      tool_response: { stdout: 'stdout start <private>output-orchid', stderr: 'stderr start <private>stderr-orchid' }
    });

    const serialized = JSON.stringify(stored);
    for (const tail of ['input-orchid', 'output-orchid', 'stderr-orchid']) expect(serialized).not.toContain(tail);
    expect(stored.toolInput.command).toBe('echo start [PRIVATE: unclosed]');
    expect(stored.toolOutput).toContain('stdout start [PRIVATE: unclosed]');
    expect(stored.errorMessage).toBe('stderr start [PRIVATE: unclosed]');
  });

  it('leaves errorMessage undefined when the tool wrote nothing to stderr', async () => {
    const stored = await runPostToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/a.txt', content: 'hello' },
      tool_response: { content: 'File written' }
    });

    expect(stored.errorMessage).toBeUndefined();
  });
});

describe('PostToolUseFailure privacy filtering', () => {
  it('masks <private> sections and exclude patterns in the failed call\'s tool input', async () => {
    const stored = await runPostToolUseFailure({
      tool_name: 'Write',
      tool_input: PRIVATE_INPUT,
      error: 'EACCES: permission denied'
    });

    expect(stored.success).toBe(false);
    expectPrivateInputMasked(stored.toolInput);
  });

  it('masks everything after an unclosed <private> tag in the failed call\'s input and error', async () => {
    const stored = await runPostToolUseFailure({
      tool_name: 'Bash',
      tool_input: { command: 'deploy <private>input-orchid' },
      error: 'Exit code 1\n<private>error-orchid'
    });

    const serialized = JSON.stringify(stored);
    for (const tail of ['input-orchid', 'error-orchid']) expect(serialized).not.toContain(tail);
    expect(stored.toolInput.command).toBe('deploy [PRIVATE: unclosed]');
    expect(stored.errorMessage).toContain('Exit code 1');
    expect(stored.errorMessage).toContain('[PRIVATE: unclosed]');
  });

  it('keeps the lines and indentation around masked parts of a failed multi-line edit', async () => {
    const stored = await runPostToolUseFailure({
      tool_name: 'Edit',
      tool_input: MULTILINE_EDIT,
      error: 'String to replace not found in file.'
    });

    expectMultilineEditKeepsLines(stored.toolInput);
  });

  it.each([
    ['line', linesWithPrivateAcrossTruncation],
    ['character', charsWithPrivateAcrossTruncation]
  ])('masks the error before truncating it, so a %s cut never opens a <private> section', async (unit, error) => {
    const stored = await runPostToolUseFailure({
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      error: error()
    });

    for (const text of [stored.toolOutput, stored.errorMessage ?? '']) {
      expect(text).not.toContain('codename-orchid');
      expect(text).toContain('[PRIVATE]');
      expect(text).toContain(`${unit}s truncated`);
    }
  });
});
