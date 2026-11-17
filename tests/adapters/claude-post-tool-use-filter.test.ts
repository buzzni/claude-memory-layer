import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Which tool calls PostToolUse stores. These rules run before the store is
 * opened, so the hook entry can apply them without loading it.
 */

const fixture = vi.hoisted(() => ({ input: '' }));

vi.mock('../../src/adapters/claude/hooks/hook-runtime.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/adapters/claude/hooks/hook-runtime.js')>(),
  readStdin: vi.fn(async () => fixture.input)
}));

let home: string;

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), 'cml-post-tool-use-filter-'));
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

function call(toolName: string, toolResponse: Record<string, unknown>): string {
  return JSON.stringify({
    session_id: 'session-1',
    cwd: home,
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: { command: 'run' },
    tool_use_id: 'toolu_1',
    tool_response: toolResponse
  });
}

async function storedCount(input: string): Promise<number> {
  fixture.input = input;
  const { main } = await import('../../src/adapters/claude/hooks/post-tool-use.js');
  expect(await main()).toBe('{}');
  const { shutdownMemoryServices } = await import('../../src/services/memory-service.js');
  await shutdownMemoryServices();
  const dbPath = join(home, '.claude-code', 'memory', 'events.sqlite');
  if (!existsSync(dbPath)) return 0;
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'tool_observation'").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

const LONG = 'x'.repeat(120);

describe('PostToolUse capture filter', () => {
  it.each([
    ['an excluded tool', call('Read', { content: LONG })],
    ['quiet Bash output', call('Bash', { stdout: 'ok', stderr: '' })],
    ['short output from another tool', call('mcp__srv__lookup', { content: 'short' })],
    ['malformed input', '{"session_id": '],
    ['an empty body', '']
  ])('stores nothing for %s', async (_label, input) => {
    expect(await storedCount(input)).toBe(0);
  });

  it.each([
    ['an always-stored tool', call('Edit', {})],
    ['Bash output with a signal keyword', call('Bash', { stdout: '3 tests failed', stderr: '' })],
    ['Bash with stderr', call('Bash', { stdout: '', stderr: 'npm WARN something went sideways' })],
    ['long Bash output', call('Bash', { stdout: 'y'.repeat(2100), stderr: '' })],
    ['long output from another tool', call('mcp__srv__lookup', { content: LONG })]
  ])('stores %s', async (_label, input) => {
    expect(await storedCount(input)).toBe(1);
  });

  it('replaces the excluded tools with CLAUDE_MEMORY_TOOL_BLOCKLIST', async () => {
    vi.stubEnv('CLAUDE_MEMORY_TOOL_BLOCKLIST', 'Edit');
    expect(await storedCount(call('Edit', {}))).toBe(0);
    expect(await storedCount(call('Read', { content: LONG }))).toBe(1);
  });

  it('reads the minimum output length from CLAUDE_MEMORY_TOOL_MIN_OUTPUT_LEN', async () => {
    vi.stubEnv('CLAUDE_MEMORY_TOOL_MIN_OUTPUT_LEN', '3');
    expect(await storedCount(call('mcp__srv__lookup', { content: 'short' }))).toBe(1);
  });
});
