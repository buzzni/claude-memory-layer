import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/**
 * What PostToolUse writes for a call it stores: the masked and truncated
 * payload, the event metadata, and the file links codify-lite derives from
 * it. Pinned so moving the capture filter out of the module changes none of
 * it.
 */

const fixture = vi.hoisted(() => ({ input: '' }));

vi.mock('../../src/adapters/claude/hooks/hook-runtime.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/adapters/claude/hooks/hook-runtime.js')>(),
  readStdin: vi.fn(async () => fixture.input)
}));

let home: string;

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), 'cml-post-tool-use-payload-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('CLAUDE_MEMORY_OPERATIONS_CONFIG_PATH', join(home, 'operations.json'));
  // codify-lite (file links derived from tool calls) is opt-in.
  writeFileSync(join(home, 'operations.json'), JSON.stringify({ codifyLite: { enabled: true } }));
});

afterEach(async () => {
  const { shutdownMemoryServices } = await import('../../src/services/memory-service.js');
  await shutdownMemoryServices();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(home, { recursive: true, force: true });
});

async function store(input: Record<string, unknown>): Promise<void> {
  fixture.input = JSON.stringify({ session_id: 'session-1', cwd: home, hook_event_name: 'PostToolUse', tool_use_id: 'toolu_1', ...input });
  const { main } = await import('../../src/adapters/claude/hooks/post-tool-use.js');
  expect(await main()).toBe('{}');
  const { shutdownMemoryServices } = await import('../../src/services/memory-service.js');
  await shutdownMemoryServices();
}

/** Every stored row that depends on the hook input, with ids, times and the temp path made stable. */
function storedRows(): unknown {
  const db = new Database(join(home, '.claude-code', 'memory', 'events.sqlite'), { readonly: true });
  const stable = (value: unknown) => JSON.parse(JSON.stringify(value).split(home).join('<HOME>')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<time>')
    .replace(/"sourceLagMs":\d+/g, '"sourceLagMs":"<varies>"')
    // A hash of the temp file path.
    .replace(/file:default:[0-9a-f]+/g, 'file:default:<hash>'));
  try {
    return stable({
      events: (db.prepare('SELECT event_type, session_id, content, metadata FROM events ORDER BY rowid').all() as Array<Record<string, string>>)
        .map((row) => ({ ...row, content: JSON.parse(row.content), metadata: JSON.parse(row.metadata) })),
      edges: db.prepare('SELECT rel_type, meta_json FROM edges ORDER BY rel_type, meta_json').all()
        .map((row) => {
          const meta = JSON.parse((row as { meta_json: string }).meta_json ?? '{}') as Record<string, unknown>;
          for (const key of Object.keys(meta)) if (/id$|At$|time/i.test(key) && key !== 'sessionId') meta[key] = '<varies>';
          return { ...(row as object), meta_json: meta };
        }),
      entities: db.prepare('SELECT entity_type, canonical_key, title FROM entities ORDER BY canonical_key').all()
    });
  } finally {
    db.close();
  }
}

describe('PostToolUse stored payload', () => {
  it('stores an edit and a Bash failure exactly as before', async () => {
    await store({
      tool_name: 'Edit',
      tool_input: { file_path: join(home, 'src', 'config.ts'), old_string: 'apiKey = "old"', new_string: 'apiKey = "sk-live-0123456789abcdef"' },
      tool_response: { filePath: join(home, 'src', 'config.ts') }
    });
    await store({
      tool_name: 'Bash',
      tool_input: { command: 'npm test -- --token=abc123secret' },
      tool_response: {
        stdout: `${'line of output\n'.repeat(150)}3 tests failed\npassword: hunter2`,
        stderr: 'Error: expected 1 to be 2 at config.test.ts:4',
        interrupted: false
      }
    });

    expect(storedRows()).toMatchSnapshot();
  });
});
