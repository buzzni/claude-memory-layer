import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ToolObservationPayload } from '../../src/core/types.js';

/**
 * PostToolUse stores three strings from a tool call: its input, its output and
 * its stderr. All three reach the local store and, through mongo-sync, MongoDB,
 * so each one goes through the same privacy filter the output always had:
 * `<private>` sections and credential patterns are masked before storage.
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

const SESSION = 'session-post-tool-use-privacy';
const GITHUB_TOKEN = `ghp_${'a1B2c3D4e5'.repeat(3)}abcdef`;

async function runPostToolUse(body: Record<string, unknown>): Promise<ToolObservationPayload> {
  const runtime = await import('../../src/adapters/claude/hooks/hook-runtime.js');
  vi.spyOn(runtime, 'readStdin').mockResolvedValue(JSON.stringify({ session_id: SESSION, ...body }));
  const { main } = await import('../../src/adapters/claude/hooks/post-tool-use.js');
  await main();
  expect(stored.payloads).toHaveLength(1);
  return stored.payloads[0];
}

describe('PostToolUse privacy filtering', () => {
  afterEach(() => {
    stored.payloads = [];
    vi.restoreAllMocks();
  });

  it('masks <private> sections in tool input string values, nested ones included', async () => {
    const payload = await runPostToolUse({
      tool_name: 'Write',
      tool_input: {
        file_path: '/tmp/notes.md',
        content: 'public intro\n<private>internal-hostname-42</private>\npublic outro',
        edits: [{ new_string: 'value <private>card 4111-1111</private> end' }],
        tags: ['<private>codename-orchid</private>']
      },
      tool_response: { content: 'File written' }
    });

    const serialized = JSON.stringify(payload.toolInput);
    expect(serialized).not.toContain('internal-hostname-42');
    expect(serialized).not.toContain('card 4111-1111');
    expect(serialized).not.toContain('codename-orchid');
    expect(serialized).toContain('[PRIVATE]');
    expect(payload.toolInput.content).toContain('public intro');
    expect(payload.toolInput.file_path).toBe('/tmp/notes.md');
  });

  it('masks <private> sections and credentials in stderr before storing it as errorMessage', async () => {
    const stderr = `fatal: auth failed for ${GITHUB_TOKEN}\n<private>db-password-hint</private>`;
    const payload = await runPostToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'git push' },
      tool_response: { stdout: '', stderr }
    });

    expect(payload.errorMessage).toBeDefined();
    expect(payload.errorMessage).not.toContain(GITHUB_TOKEN);
    expect(payload.errorMessage).not.toContain('db-password-hint');
    expect(payload.errorMessage).toContain('fatal: auth failed for');
    expect(payload.toolOutput).not.toContain(GITHUB_TOKEN);
  });

  it('leaves errorMessage undefined when the tool wrote nothing to stderr', async () => {
    const payload = await runPostToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/a.txt', content: 'hello' },
      tool_response: { content: 'File written' }
    });

    expect(payload.errorMessage).toBeUndefined();
  });
});
