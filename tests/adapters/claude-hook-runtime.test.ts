import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHook, readNumberEnv } from '../../src/adapters/claude/hooks/hook-runtime.js';
import { registerHookDeliveryReporter } from '../../src/adapters/claude/hooks/hook-output.js';

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

/** stdout mock that honours the write callback, like the real stream. */
function captureStdoutWithCallback(options: { error?: Error } = {}): string[] {
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: unknown,
    callback?: (error?: Error | null) => void
  ) => {
    writes.push(String(chunk));
    callback?.(options.error ?? null);
    return true;
  }) as unknown as typeof process.stdout.write);
  return writes;
}

describe('hook delivery evidence (specs R3)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    registerHookDeliveryReporter(null);
  });

  it('reports emitted only after the stdout write actually succeeds', async () => {
    captureStdoutWithCallback();
    const outcomes: string[] = [];
    await runHook({ name: 'test', fallbackOutput: '{}' }, async () => {
      registerHookDeliveryReporter((outcome) => {
        outcomes.push(outcome.status);
      });
      // Selection alone must not have reported anything yet.
      expect(outcomes).toEqual([]);
      return '{"context":"ok"}';
    });
    expect(outcomes).toEqual(['emitted']);
  });

  it('reports failed when the write reports an error', async () => {
    captureStdoutWithCallback({ error: new Error('EPIPE') });
    const outcomes: string[] = [];
    await runHook({ name: 'test', fallbackOutput: '{}' }, async () => {
      registerHookDeliveryReporter((outcome) => {
        outcomes.push(outcome.status);
      });
      return '{"context":"ok"}';
    });
    expect(outcomes).toEqual(['failed']);
  });

  it('reports failed when the body throws and the context-free fallback is emitted', async () => {
    captureStdoutWithCallback();
    const outcomes: string[] = [];
    await runHook({ name: 'test', fallbackOutput: '{}' }, async () => {
      registerHookDeliveryReporter((outcome) => {
        outcomes.push(outcome.status);
      });
      throw new Error('hook body failed after selecting memories');
    });
    // The fallback carries no injected context, so the selection was not
    // delivered even though a valid envelope was written.
    expect(outcomes).toEqual(['failed']);
  });

  it('records the failed delivery before the watchdog forces the process to exit', async () => {
    vi.useFakeTimers();
    captureStdoutWithCallback();
    // The sequence is what matters: a real process.exit would end the process,
    // so a delivery record still in flight at that moment is lost.
    const sequence: string[] = [];
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((((code?: number) => {
        sequence.push(`exit:${code}`);
        return undefined;
      }) as unknown) as typeof process.exit);

    void runHook({ name: 'test', fallbackOutput: '{}', timeoutMs: 100 }, () => {
      // The body selected memories, registered its reporter, then wedged.
      registerHookDeliveryReporter(async (outcome) => {
        // An asynchronous write (the real reporter opens a store) must still
        // land before the forced exit.
        await Promise.resolve();
        sequence.push(outcome.status);
      });
      return new Promise<string>(() => {});
    });
    await vi.advanceTimersByTimeAsync(150);

    expect(sequence).toEqual(['failed', 'exit:0']);
    expect(exitSpy).toHaveBeenCalledWith(0);
    vi.useRealTimers();
  });
});
