import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wrappers = [
  { event: 'SessionStart', wrapper: '../../src/hooks/codex-session-start.js', main: '../../src/adapters/claude/hooks/session-start.js' },
  { event: 'UserPromptSubmit', wrapper: '../../src/hooks/codex-user-prompt-submit.js', main: '../../src/adapters/claude/hooks/user-prompt-submit.js' }
] as const;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('CLAUDE_MEMORY_RECALL_OWNER', '');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.doUnmock('../../src/adapters/claude/hooks/session-start.js');
  vi.doUnmock('../../src/adapters/claude/hooks/user-prompt-submit.js');
  vi.doUnmock('../../src/adapters/claude/hooks/hook-runtime.js');
  vi.resetModules();
});

describe('recall runtime failure diagnostics', () => {
  function captureOutput() {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, callback?: (error?: Error | null) => void) => {
      writes.push(String(chunk));
      callback?.(null);
      return true;
    }) as unknown as typeof process.stdout.write);
    return writes;
  }

  it('emits one empty envelope and a redacted runtime diagnostic for an import/body failure even with debug enabled', async () => {
    vi.useFakeTimers();
    vi.stubEnv('CLAUDE_MEMORY_DEBUG', '1');
    const writes = captureOutput();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runHook } = await import('../../src/adapters/claude/hooks/hook-runtime.js');
    await runHook({ name: 'codex-session-start', recallEvent: 'SessionStart', fallbackOutput: '{"hookSpecificOutput":{"hookEventName":"SessionStart"}}' }, async () => {
      throw Object.assign(new Error('private prompt /private/store secret-token'), { code: 'EPERM' });
    });
    expect(writes).toEqual(['{"hookSpecificOutput":{"hookEventName":"SessionStart"}}\n']);
    expect(errors.mock.calls).toEqual([['[cml-recall] {"version":1,"event":"SessionStart","stage":"runtime","outcome":"error","mode":"native","errorCode":"EPERM"}']]);
  });

  it('reports timeout failure only when no envelope was delivered', async () => {
    vi.useFakeTimers();
    const writes = captureOutput();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as unknown as typeof process.exit);
    const { runHook } = await import('../../src/adapters/claude/hooks/hook-runtime.js');
    void runHook({ name: 'codex-user-prompt-submit', recallEvent: 'UserPromptSubmit', fallbackOutput: '{}', timeoutMs: 100 }, () => new Promise<string>(() => {}));
    await vi.advanceTimersByTimeAsync(150);
    expect(writes).toEqual(['{}\n']);
    expect(exit).toHaveBeenCalledWith(0);
    expect(errors.mock.calls).toEqual([['[cml-recall] {"version":1,"event":"UserPromptSubmit","stage":"runtime","outcome":"error","mode":"native","errorCode":"timeout"}']]);
  });

  it('does not reclassify a successfully delivered envelope as a retrieval failure when the process watchdog expires', async () => {
    vi.useFakeTimers();
    const writes = captureOutput();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as unknown as typeof process.exit);
    const { runHook } = await import('../../src/adapters/claude/hooks/hook-runtime.js');
    await runHook({ name: 'codex-user-prompt-submit', recallEvent: 'UserPromptSubmit', fallbackOutput: '{}', timeoutMs: 100 }, async () => '{"ok":true}');
    await vi.advanceTimersByTimeAsync(150);
    expect(writes).toEqual(['{"ok":true}\n']);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('Codex recall ownership', () => {
  it('advertises the explicit, versioned native-owner capability', async () => {
    const { CML_RECALL_HOST_CAPABILITIES, nativeRecallOwnedByHost } = await import('../../src/services/recall-host-contract.js');
    expect(CML_RECALL_HOST_CAPABILITIES).toEqual({ version: 1, nativeEventOwnerMarker: true });
    expect(nativeRecallOwnedByHost({ CLAUDE_MEMORY_RECALL_OWNER: 'host' })).toBe(true);
    for (const owner of [undefined, '', 'native', 'host-worker', 'HOST', ' host ']) {
      expect(nativeRecallOwnedByHost({ CLAUDE_MEMORY_RECALL_OWNER: owner })).toBe(false);
    }
    expect(nativeRecallOwnedByHost({ CLAUDE_MEMORY_LESSON_OWNER: 'host' })).toBe(false);
  });

  for (const hook of wrappers) {
    it(`${hook.event} delegates before loading any retrieval or storage code`, async () => {
      vi.stubEnv('CLAUDE_MEMORY_RECALL_OWNER', 'host');
      const loadMain = vi.fn(() => { throw new Error('delegated native hook must not import storage'); });
      vi.doMock(hook.main, loadMain);
      const outputs: string[] = [];
      const runs: Promise<void>[] = [];
      const runHook = vi.fn((_options: unknown, run: () => Promise<string>) => {
        const pending = run().then((output) => { outputs.push(output); });
        runs.push(pending);
        return pending;
      });
      vi.doMock('../../src/adapters/claude/hooks/hook-runtime.js', () => ({ runHook }));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await import(hook.wrapper);
      await Promise.all(runs);

      expect(loadMain).not.toHaveBeenCalled();
      expect(runHook).toHaveBeenCalledTimes(1);
      expect(outputs).toHaveLength(1);
      expect(JSON.parse(outputs[0])).toEqual({ hookSpecificOutput: { hookEventName: hook.event } });
    });

    for (const owner of ['', 'host-worker']) {
      it(`${hook.event} runs ${owner || 'native'} retrieval once with the correct delivery identity`, async () => {
        vi.stubEnv('CLAUDE_MEMORY_RECALL_OWNER', owner);
        const main = vi.fn().mockResolvedValue(JSON.stringify({ hookSpecificOutput: { hookEventName: hook.event, additionalContext: 'fixture evidence' } }));
        vi.doMock(hook.main, () => ({ main }));
        const runs: Promise<string>[] = [];
        vi.doMock('../../src/adapters/claude/hooks/hook-runtime.js', () => ({
          runHook: vi.fn((_options: unknown, run: () => Promise<string>) => {
            const pending = run();
            runs.push(pending);
            return pending;
          })
        }));

        await import(hook.wrapper);
        const outputs = await Promise.all(runs);

        expect(main).toHaveBeenCalledTimes(1);
        expect(main).toHaveBeenCalledWith(expect.objectContaining({
          contextPresentation: 'reference',
          deliveryClient: owner === 'host-worker' ? 'codex-host' : 'codex-hook',
          ...(owner === 'host-worker' ? { maintenance: false } : {}),
          ...(hook.event === 'UserPromptSubmit' && owner === 'host-worker' ? { allowDaemonStart: false } : {}),
          ...(hook.event === 'UserPromptSubmit' ? { persistPrompt: false } : {})
        }));
        expect(JSON.parse(outputs[0]).hookSpecificOutput.additionalContext).toBe('fixture evidence');
      });
    }
  }
});

describe('privacy-safe recall diagnostics', () => {
  it('keeps only allowlisted error codes and never serializes error text or metadata', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => { lines.push(args.map(String).join(' ')); });
    vi.spyOn(process.stderr, 'write').mockImplementation((value) => { lines.push(String(value).trimEnd()); return true; });
    const { reportRecallDiagnostic } = await import('../../src/adapters/claude/hooks/recall-diagnostics.js');
    const codes = ['EPERM', 'EACCES', 'SQLITE_CANTOPEN', 'SQLITE_READONLY', 'SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_CORRUPT', 'SQLITE_NOTADB', 'invalid_input', 'timeout', 'untrusted-secret-code'];
    for (const code of codes) {
      reportRecallDiagnostic({
        event: 'UserPromptSubmit', stage: 'service', outcome: 'error',
        error: Object.assign(new Error('private prompt and /private/store/path'), { code, sessionId: 'private-session', token: 'private-token' })
      });
    }
    expect(lines).toHaveLength(codes.length);
    for (const [index, line] of lines.entries()) {
      expect(line).toMatch(/^\[cml-recall\] /);
      expect(JSON.parse(line.slice('[cml-recall] '.length))).toEqual({
        version: 1, event: 'UserPromptSubmit', stage: 'service', outcome: 'error', mode: 'native',
        errorCode: index === codes.length - 1 ? 'other' : codes[index]
      });
      expect(line).not.toMatch(/private|untrusted-secret/);
    }
  });

  it('distinguishes empty successful retrieval from delegation and worker execution', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => { lines.push(args.map(String).join(' ')); });
    vi.spyOn(process.stderr, 'write').mockImplementation((value) => { lines.push(String(value).trimEnd()); return true; });
    const { reportRecallDiagnostic } = await import('../../src/adapters/claude/hooks/recall-diagnostics.js');
    for (const owner of ['', 'host', 'host-worker']) {
      vi.stubEnv('CLAUDE_MEMORY_RECALL_OWNER', owner);
      reportRecallDiagnostic({ event: 'SessionStart', stage: 'complete', outcome: owner === 'host' ? 'delegated' : 'empty', contextChars: 0 });
    }
    expect(lines.map((line) => JSON.parse(line.slice('[cml-recall] '.length)))).toEqual([
      { version: 1, event: 'SessionStart', stage: 'complete', outcome: 'empty', mode: 'native', contextChars: 0 },
      { version: 1, event: 'SessionStart', stage: 'complete', outcome: 'delegated', mode: 'host', contextChars: 0 },
      { version: 1, event: 'SessionStart', stage: 'complete', outcome: 'empty', mode: 'host-worker', contextChars: 0 }
    ]);
  });
});
