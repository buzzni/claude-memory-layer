import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { tsxArgs, tsxCommand } from '../helpers/tsx-process.js';

/**
 * PreToolUse (edit tools) adds what earlier sessions left about the file —
 * linked lessons, failed tool runs, session summaries — from stored data only,
 * and never blocks or delays the edit beyond a bounded read.
 */

const fixture = vi.hoisted(() => ({ input: '' }));

vi.mock('../../src/adapters/claude/hooks/hook-runtime.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/adapters/claude/hooks/hook-runtime.js')>(),
  readStdin: vi.fn(async () => fixture.input)
}));

const CURRENT = 'session-current';
/** Fixed times; the file's mtime is set relative to these, never to the real clock. */
const EARLIER = new Date('2026-03-01T10:00:00.000Z');
const LATER = new Date('2026-03-05T10:00:00.000Z');

let home: string;
let project: string;
let file: string;

function enablePreEditCheck(enabled = true): void {
  const configPath = join(home, 'operations.json');
  writeFileSync(configPath, JSON.stringify({ preEditCheck: { enabled } }));
  vi.stubEnv('CLAUDE_MEMORY_OPERATIONS_CONFIG_PATH', configPath);
}

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), 'cml-pre-tool-use-'));
  vi.stubEnv('HOME', home);
  project = join(home, 'repo');
  mkdirSync(join(project, 'src'), { recursive: true });
  file = join(project, 'src', 'parser.ts');
  writeFileSync(file, 'export {};\n');
  setFileTime(EARLIER.getTime() - 60_000);
  enablePreEditCheck();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(home, { recursive: true, force: true });
});

function setFileTime(ms: number): void {
  utimesSync(file, ms / 1000, ms / 1000);
}

async function storePath(cwd = project): Promise<string> {
  const { getProjectStoragePath } = await import('../../src/core/registry/project-path.js');
  return join(getProjectStoragePath(cwd), 'events.sqlite');
}

interface SeedEvent {
  sessionId: string;
  eventType: 'tool_observation' | 'session_summary';
  content: string;
  at: Date;
}

async function seed(events: SeedEvent[], cwd = project): Promise<string[]> {
  const { SQLiteEventStore } = await import('../../src/core/sqlite-event-store.js');
  const dbPath = await storePath(cwd);
  mkdirSync(join(dbPath, '..'), { recursive: true });
  const store = new SQLiteEventStore(dbPath);
  const ids: string[] = [];
  try {
    await store.initialize();
    for (const event of events) {
      const result = await store.append({ eventType: event.eventType, sessionId: event.sessionId, timestamp: event.at, content: event.content });
      ids.push(result.eventId!);
    }
  } finally {
    await store.close();
  }
  return ids;
}

function observation(toolName: string, filePath: string, options: { success?: boolean; errorMessage?: string; output?: string } = {}): string {
  return JSON.stringify({
    toolName,
    toolInput: { file_path: filePath, old_string: 'a', new_string: 'b' },
    toolOutput: options.output ?? 'ok',
    durationMs: 0,
    success: options.success ?? true,
    ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
    metadata: { filePath }
  });
}

async function seedLesson(input: { name: string; trigger: string; sourceEventIds?: string[]; steps?: string[] }, cwd = project): Promise<void> {
  const { LessonRepository } = await import('../../src/core/operations/lesson-repository.js');
  const { hashProjectPath } = await import('../../src/core/registry/project-path.js');
  const db = new Database(await storePath(cwd));
  try {
    await new LessonRepository(db).upsert({
      projectHash: hashProjectPath(cwd),
      name: input.name,
      trigger: input.trigger,
      steps: input.steps ?? ['do the thing'],
      sourceEventIds: input.sourceEventIds ?? [],
      sourceSessionIds: ['session-old']
    });
  } finally {
    db.close();
  }
}

async function runHook(payload: Record<string, unknown>): Promise<string> {
  fixture.input = JSON.stringify(payload);
  const { main } = await import('../../src/adapters/claude/hooks/pre-tool-use.js');
  return main();
}

function editInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: CURRENT,
    cwd: project,
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: file, old_string: 'a', new_string: 'b' },
    tool_use_id: 'toolu_1',
    ...overrides
  };
}

function contextOf(output: string): string {
  const parsed = JSON.parse(output) as { hookSpecificOutput: { hookEventName: string; additionalContext?: string; permissionDecision?: string } };
  expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  expect(parsed.hookSpecificOutput).not.toHaveProperty('permissionDecision');
  return parsed.hookSpecificOutput.additionalContext ?? '';
}

async function seedPastSession(): Promise<string[]> {
  return seed([
    { sessionId: 'session-old', eventType: 'tool_observation', content: observation('Edit', file), at: EARLIER },
    {
      sessionId: 'session-old',
      eventType: 'tool_observation',
      content: observation('Edit', file, { success: false, errorMessage: `String to replace not found in ${file}` }),
      at: new Date(EARLIER.getTime() + 1000)
    },
    { sessionId: 'session-old', eventType: 'session_summary', content: 'Rewrote the tokenizer; decided to keep the recursive descent parser.', at: new Date(EARLIER.getTime() + 60_000) }
  ]);
}

describe('PreToolUse hook (pre-edit check)', () => {
  it('adds the earlier session summary, a linked lesson and a failed edit, with project-relative paths', async () => {
    const [editId] = await seedPastSession();
    await seedLesson({ name: 'Parser edits', trigger: 'Run the parser fixtures after changing the grammar', sourceEventIds: [editId] });

    const context = contextOf(await runHook(editInput()));

    expect(context).toContain('## Memory About src/parser.ts');
    expect(context).toContain('Lesson "Parser edits": Run the parser fixtures after changing the grammar');
    expect(context).toContain('Edit on this file failed on 2026-03-01: String to replace not found in src/parser.ts');
    expect(context).toContain('Session that edited it on 2026-03-01: Rewrote the tokenizer; decided to keep the recursive descent parser.');
    expect(context).not.toContain(project);
    expect(context).not.toMatch(/\(file changed since\)$/m);
  });

  it('links a lesson that names the file, but not one that names a longer file ending the same way', async () => {
    await seedPastSession();
    await seedLesson({ name: 'Mentions it', trigger: 'Before touching src/parser.ts, read the grammar notes' });
    await seedLesson({ name: 'Other file', trigger: 'Before touching src/parser.tsx, check the JSX build' });

    const context = contextOf(await runHook(editInput()));

    expect(context).toContain('Lesson "Mentions it"');
    expect(context).not.toContain('Other file');
  });

  it('marks notes recorded before the file last changed', async () => {
    await seedPastSession();
    setFileTime(LATER.getTime());

    const context = contextOf(await runHook(editInput()));

    expect(context).toMatch(/Session that edited it on 2026-03-01: .*\(file changed since\)/);
    expect(context).toMatch(/failed on 2026-03-01: .*\(file changed since\)/);
  });

  it('prints nothing when the pre-edit check is off, even with memories for the file', async () => {
    await seedPastSession();
    enablePreEditCheck(false);

    expect(await runHook(editInput())).toBe('');
  });

  it('prints nothing for a file with no memories, a file outside the project, or a tool that is not an edit', async () => {
    await seedPastSession();
    const other = join(project, 'src', 'other.ts');
    writeFileSync(other, '');

    expect(await runHook(editInput({ tool_input: { file_path: other } }))).toBe('');
    expect(await runHook(editInput({ tool_input: { file_path: join(home, 'elsewhere.ts') } }))).toBe('');
    expect(await runHook(editInput({ tool_name: 'Read' }))).toBe('');
  });

  it('fails open on invalid input and does not create a store for a project that has none', async () => {
    fixture.input = 'not json';
    const { main } = await import('../../src/adapters/claude/hooks/pre-tool-use.js');
    expect(await main()).toBe('');

    expect(await runHook(editInput())).toBe('');
    expect(existsSync(await storePath())).toBe(false);
  });

  it('does not repeat an item already shown for the file in this session, but shows new ones', async () => {
    await seedPastSession();

    expect(contextOf(await runHook(editInput()))).toContain('Session that edited it');
    // The current session's own edit changes the mtime; that must not bring the notes back.
    setFileTime(LATER.getTime());
    expect(await runHook(editInput())).toBe('');

    await seed([
      { sessionId: 'session-newer', eventType: 'tool_observation', content: observation('Write', file), at: LATER },
      { sessionId: 'session-newer', eventType: 'session_summary', content: 'Split the parser into modules.', at: LATER }
    ]);
    const third = contextOf(await runHook(editInput()));
    expect(third).toContain('Split the parser into modules.');
    expect(third).not.toContain('Rewrote the tokenizer');

    // Another session gets everything.
    const other = contextOf(await runHook(editInput({ session_id: 'session-another' })));
    expect(other).toContain('Rewrote the tokenizer');
    expect(other).toContain('Split the parser into modules.');
  });

  it('skips sessions without a summary instead of letting them take the session slots', async () => {
    const events: SeedEvent[] = [
      { sessionId: 'session-summarized', eventType: 'tool_observation', content: observation('Edit', file), at: EARLIER },
      { sessionId: 'session-summarized', eventType: 'session_summary', content: 'The summarized session', at: EARLIER }
    ];
    for (let index = 0; index < 3; index++) {
      events.push({ sessionId: `session-unsummarized-${index}`, eventType: 'tool_observation', content: observation('Edit', file), at: new Date(LATER.getTime() + index * 1000) });
    }
    await seed(events);

    expect(contextOf(await runHook(editInput()))).toContain('The summarized session');
  });

  it('leaves out the current session’s own edits and summary', async () => {
    await seed([
      { sessionId: CURRENT, eventType: 'tool_observation', content: observation('Edit', file, { success: false, errorMessage: 'boom' }), at: EARLIER },
      { sessionId: CURRENT, eventType: 'session_summary', content: 'Current session summary', at: EARLIER }
    ]);

    expect(await runHook(editInput())).toBe('');
  });

  it('reads only this project’s store and lessons', async () => {
    const otherProject = join(home, 'other-repo');
    const otherFile = join(otherProject, 'src', 'parser.ts');
    mkdirSync(join(otherProject, 'src'), { recursive: true });
    await seed([
      { sessionId: 'session-x', eventType: 'tool_observation', content: observation('Edit', otherFile), at: EARLIER },
      { sessionId: 'session-x', eventType: 'session_summary', content: 'Other project work', at: EARLIER }
    ], otherProject);
    await seedLesson({ name: 'Other project lesson', trigger: 'About src/parser.ts over there' }, otherProject);
    await seed([{ sessionId: 'session-y', eventType: 'session_summary', content: 'Unrelated', at: EARLIER }]);

    expect(await runHook(editInput())).toBe('');
  });

  it('drops a tool observation that only mentions the path in its output', async () => {
    await seed([
      { sessionId: 'session-old', eventType: 'tool_observation', content: observation('Bash', join(project, 'src', 'x.ts'), { output: JSON.stringify(file) }), at: EARLIER },
      { sessionId: 'session-old', eventType: 'session_summary', content: 'Ran a grep', at: EARLIER }
    ]);

    expect(await runHook(editInput())).toBe('');
  });

  it('removes private sections from stored text', async () => {
    await seed([
      { sessionId: 'session-old', eventType: 'tool_observation', content: observation('Edit', file), at: EARLIER },
      { sessionId: 'session-old', eventType: 'session_summary', content: 'Fixed parsing <private>hunter2 secret</private> and moved on', at: EARLIER }
    ]);

    const context = contextOf(await runHook(editInput()));

    expect(context).toContain('Fixed parsing');
    expect(context).not.toContain('hunter2');
  });

  it('stays within the context budget and shows what was cut on a later edit', async () => {
    const { PRE_EDIT_CONTEXT_BUDGET } = await import('../../src/adapters/claude/hooks/pre-edit-memory.js');
    const events: SeedEvent[] = [];
    for (let index = 0; index < 3; index++) {
      const at = new Date(EARLIER.getTime() + index * 60_000);
      events.push(
        { sessionId: `session-${index}`, eventType: 'tool_observation', content: observation('Edit', file, { success: false, errorMessage: `e${index} ${'x'.repeat(500)}` }), at },
        { sessionId: `session-${index}`, eventType: 'session_summary', content: `s${index} ${'y'.repeat(1000)}`, at }
      );
    }
    await seed(events);
    for (let index = 0; index < 3; index++) {
      await seedLesson({ name: `Lesson ${index}`, trigger: `About src/parser.ts ${'z'.repeat(400)}` });
    }

    const first = contextOf(await runHook(editInput()));
    expect(first.length).toBeLessThanOrEqual(PRE_EDIT_CONTEXT_BUDGET);
    const second = contextOf(await runHook(editInput()));
    expect(second.length).toBeLessThanOrEqual(PRE_EDIT_CONTEXT_BUDGET);
    expect(second).not.toBe(first);
  });

  it('finds the file through the codify-lite graph beyond the scan window', async () => {
    const [linkedId] = await seed([
      { sessionId: 'session-graph', eventType: 'tool_observation', content: observation('Edit', file), at: EARLIER },
      { sessionId: 'session-graph', eventType: 'session_summary', content: 'Found through the graph', at: EARLIER },
      { sessionId: 'session-z', eventType: 'tool_observation', content: observation('Edit', join(project, 'z.ts')), at: LATER }
    ]);
    const request = { cwd: project, sessionId: CURRENT, filePath: file, scanWindow: 1 };
    const { buildPreEditContext } = await import('../../src/adapters/claude/hooks/pre-edit-memory.js');
    expect(await buildPreEditContext(request)).toBe('');

    const { makeSourceFileKey } = await import('../../src/core/canonical-key.js');
    const { hashProjectPath } = await import('../../src/core/registry/project-path.js');
    const db = new Database(await storePath());
    db.prepare(`INSERT INTO entities (entity_id, entity_type, canonical_key, title, current_json) VALUES ('ent-1', 'source_file', ?, 'src/parser.ts', '{}')`)
      .run(makeSourceFileKey('src/parser.ts', hashProjectPath(project)));
    db.prepare(`INSERT INTO edges (edge_id, src_type, src_id, rel_type, dst_type, dst_id) VALUES ('edge-1', 'event', ?, 'touched_in', 'entity', 'ent-1')`)
      .run(linkedId);
    db.close();

    expect(await buildPreEditContext(request)).toContain('Found through the graph');
  });

  it('deletes other sessions’ shown-item records once they are a week old', async () => {
    await seedPastSession();
    const { buildPreEditContext } = await import('../../src/adapters/claude/hooks/pre-edit-memory.js');
    const now = LATER;
    await buildPreEditContext({ cwd: project, sessionId: 'session-a', filePath: file, now });
    const stateDir = join(await storePath(), '..', 'pre-edit-check');
    const [oldRecord] = readdirSync(stateDir);
    const eightDaysAgo = (now.getTime() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(join(stateDir, oldRecord), eightDaysAgo, eightDaysAgo);

    await buildPreEditContext({ cwd: project, sessionId: 'session-b', filePath: file, now });

    expect(readdirSync(stateDir)).toHaveLength(1);
    expect(readdirSync(stateDir)).not.toContain(oldRecord);
  });
});

describe('PreToolUse hook process', () => {
  function runHookProcess(input: string) {
    const started = Date.now();
    const result = spawnSync(tsxCommand, tsxArgs(join(process.cwd(), 'src', 'hooks', 'pre-tool-use.ts')), {
      input,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, CLAUDE_MEMORY_OPERATIONS_CONFIG_PATH: join(home, 'operations.json') },
      timeout: 20_000
    });
    return { status: result.status, stdout: result.stdout, elapsedMs: Date.now() - started };
  }

  const input = () => JSON.stringify(editInput());

  it('injects through the entry when switched on and prints nothing when switched off', async () => {
    await seedPastSession();

    const on = runHookProcess(input());
    expect(on.status).toBe(0);
    expect(contextOf(on.stdout)).toContain('Rewrote the tokenizer');

    enablePreEditCheck(false);
    expect(runHookProcess(JSON.stringify(editInput({ session_id: 'session-2' })))).toMatchObject({ status: 0, stdout: '' });
  });

  it('gives up quickly, exits 0 and prints nothing while another connection holds the store exclusively', async () => {
    await seedPastSession();
    const unlocked = runHookProcess(JSON.stringify(editInput({ session_id: 'session-unlocked' })));
    const holder = new Database(await storePath());
    holder.pragma('locking_mode = EXCLUSIVE');
    holder.exec('BEGIN EXCLUSIVE');
    try {
      const locked = runHookProcess(input());

      expect(locked).toMatchObject({ status: 0, stdout: '' });
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
