import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * src/hooks/pre-tool-use.ts loads the pre-edit check only when it is on.
 * When that load fails the edit goes ahead, and the failure is reported the
 * way the launcher reports a hook that cannot load.
 */

const fixture = vi.hoisted(() => ({ switchedOn: true, handlerLoadError: null as null | Error }));

vi.mock('../../src/adapters/claude/hooks/pre-edit-check-switch.js', () => ({
  preEditCheckSwitchedOn: () => fixture.switchedOn
}));

vi.mock('../../src/adapters/claude/hooks/hook-runtime.js', () => ({ runHook: vi.fn(async () => undefined) }));

let stderr: string[];

beforeEach(() => {
  vi.resetModules();
  // pre-tool-use-handler.js imports this module and runs the hook on import.
  vi.doMock('../../src/adapters/claude/hooks/pre-tool-use.js', () => {
    if (fixture.handlerLoadError) throw fixture.handlerLoadError;
    return { main: vi.fn(async () => ''), PRE_TOOL_USE_TIMEOUT_MS: 1000 };
  });
  fixture.switchedOn = true;
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

describe('PreToolUse hook entry', () => {
  it('runs the pre-edit check without a report when it loads', async () => {
    await import('../../src/hooks/pre-tool-use.js');
    const { runHook } = await import('../../src/adapters/claude/hooks/hook-runtime.js');
    expect(runHook).toHaveBeenCalledTimes(1);
    expect(stderr).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it('says in one line that the check did not run when it cannot load, and exits 1 without blocking', async () => {
    fixture.handlerLoadError = new Error("Cannot find package 'better-sqlite3'\n    at stack");

    await import('../../src/hooks/pre-tool-use.js');

    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain('pre-tool-use-handler.js');
    expect(stderr[0]).toContain('pre-edit check did not run');
  });

  it('loads nothing while the check is off', async () => {
    fixture.switchedOn = false;
    fixture.handlerLoadError = new Error('must not load');

    await import('../../src/hooks/pre-tool-use.js');

    expect(stderr).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });
});
