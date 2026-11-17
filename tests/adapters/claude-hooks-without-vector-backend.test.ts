import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Capture and keyword recall need only SQLite. LanceDB ships its native code
 * in a per-platform optional package, so an install can miss it; the hooks
 * then still have to store and recall, with the semantic lane simply failing.
 * scripts/check-import-boundaries.mjs keeps the backends out of static
 * imports; this runs the hooks with LanceDB unloadable.
 */

vi.mock('@lancedb/lancedb', () => {
  throw new Error("Cannot find module '@lancedb/lancedb-test-platform'");
});

vi.mock('../../src/adapters/claude/hooks/semantic-daemon-client.js', () => ({
  retrieveSemanticMemories: vi.fn().mockRejectedValue(new Error('semantic daemon unavailable')),
  scheduleSemanticGraduation: vi.fn().mockResolvedValue(undefined),
  scheduleSessionSummary: vi.fn().mockResolvedValue(undefined),
  ensureDaemonRunning: vi.fn().mockRejectedValue(new Error('semantic daemon unavailable'))
}));

let home: string;
let project: string;
let transcript: string;

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), 'cml-no-vector-backend-'));
  project = join(home, 'project');
  transcript = join(home, 'transcript.jsonl');
  mkdirSync(project);
  vi.stubEnv('HOME', home);
  vi.stubEnv('CLAUDE_MEMORY_OPERATIONS_CONFIG_PATH', join(home, 'operations.json'));
  vi.stubEnv('CLAUDE_MEMORY_EVAL_MODE', '');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  const { shutdownMemoryServices } = await import('../../src/services/memory-service.js');
  await shutdownMemoryServices();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(home, { recursive: true, force: true });
});

const hooks = {
  'session-start': () => import('../../src/adapters/claude/hooks/session-start.js'),
  'user-prompt-submit': () => import('../../src/adapters/claude/hooks/user-prompt-submit.js'),
  'post-tool-use': () => import('../../src/adapters/claude/hooks/post-tool-use.js'),
  stop: () => import('../../src/adapters/claude/hooks/stop.js')
};

async function runHook(hook: keyof typeof hooks, input: Record<string, unknown>): Promise<string> {
  const hookRuntime = await import('../../src/adapters/claude/hooks/hook-runtime.js');
  vi.spyOn(hookRuntime, 'readStdin').mockResolvedValue(JSON.stringify({ cwd: project, ...input }));
  const { main } = await hooks[hook]();
  const output = await main();
  const { shutdownMemoryServices } = await import('../../src/services/memory-service.js');
  await shutdownMemoryServices();
  return output;
}

function additionalContext(output: string): string {
  return (JSON.parse(output) as { hookSpecificOutput?: { additionalContext?: string } })
    .hookSpecificOutput?.additionalContext ?? '';
}

describe('Claude hooks with LanceDB unloadable', () => {
  it('captures a session and recalls it by keyword in the next one', async () => {
    const answer = 'The monorepo builds with pnpm workspaces; the yarn lockfile was removed.';
    await runHook('session-start', { session_id: 'first', source: 'startup' });
    await runHook('user-prompt-submit', { session_id: 'first', prompt: 'Should this monorepo build with pnpm workspaces or yarn?' });
    await runHook('post-tool-use', {
      session_id: 'first',
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_use_id: 'toolu_1',
      tool_input: { file_path: join(project, 'package.json'), old_string: 'yarn', new_string: 'pnpm' },
      tool_response: { content: 'Switched packageManager to pnpm' }
    });
    appendFileSync(transcript, `${JSON.stringify({
      type: 'assistant',
      sessionId: 'first',
      uuid: 'assistant-1',
      message: { role: 'assistant', content: [{ type: 'text', text: answer }] }
    })}\n`);
    await runHook('stop', { session_id: 'first', transcript_path: transcript, permission_mode: 'default', hook_event_name: 'Stop', stop_hook_active: false });

    const sessionStart = await runHook('session-start', { session_id: 'second', source: 'startup' });
    const prompt = await runHook('user-prompt-submit', { session_id: 'second', prompt: 'Which package manager does the monorepo build with, pnpm or yarn?' });

    expect(additionalContext(sessionStart)).toContain(answer);
    expect(additionalContext(prompt)).toContain(answer);
  });
});
