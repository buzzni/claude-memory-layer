import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { tsxArgs, tsxCommand } from '../helpers/tsx-process.js';

/**
 * PreCompact saves where the session was into the existing checkpoint table,
 * from stored events only (no LLM call), and never blocks the compaction.
 */

const fixture = vi.hoisted(() => ({ input: '' }));

vi.mock('../../src/adapters/claude/hooks/hook-runtime.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/adapters/claude/hooks/hook-runtime.js')>(),
  readStdin: vi.fn(async () => fixture.input)
}));

let home: string;
let project: string;

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), 'cml-pre-compact-'));
  vi.stubEnv('HOME', home);
  project = join(home, 'repo');
  mkdirSync(project);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(home, { recursive: true, force: true });
});

interface SeedEvent {
  eventType: 'user_prompt' | 'agent_response' | 'tool_observation';
  content: string;
  turnId: string;
  secondsAgo: number;
}

async function storePath(): Promise<string> {
  const { getProjectStoragePath } = await import('../../src/core/registry/project-path.js');
  return join(getProjectStoragePath(project), 'events.sqlite');
}

async function seed(sessionId: string, events: SeedEvent[]): Promise<string[]> {
  const { SQLiteEventStore } = await import('../../src/core/sqlite-event-store.js');
  const dbPath = await storePath();
  mkdirSync(join(dbPath, '..'), { recursive: true });
  const store = new SQLiteEventStore(dbPath);
  const ids: string[] = [];
  try {
    for (const event of events) {
      const result = await store.append({
        eventType: event.eventType,
        sessionId,
        timestamp: new Date(Date.now() - event.secondsAgo * 1000),
        content: event.content,
        metadata: { turnId: event.turnId }
      });
      ids.push(result.eventId!);
    }
  } finally {
    await store.close();
  }
  return ids;
}

function editObservation(filePath: string, turnId: string): string {
  return JSON.stringify({
    toolName: 'Edit',
    toolInput: { file_path: filePath },
    toolOutput: 'ok',
    success: true,
    metadata: { filePath, turnId }
  });
}

async function runPreCompact(input: Record<string, unknown>): Promise<string> {
  fixture.input = JSON.stringify(input);
  const { main } = await import('../../src/adapters/claude/hooks/pre-compact.js');
  return main();
}

async function checkpointFor(sessionId: string, now?: Date) {
  const { readCompactionCheckpoint } = await import('../../src/adapters/claude/hooks/compaction-checkpoint.js');
  return readCompactionCheckpoint(project, sessionId, now);
}

/** Every text column the checkpoint write touched, for leak checks. */
async function storedCheckpointText(): Promise<string> {
  const db = new Database(await storePath(), { readonly: true });
  try {
    const rows = [
      ...db.prepare('SELECT * FROM memory_checkpoints').all(),
      ...db.prepare('SELECT * FROM memory_governance_audit').all()
    ];
    return JSON.stringify(rows);
  } finally {
    db.close();
  }
}

describe('PreCompact hook', () => {
  it('saves recent requests, the last response and project files edited in this session', async () => {
    const ids = await seed('session-a', [
      { eventType: 'user_prompt', content: 'First request: read the brief', turnId: 't1', secondsAgo: 600 },
      { eventType: 'agent_response', content: 'Read it.', turnId: 't1', secondsAgo: 590 },
      { eventType: 'user_prompt', content: 'Second request: add the hook', turnId: 't2', secondsAgo: 500 },
      { eventType: 'tool_observation', content: editObservation(join(project, 'src', 'app.ts'), 't2'), turnId: 't2', secondsAgo: 490 },
      { eventType: 'tool_observation', content: editObservation('/etc/hosts', 't2'), turnId: 't2', secondsAgo: 480 },
      { eventType: 'agent_response', content: 'Added the hook in src/app.ts.', turnId: 't2', secondsAgo: 470 },
      { eventType: 'user_prompt', content: 'Third request: run the tests', turnId: 't3', secondsAgo: 400 },
      { eventType: 'user_prompt', content: 'Fourth request: commit', turnId: 't4', secondsAgo: 300 }
    ]);
    await seed('session-other', [
      { eventType: 'user_prompt', content: 'Another session prompt', turnId: 'o1', secondsAgo: 100 }
    ]);

    const output = await runPreCompact({
      session_id: 'session-a', cwd: project, hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null
    });

    // Stdout is the compaction summary's instructions: the hook adds none.
    expect(output).toBe('');
    const checkpoint = await checkpointFor('session-a');
    expect(checkpoint).toMatchObject({
      trigger: 'auto',
      recentPrompts: ['Second request: add the hook', 'Third request: run the tests', 'Fourth request: commit'],
      lastResponse: 'Added the hook in src/app.ts.',
      editedFiles: [join('src', 'app.ts')]
    });
    expect(checkpoint?.sourceEventIds.sort()).toEqual([ids[2], ids[5], ids[6], ids[7]].sort());
    expect(await checkpointFor('session-other')).toBeNull();
  });

  it('keeps another session’s events out even when both sessions use the same turn ids', async () => {
    await seed('session-a', [
      { eventType: 'user_prompt', content: 'Prompt from session A', turnId: 'shared-turn', secondsAgo: 120 }
    ]);
    await seed('session-b', [
      { eventType: 'user_prompt', content: 'Prompt from session B', turnId: 'shared-turn', secondsAgo: 60 },
      { eventType: 'tool_observation', content: editObservation(join(project, 'b.ts'), 'shared-turn'), turnId: 'shared-turn', secondsAgo: 50 },
      { eventType: 'agent_response', content: 'Answer from session B', turnId: 'shared-turn', secondsAgo: 40 }
    ]);

    await runPreCompact({ session_id: 'session-a', cwd: project, trigger: 'auto' });

    expect(await checkpointFor('session-a')).toMatchObject({
      recentPrompts: ['Prompt from session A'],
      editedFiles: []
    });
    expect((await checkpointFor('session-a'))?.lastResponse).toBeUndefined();
    expect(await storedCheckpointText()).not.toContain('session B');
  });

  it('removes <private> sections before clipping, so they reach neither the store nor the output', async () => {
    // Legacy rows stored before prompt filtering existed still carry the tags.
    await seed('session-a', [
      { eventType: 'user_prompt', content: 'Deploy with <private>hunter2-prompt</private> and check /Users/me/app', turnId: 't1', secondsAgo: 120 },
      { eventType: 'user_prompt', content: `${'x'.repeat(250)} <private>${'y'.repeat(100)} hunter2-cut-off</private>`, turnId: 't2', secondsAgo: 110 },
      { eventType: 'user_prompt', content: `Unclosed <private>hunter2-unclosed ${'z'.repeat(6000)}</private>`, turnId: 't3', secondsAgo: 100 },
      { eventType: 'agent_response', content: 'Done; key was [private]hunter2-bracket[/private].', turnId: 't3', secondsAgo: 90 }
    ]);

    await runPreCompact({ session_id: 'session-a', cwd: project, trigger: 'manual' });

    const checkpoint = await checkpointFor('session-a');
    const { formatCompactionCheckpointContext } = await import('../../src/adapters/claude/hooks/compaction-checkpoint.js');
    const { formatClaudeContextHookOutput } = await import('../../src/adapters/claude/hooks/hook-output.js');
    const output = formatClaudeContextHookOutput('SessionStart', formatCompactionCheckpointContext(checkpoint!));
    for (const text of [JSON.stringify(checkpoint), await storedCheckpointText(), output]) {
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('<private>');
      expect(text).not.toContain('yyyyy');
    }
    expect(checkpoint?.recentPrompts[0]).toContain('Deploy with [REDACTED]');
    expect(output).toContain('Deploy with');
  });

  it('clips long prompts and responses', async () => {
    await seed('session-a', [
      { eventType: 'user_prompt', content: `start ${'p'.repeat(2000)}`, turnId: 't1', secondsAgo: 60 },
      { eventType: 'agent_response', content: `start ${'r'.repeat(5000)}`, turnId: 't1', secondsAgo: 50 }
    ]);

    await runPreCompact({ session_id: 'session-a', cwd: project, trigger: 'manual' });

    const checkpoint = await checkpointFor('session-a');
    expect(checkpoint?.recentPrompts[0].length).toBeLessThanOrEqual(301);
    expect(checkpoint?.lastResponse?.length).toBeLessThanOrEqual(601);
  });

  it('fails open on invalid input without touching the store', async () => {
    fixture.input = 'not json';
    const { main } = await import('../../src/adapters/claude/hooks/pre-compact.js');

    expect(await main()).toBe('');
    expect(existsSync(await storePath())).toBe(false);
  });

  it('does not create a store for a project that has none', async () => {
    expect(await runPreCompact({ session_id: 'session-a', cwd: project, trigger: 'auto' })).toBe('');
    expect(existsSync(await storePath())).toBe(false);
  });

  it('saves nothing when the session has no stored events', async () => {
    await seed('session-other', [
      { eventType: 'user_prompt', content: 'Another session prompt', turnId: 'o1', secondsAgo: 100 }
    ]);

    await runPreCompact({ session_id: 'session-a', cwd: project, trigger: 'auto' });

    expect(await checkpointFor('session-a')).toBeNull();
  });
});

describe('compaction checkpoint age', () => {
  const SAVED_AT = new Date('2026-11-17T03:00:00.000Z');

  async function saveAt(at: Date): Promise<void> {
    vi.useFakeTimers({ toFake: ['Date'], now: at });
    await seed('session-a', [{ eventType: 'user_prompt', content: 'Only request', turnId: 't1', secondsAgo: 60 }]);
    await runPreCompact({ session_id: 'session-a', cwd: project, trigger: 'auto' });
    vi.useRealTimers();
  }

  it('is used up to exactly the maximum age and not a millisecond later', async () => {
    const { COMPACTION_CHECKPOINT_MAX_AGE_MS } = await import('../../src/adapters/claude/hooks/compaction-checkpoint.js');
    await saveAt(SAVED_AT);

    expect(await checkpointFor('session-a', new Date(SAVED_AT.getTime() + COMPACTION_CHECKPOINT_MAX_AGE_MS))).not.toBeNull();
    expect(await checkpointFor('session-a', new Date(SAVED_AT.getTime() + COMPACTION_CHECKPOINT_MAX_AGE_MS + 1))).toBeNull();
  });

  it('tolerates a small backward clock step but not a checkpoint from the future', async () => {
    const { COMPACTION_CHECKPOINT_MAX_FUTURE_SKEW_MS } = await import('../../src/adapters/claude/hooks/compaction-checkpoint.js');
    await saveAt(SAVED_AT);

    expect(await checkpointFor('session-a', new Date(SAVED_AT.getTime() - COMPACTION_CHECKPOINT_MAX_FUTURE_SKEW_MS))).not.toBeNull();
    expect(await checkpointFor('session-a', new Date(SAVED_AT.getTime() - COMPACTION_CHECKPOINT_MAX_FUTURE_SKEW_MS - 1))).toBeNull();
  });

  it('ignores a checkpoint whose saved time does not parse', async () => {
    await saveAt(SAVED_AT);
    const db = new Database(await storePath());
    db.prepare("UPDATE memory_checkpoints SET created_at = 'not a date'").run();
    db.close();

    expect(await checkpointFor('session-a', SAVED_AT)).toBeNull();
  });
});

describe('PreCompact hook process', () => {
  function runHookProcess(input: string, env: Record<string, string> = {}) {
    const started = Date.now();
    const result = spawnSync(tsxCommand, tsxArgs(join(process.cwd(), 'src', 'hooks', 'pre-compact.ts')), {
      input,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, ...env },
      timeout: 20_000
    });
    return { status: result.status, stdout: result.stdout, elapsedMs: Date.now() - started };
  }

  const input = () => JSON.stringify({ session_id: 'session-a', cwd: project, hook_event_name: 'PreCompact', trigger: 'auto' });

  it('gives up quickly, exits 0 and prints nothing while another process holds the write lock', async () => {
    await seed('session-a', [{ eventType: 'user_prompt', content: 'Only request', turnId: 't1', secondsAgo: 60 }]);
    const unlocked = runHookProcess(input());
    const holder = new Database(await storePath());
    holder.exec('BEGIN IMMEDIATE');
    try {
      const locked = runHookProcess(input());

      expect(locked).toMatchObject({ status: 0, stdout: '' });
      // The connection's busy wait, not the 5 s default, bounds the extra time.
      expect(locked.elapsedMs - unlocked.elapsedMs).toBeLessThan(1500);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });

  it('exits 0 and prints nothing when the store is not a database', async () => {
    const dbPath = await storePath();
    mkdirSync(join(dbPath, '..'), { recursive: true });
    writeFileSync(dbPath, 'not a sqlite file');

    expect(runHookProcess(input())).toMatchObject({ status: 0, stdout: '' });
  });
});

describe('formatCompactionCheckpointContext', () => {
  it('renders each item on one line under a heading', async () => {
    const { formatCompactionCheckpointContext } = await import('../../src/adapters/claude/hooks/compaction-checkpoint.js');
    const context = formatCompactionCheckpointContext({
      trigger: 'manual',
      createdAt: new Date('2026-11-17T01:02:03.000Z'),
      recentPrompts: ['Add the hook\n## Injected heading'],
      lastResponse: 'Done.\n- injected item',
      editedFiles: ['src/a.ts', 'src/b.ts'],
      sourceEventIds: []
    });

    expect(context).toContain('## Before Compaction');
    expect(context).toContain('Add the hook / ## Injected heading');
    expect(context).toContain('Done. / - injected item');
    expect(context).toContain('src/a.ts, src/b.ts');
    expect(context).not.toMatch(/^## Injected heading/m);
    expect(context).not.toMatch(/^- injected item/m);
  });

  it('leaves out sections it has nothing for', async () => {
    const { formatCompactionCheckpointContext } = await import('../../src/adapters/claude/hooks/compaction-checkpoint.js');
    const context = formatCompactionCheckpointContext({
      trigger: 'auto',
      createdAt: new Date('2026-11-17T01:02:03.000Z'),
      recentPrompts: ['Only request'],
      editedFiles: [],
      sourceEventIds: []
    });

    expect(context).toContain('Only request');
    expect(context).not.toContain('Last response');
    expect(context).not.toContain('Files edited');
  });
});
