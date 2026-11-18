import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * src/hooks/post-tool-use.ts and post-tool-use-failure.ts load the storing
 * part only for a call they store. A wiring mistake there would fail open and
 * store nothing, so run the entries themselves.
 */

const fixture = vi.hoisted(() => ({
  input: '',
  run: null as null | (() => Promise<string>),
  handlerLoaded: false,
  handlerLoadError: null as null | Error
}));
const capture = vi.hoisted(() => vi.fn(async () => '{"stored":true}'));
const captureFailure = vi.hoisted(() => vi.fn(async () => '{"storedFailure":true}'));

vi.mock('../../src/adapters/claude/hooks/hook-runtime.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/adapters/claude/hooks/hook-runtime.js')>(),
  readStdin: vi.fn(async () => fixture.input),
  runHook: vi.fn(async (_options: unknown, run: () => Promise<string>) => { fixture.run = run; })
}));

let stderr: string[];

beforeEach(() => {
  vi.resetModules();
  // post-tool-use-handler.js re-exports this module, so evaluating it is
  // loading the handler. doMock after resetModules runs the factory afresh
  // on each test's first import.
  vi.doMock('../../src/adapters/claude/hooks/post-tool-use.js', () => {
    if (fixture.handlerLoadError) throw fixture.handlerLoadError;
    fixture.handlerLoaded = true;
    return { captureToolObservation: capture, captureToolFailure: captureFailure };
  });
  capture.mockClear();
  captureFailure.mockClear();
  fixture.run = null;
  fixture.handlerLoaded = false;
  fixture.handlerLoadError = null;
  stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

const ENTRIES = {
  'post-tool-use': () => import('../../src/hooks/post-tool-use.js'),
  'post-tool-use-failure': () => import('../../src/hooks/post-tool-use-failure.js')
};

async function runEntry(input: Record<string, unknown>, entry: keyof typeof ENTRIES = 'post-tool-use'): Promise<string> {
  fixture.input = JSON.stringify(input);
  await ENTRIES[entry]();
  expect(fixture.run).not.toBeNull();
  return fixture.run!();
}

const STORED = { session_id: 's', tool_name: 'Edit', tool_input: {}, tool_response: {} };

describe('PostToolUse hook entry', () => {
  it('hands a call it stores to the handler file', async () => {
    expect(await runEntry(STORED)).toBe('{"stored":true}');
    expect(capture).toHaveBeenCalledWith(STORED);
    expect(fixture.handlerLoaded).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('answers a call it drops without loading the handler', async () => {
    expect(await runEntry({ session_id: 's', tool_name: 'Read', tool_input: {}, tool_response: { content: 'x' } })).toBe('{}');
    expect(fixture.handlerLoaded).toBe(false);
  });

  it('says in one line why a call was not stored when the handler cannot load, and exits 1', async () => {
    fixture.handlerLoadError = new Error("Cannot find package 'better-sqlite3' imported from /x/handler.js\n    at stack");

    expect(await runEntry(STORED)).toBe('{}');

    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain('post-tool-use-handler.js');
    expect(stderr[0]).toContain('not stored');
  });
});

const FAILED = { session_id: 's', tool_name: 'Bash', tool_input: { command: 'false' }, error: 'Exit code 1', is_interrupt: false };

describe('PostToolUseFailure hook entry', () => {
  it('hands a failed call it stores to the shared handler file', async () => {
    expect(await runEntry(FAILED, 'post-tool-use-failure')).toBe('{"storedFailure":true}');
    expect(captureFailure).toHaveBeenCalledWith(FAILED);
    expect(capture).not.toHaveBeenCalled();
    expect(fixture.handlerLoaded).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('answers a failed call it drops without loading the handler', async () => {
    expect(await runEntry({ ...FAILED, tool_name: 'Read', tool_input: { file_path: '/x' } }, 'post-tool-use-failure')).toBe('{}');
    expect(fixture.handlerLoaded).toBe(false);
  });

  it('says in one line why a failed call was not stored when the handler cannot load, and exits 1, not 2', async () => {
    fixture.handlerLoadError = new Error("Cannot find package 'better-sqlite3' imported from /x/handler.js\n    at stack");

    expect(await runEntry(FAILED, 'post-tool-use-failure')).toBe('{}');

    // Exit 2 from PostToolUseFailure would show stderr to Claude as feedback on its call.
    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain('claude-memory-layer post-tool-use-failure: cannot load post-tool-use-handler.js');
    expect(stderr[0]).toContain('not stored');
  });
});

describe('reportHookLoadFailure', () => {
  it('writes the first line of the reason and sets exit code 1', async () => {
    const { reportHookLoadFailure } = await import('../../src/adapters/claude/hooks/hook-load-failure.js');

    reportHookLoadFailure('post-tool-use', 'post-tool-use-handler.js', 'this tool call was not stored',
      new Error("Cannot find package 'better-sqlite3' imported from /x/handler.js\n    at stack"));

    expect(process.exitCode).toBe(1);
    expect(stderr).toEqual([
      "claude-memory-layer post-tool-use: cannot load post-tool-use-handler.js (Cannot find package 'better-sqlite3' "
        + 'imported from /x/handler.js), so this tool call was not stored. Run: claude-memory-layer doctor\n'
    ]);
  });
});
