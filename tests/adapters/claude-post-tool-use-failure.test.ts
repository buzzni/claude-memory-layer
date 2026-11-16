import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ToolObservationPayload } from '../../src/core/types.js';

/**
 * Claude Code reports a tool call that failed to PostToolUseFailure, never to
 * PostToolUse. That hook receives no `tool_response`, only an `error` string
 * (plus `is_interrupt` and `duration_ms`), and must store the call as a
 * tool_observation with success: false through the same privacy filter and
 * truncation PostToolUse applies.
 */

const stored = vi.hoisted(() => ({ payloads: [] as ToolObservationPayload[] }));

vi.mock('../../src/services/memory-service.js', () => ({
  getLightweightMemoryService: () => ({
    storeToolObservation: async (_sessionId: string, payload: ToolObservationPayload) => {
      stored.payloads.push(payload);
      return { success: true };
    }
  })
}));

const SESSION = 'session-post-tool-use-failure';
const GITHUB_TOKEN = `ghp_${'a1B2c3D4e5'.repeat(3)}abcdef`;

async function runFailureHook(stdin: string): Promise<string> {
  const runtime = await import('../../src/adapters/claude/hooks/hook-runtime.js');
  vi.spyOn(runtime, 'readStdin').mockResolvedValue(stdin);
  const { main } = await import('../../src/adapters/claude/hooks/post-tool-use-failure.js');
  return main();
}

function failure(body: Record<string, unknown>): string {
  return JSON.stringify({
    session_id: SESSION,
    hook_event_name: 'PostToolUseFailure',
    tool_use_id: 'toolu_01',
    cwd: '/repo',
    transcript_path: '/repo/t.jsonl',
    permission_mode: 'default',
    ...body
  });
}

describe('PostToolUseFailure hook', () => {
  afterEach(() => {
    stored.payloads = [];
    vi.restoreAllMocks();
    delete process.env.CLAUDE_MEMORY_TOOL_BLOCKLIST;
  });

  it('stores a failed Edit as an unsuccessful tool observation with the error text', async () => {
    const output = await runFailureHook(failure({
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/src/a.ts', old_string: 'missing', new_string: 'x' },
      error: 'String to replace not found in file.\nString: missing'
    }));

    expect(output).toBe('{}');
    expect(stored.payloads).toHaveLength(1);
    const [payload] = stored.payloads;
    expect(payload.toolName).toBe('Edit');
    expect(payload.success).toBe(false);
    expect(payload.toolOutput).toContain('String to replace not found in file.');
    expect(payload.errorMessage).toContain('String to replace not found in file.');
    expect(payload.toolInput.file_path).toBe('/repo/src/a.ts');
    expect(payload.metadata?.filePath).toBe('/repo/src/a.ts');
  });

  it('stores a short Bash failure that PostToolUse would drop as low-signal output', async () => {
    await runFailureHook(failure({
      tool_name: 'Bash',
      tool_input: { command: 'false' },
      error: 'Exit code 1',
      is_interrupt: false,
      duration_ms: 12
    }));

    expect(stored.payloads).toHaveLength(1);
    expect(stored.payloads[0]).toMatchObject({ toolName: 'Bash', success: false, toolOutput: 'Exit code 1' });
    expect(stored.payloads[0].metadata?.command).toBe('false');
  });

  it('stores a failure without an error string as unsuccessful, with no error message', async () => {
    await runFailureHook(failure({ tool_name: 'Bash', tool_input: { command: 'npm test' }, is_interrupt: true }));

    expect(stored.payloads).toHaveLength(1);
    expect(stored.payloads[0].success).toBe(false);
    expect(stored.payloads[0].toolOutput).toBe('');
    expect(stored.payloads[0].errorMessage).toBeUndefined();
  });

  it('masks credentials and <private> sections in the error before storing it', async () => {
    await runFailureHook(failure({
      tool_name: 'Bash',
      tool_input: { command: 'git push' },
      error: `Exit code 128\nfatal: auth failed for ${GITHUB_TOKEN}\n<private>db-password-hint</private>`
    }));

    const [payload] = stored.payloads;
    for (const text of [payload.toolOutput, payload.errorMessage ?? '']) {
      expect(text).toContain('Exit code 128');
      expect(text).not.toContain(GITHUB_TOKEN);
      expect(text).not.toContain('db-password-hint');
    }
  });

  it('truncates a long error the way PostToolUse truncates output', async () => {
    const error = `Exit code 1\n${Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(80)}`).join('\n')}`;
    await runFailureHook(failure({ tool_name: 'Bash', tool_input: { command: 'npm test' }, error }));

    const [payload] = stored.payloads;
    expect(payload.toolOutput.length).toBeLessThan(error.length);
    expect(payload.toolOutput.length).toBeLessThanOrEqual(10_100);
    expect((payload.errorMessage ?? '').length).toBeLessThanOrEqual(10_100);
  });

  it('skips tools excluded from tool observations, including an env blocklist', async () => {
    await runFailureHook(failure({ tool_name: 'Read', tool_input: { file_path: '/repo/none' }, error: 'File does not exist.' }));
    expect(stored.payloads).toHaveLength(0);

    process.env.CLAUDE_MEMORY_TOOL_BLOCKLIST = 'Bash';
    await runFailureHook(failure({ tool_name: 'Bash', tool_input: { command: 'false' }, error: 'Exit code 1' }));
    expect(stored.payloads).toHaveLength(0);
  });

  it('returns an empty envelope and stores nothing for malformed input', async () => {
    expect(await runFailureHook('not json')).toBe('{}');
    expect(await runFailureHook('null')).toBe('{}');
    expect(await runFailureHook(JSON.stringify({ session_id: SESSION, error: 'x' }))).toBe('{}');
    expect(stored.payloads).toHaveLength(0);
  });
});
