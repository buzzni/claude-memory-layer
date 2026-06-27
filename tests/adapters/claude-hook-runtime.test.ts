import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHook, readNumberEnv } from '../../src/adapters/claude/hooks/hook-runtime.js';

describe('readNumberEnv', () => {
  const KEY = 'CLAUDE_MEMORY_TEST_NUMBER';
  afterEach(() => {
    delete process.env[KEY];
  });

  it('returns the fallback when the variable is unset or blank', () => {
    expect(readNumberEnv(KEY, 5, { integer: true })).toBe(5);
    process.env[KEY] = '   ';
    expect(readNumberEnv(KEY, 5, { integer: true })).toBe(5);
  });

  it('returns the fallback (not NaN) for non-numeric input', () => {
    process.env[KEY] = 'five';
    const value = readNumberEnv(KEY, 5, { integer: true });
    expect(value).toBe(5);
    expect(Number.isNaN(value)).toBe(false);
  });

  it('parses and clamps valid numbers to the provided bounds', () => {
    process.env[KEY] = '0.75';
    expect(readNumberEnv(KEY, 0.4, { min: 0, max: 1 })).toBeCloseTo(0.75);
    process.env[KEY] = '9';
    expect(readNumberEnv(KEY, 0.4, { min: 0, max: 1 })).toBe(1);
    process.env[KEY] = '-3';
    expect(readNumberEnv(KEY, 0.4, { min: 0, max: 1 })).toBe(0);
  });
});

function captureStdout(): string[] {
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  return writes;
}

describe('runHook', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('emits the hook body output exactly once on success', async () => {
    const writes = captureStdout();
    await runHook({ name: 'test', fallbackOutput: '{}' }, async () => '{"context":"ok"}');
    expect(writes).toEqual(['{"context":"ok"}\n']);
  });

  it('emits the fallback envelope when the body throws (e.g. malformed stdin JSON)', async () => {
    const writes = captureStdout();
    await runHook({ name: 'test', fallbackOutput: '{"context":""}' }, async () => {
      // Mirrors a hook parsing an invalid stdin payload.
      return JSON.parse('not json');
    });
    expect(writes).toEqual(['{"context":""}\n']);
  });

  it('forces the process to exit and emits the fallback when the body hangs past the timeout', async () => {
    vi.useFakeTimers();
    const writes = captureStdout();
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((() => undefined) as unknown) as typeof process.exit);

    // A body that never settles, simulating a wedged stdin / DB call.
    void runHook({ name: 'test', fallbackOutput: '{}', timeoutMs: 100 }, () => new Promise<string>(() => {}));
    await vi.advanceTimersByTimeAsync(150);

    expect(writes).toEqual(['{}\n']);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('does not emit twice when the watchdog fires after a successful emit', async () => {
    vi.useFakeTimers();
    const writes = captureStdout();
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((() => undefined) as unknown) as typeof process.exit);

    await runHook({ name: 'test', fallbackOutput: '{}', timeoutMs: 1000 }, async () => '{"ok":true}');
    // Watchdog still fires to enforce the bounded lifetime, but must not re-emit.
    await vi.advanceTimersByTimeAsync(2000);

    expect(writes).toEqual(['{"ok":true}\n']);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
