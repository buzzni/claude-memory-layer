import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/**
 * PostToolUse applies operations.json `capturePolicy`: a tool call made inside
 * a skipped subagent type is not stored and is counted instead; everything
 * else is stored as before.
 */

const fixture = vi.hoisted(() => ({ input: '' }));

vi.mock('../../src/adapters/claude/hooks/hook-runtime.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/adapters/claude/hooks/hook-runtime.js')>(),
  readStdin: vi.fn(async () => fixture.input)
}));

let home: string;

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), 'cml-post-tool-use-'));
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

function configure(skipSubagentTypes: string[], others: Record<string, unknown> = {}): void {
  writeFileSync(join(home, 'operations.json'), JSON.stringify({ ...others, capturePolicy: { skipSubagentTypes } }));
}

function editInput(agent?: { agent_id: string; agent_type: string }, file = 'a.ts'): string {
  return JSON.stringify({
    session_id: 'session-1',
    transcript_path: join(home, 't.jsonl'),
    cwd: home,
    permission_mode: 'default',
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: join(home, file), old_string: 'a', new_string: 'b' },
    tool_use_id: 'toolu_1',
    tool_response: { filePath: join(home, file) },
    ...agent
  });
}

async function runPostToolUse(input: string): Promise<string> {
  fixture.input = input;
  const { main } = await import('../../src/adapters/claude/hooks/post-tool-use.js');
  const output = await main();
  const { shutdownMemoryServices } = await import('../../src/services/memory-service.js');
  await shutdownMemoryServices();
  return output;
}

function storeCounts(): { observations: number; skips: Array<{ error: string; count: number }> } {
  const dbPath = join(home, '.claude-code', 'memory', 'events.sqlite');
  if (!existsSync(dbPath)) return { observations: 0, skips: [] };
  const db = new Database(dbPath, { readonly: true });
  try {
    const observations = (db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'tool_observation'").get() as { n: number }).n;
    const skips = db.prepare(
      "SELECT error, COUNT(*) AS count FROM pipeline_metrics WHERE stage = 'capture_skipped' GROUP BY error"
    ).all() as Array<{ error: string; count: number }>;
    return { observations, skips };
  } finally {
    db.close();
  }
}

function skipRows(): Array<Record<string, unknown>> {
  const db = new Database(join(home, '.claude-code', 'memory', 'events.sqlite'), { readonly: true });
  try {
    return db.prepare("SELECT * FROM pipeline_metrics WHERE stage = 'capture_skipped'").all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

const EXPLORE = { agent_id: 'a1', agent_type: 'Explore' };
const GENERAL = { agent_id: 'a2', agent_type: 'general-purpose' };

describe('PostToolUse capture policy', () => {
  it('stores subagent tool calls by default', async () => {
    expect(await runPostToolUse(editInput(EXPLORE))).toBe('{}');
    expect(storeCounts()).toEqual({ observations: 1, skips: [] });
  });

  it('skips a listed subagent type, counts the skip, and still emits the normal output', async () => {
    configure(['Explore']);
    expect(await runPostToolUse(editInput(EXPLORE))).toBe('{}');
    expect(storeCounts()).toEqual({ observations: 0, skips: [{ error: 'subagent_or_teammate', count: 1 }] });
  });

  it('keeps storing other subagent types and the main session', async () => {
    configure(['Explore']);
    await runPostToolUse(editInput(GENERAL));
    await runPostToolUse(editInput(undefined, 'b.ts'));
    expect(storeCounts()).toEqual({ observations: 2, skips: [] });
  });

  it('counts nothing for a subagent call the output filter already drops', async () => {
    configure(['*']);
    const unchanged = JSON.parse(editInput(GENERAL));
    await runPostToolUse(JSON.stringify({ ...unchanged, tool_name: 'Read' }));
    expect(storeCounts()).toEqual({ observations: 0, skips: [] });
  });

  it('writes no session, agent or path identifier into the skip row', async () => {
    configure(['Explore']);
    await runPostToolUse(editInput(EXPLORE));
    const rows = skipRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBeNull();
    const serialized = JSON.stringify(rows);
    for (const identifier of ['session-1', EXPLORE.agent_id, EXPLORE.agent_type, 'toolu_1', home]) {
      expect(serialized).not.toContain(identifier);
    }
  });

  it('still skips with the pre-edit check and the source-trust filter switched on', async () => {
    configure(['Explore'], {
      preEditCheck: { enabled: true },
      sourceTrust: { excludeUntrustedFromAutoInjection: true }
    });
    await runPostToolUse(editInput(EXPLORE));
    await runPostToolUse(editInput(undefined, 'b.ts'));
    expect(storeCounts()).toEqual({ observations: 1, skips: [{ error: 'subagent_or_teammate', count: 1 }] });
  });

  it('returns the normal output and stores nothing when recording the skip fails', async () => {
    configure(['Explore']);
    const { SQLiteEventStore } = await import('../../src/core/sqlite-event-store.js');
    vi.spyOn(SQLiteEventStore.prototype, 'recordCaptureSkipped').mockRejectedValue(new Error('SQLITE_READONLY'));
    expect(await runPostToolUse(editInput(EXPLORE))).toBe('{}');
    expect(storeCounts()).toEqual({ observations: 0, skips: [] });
  });

  // operations.json safety rule: a file that is not valid JSON or does not
  // match the schema is ignored, so the defaults (store everything) apply.
  it.each([
    ['not valid JSON', '{"capturePolicy": {"skipSubagentTypes": ["Explore"]'],
    ['a schema error', '{"capturePolicy": {"skipSubagentTypes": "Explore"}}']
  ])('falls back to storing when operations.json is %s', async (_label, body) => {
    writeFileSync(join(home, 'operations.json'), body);
    expect(await runPostToolUse(editInput(EXPLORE))).toBe('{}');
    expect(storeCounts()).toEqual({ observations: 1, skips: [] });
  });
});
