import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    const { readCompactionCheckpoint } = await import('../../src/adapters/claude/hooks/compaction-checkpoint.js');
    const checkpoint = await readCompactionCheckpoint(project, 'session-a');
    expect(checkpoint).toMatchObject({
      trigger: 'auto',
      recentPrompts: ['Second request: add the hook', 'Third request: run the tests', 'Fourth request: commit'],
      lastResponse: 'Added the hook in src/app.ts.',
      editedFiles: [join('src', 'app.ts')]
    });
    expect(checkpoint?.sourceEventIds.sort()).toEqual([ids[2], ids[5], ids[6], ids[7]].sort());
    expect(await readCompactionCheckpoint(project, 'session-other')).toBeNull();
  });

  it('clips long prompts and responses', async () => {
    await seed('session-a', [
      { eventType: 'user_prompt', content: `start ${'p'.repeat(2000)}`, turnId: 't1', secondsAgo: 60 },
      { eventType: 'agent_response', content: `start ${'r'.repeat(5000)}`, turnId: 't1', secondsAgo: 50 }
    ]);

    await runPreCompact({ session_id: 'session-a', cwd: project, trigger: 'manual' });

    const { readCompactionCheckpoint } = await import('../../src/adapters/claude/hooks/compaction-checkpoint.js');
    const checkpoint = await readCompactionCheckpoint(project, 'session-a');
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

  it('saves nothing when the session has no stored turns', async () => {
    await seed('session-other', [
      { eventType: 'user_prompt', content: 'Another session prompt', turnId: 'o1', secondsAgo: 100 }
    ]);

    await runPreCompact({ session_id: 'session-a', cwd: project, trigger: 'auto' });

    const { readCompactionCheckpoint } = await import('../../src/adapters/claude/hooks/compaction-checkpoint.js');
    expect(await readCompactionCheckpoint(project, 'session-a')).toBeNull();
  });

  it('ignores a checkpoint older than the compaction it would describe', async () => {
    await seed('session-a', [
      { eventType: 'user_prompt', content: 'Only request', turnId: 't1', secondsAgo: 60 }
    ]);
    await runPreCompact({ session_id: 'session-a', cwd: project, trigger: 'auto' });

    const { readCompactionCheckpoint, COMPACTION_CHECKPOINT_MAX_AGE_MS } = await import('../../src/adapters/claude/hooks/compaction-checkpoint.js');
    const later = new Date(Date.now() + COMPACTION_CHECKPOINT_MAX_AGE_MS + 1000);
    expect(await readCompactionCheckpoint(project, 'session-a', later)).toBeNull();
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
