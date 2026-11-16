import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ spawn: spawnMock }));

import { buildCliProviderEnv, classifyCliProviderFailure, runCliProvider } from '../../src/adapters/llm/cli-provider.js';
import type { CircuitAdmission, ProviderCircuitBreaker } from '../../src/adapters/llm/provider-circuit-breaker.js';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: EventEmitter & { write: () => void; end: () => void };
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { write: () => undefined, end: () => undefined });
  child.kill = () => undefined;
  return child;
}

describe('buildCliProviderEnv', () => {
  it('drops the host-session markers a hook-spawned daemon inherits', () => {
    // Verified on a Saycode-hosted session: with these inherited, `claude -p`
    // answers "Not logged in" even when a local credential exists, because the
    // host is expected to supply auth it never passes to child processes.
    const env = buildCliProviderEnv({
      PATH: '/usr/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      CLAUDE_CODE_ENTRYPOINT: 'remote_mobile',
      CLAUDE_CODE_EXECPATH: '/host/claude'
    });
    expect(env.PATH).toBe('/usr/bin');
    for (const key of [
      'CLAUDECODE',
      'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_EXECPATH'
    ]) {
      expect(env).not.toHaveProperty(key);
    }
  });

  it('still turns every derivation mode off in the child', () => {
    const env = buildCliProviderEnv({ CLAUDE_MEMORY_SUMMARY_MODE: 'llm' });
    expect(env.CLAUDE_MEMORY_SUMMARY_MODE).toBe('off');
    expect(env.CLAUDE_MEMORY_LESSON_MODE).toBe('off');
    expect(env.CLAUDE_MEMORY_DISABLE_HOOKS).toBe('true');
  });
});

describe('runCliProvider', () => {
  afterEach(() => {
    spawnMock.mockReset();
    vi.unstubAllEnvs();
  });

  it('spawns the provider without the inherited host-session markers', async () => {
    vi.stubEnv('CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', '1');
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const run = runCliProvider({
      provider: 'claude',
      model: null,
      prompt: 'hi',
      timeoutMs: 1000,
      scratchDirName: 'cml-test',
      label: 'test provider'
    });
    child.stdout.emit('data', Buffer.from('- ok'));
    child.emit('close', 0);

    await expect(run).resolves.toBe('- ok');
    const env = spawnMock.mock.calls[0][2].env as NodeJS.ProcessEnv;
    expect(env).not.toHaveProperty('CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST');
    expect(env.CLAUDE_MEMORY_DISABLE_HOOKS).toBe('true');
  });
});

describe('classifyCliProviderFailure', () => {
  it.each([
    // Observed shapes: claude -p prints these on stdout and exits 1.
    ['Not logged in · Please run /login', 'provider-auth'],
    ['Claude AI usage limit reached|1767225600', 'provider-rate-limit'],
    ["You've hit your limit · resets 5pm", 'provider-rate-limit'],
    ['5-hour limit reached ∙ resets 3pm', 'provider-rate-limit'],
    ['Weekly limit reached ∙ resets Oct 6, 9am', 'provider-rate-limit'],
    ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}', 'provider-rate-limit'],
    ['Credit balance is too low', 'provider-rate-limit'],
    ['stream error: unexpected status 429 Too Many Requests', 'provider-rate-limit'],
    // Overload is the provider's problem for a moment, not the account's.
    ['API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}', 'provider-error'],
    // Limits of one input are not the account's quota: the next input may pass.
    ['Context limit reached for this conversation', 'provider-error'],
    ['exit code 1', 'provider-error']
  ])('classifies %s as %s', (detail, code) => {
    expect(classifyCliProviderFailure(detail, 'test provider').code).toBe(code);
  });
});

describe('runCliProvider failure detail', () => {
  afterEach(() => { spawnMock.mockReset(); });

  function failWith(stdout: string, stderr: string) {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const run = runCliProvider({
      provider: 'claude',
      model: null,
      prompt: 'hi',
      timeoutMs: 1000,
      scratchDirName: 'cml-test',
      label: 'test provider'
    });
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', 1);
    return run;
  }

  it('classifies from stdout when the CLI reports its error there and leaves stderr empty', async () => {
    // Reproduced with `claude -p` 2.1.x and an empty config dir: exit 1,
    // "Not logged in · Please run /login" on stdout, nothing on stderr.
    await expect(failWith('Not logged in · Please run /login\n', '')).rejects.toMatchObject({ code: 'provider-auth' });
  });

  it('classifies a usage limit reported on stdout as a rate limit', async () => {
    await expect(failWith('Claude AI usage limit reached|1767225600\n', '')).rejects.toMatchObject({
      code: 'provider-rate-limit'
    });
  });

  it('never puts the provider output into the error message', async () => {
    const error = await failWith('Not logged in · secret-ish detail\n', '').catch((caught: unknown) => caught);
    expect(String((error as Error).message)).not.toContain('secret-ish');
  });
});

describe('runCliProvider circuit breaker', () => {
  afterEach(() => { spawnMock.mockReset(); });

  function stubBreaker(admission: CircuitAdmission) {
    return {
      admit: vi.fn(() => admission),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn()
    } as unknown as ProviderCircuitBreaker & {
      admit: ReturnType<typeof vi.fn>;
      recordSuccess: ReturnType<typeof vi.fn>;
      recordFailure: ReturnType<typeof vi.fn>;
    };
  }

  function run(breaker: ProviderCircuitBreaker) {
    return runCliProvider({
      provider: 'claude',
      model: null,
      prompt: 'hi',
      timeoutMs: 1000,
      scratchDirName: 'cml-test',
      label: 'test provider',
      breaker
    });
  }

  it('skips the call without spawning while the breaker is open', async () => {
    const breaker = stubBreaker({ allowed: false, nextProbeAt: '2026-01-01T00:05:00.000Z' });
    await expect(run(breaker)).rejects.toMatchObject({ code: 'provider-circuit-open' });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(breaker.recordFailure).not.toHaveBeenCalled();
  });

  it('records success after a clean exit', async () => {
    const breaker = stubBreaker({ allowed: true, probe: true });
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const pending = run(breaker);
    child.emit('close', 0);
    await pending;
    expect(breaker.recordSuccess).toHaveBeenCalledWith('claude');
  });

  it('records the classified failure with the probe flag', async () => {
    const breaker = stubBreaker({ allowed: true, probe: true });
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const pending = run(breaker);
    child.stdout.emit('data', Buffer.from('Claude AI usage limit reached|1767225600'));
    child.emit('close', 1);
    await expect(pending).rejects.toMatchObject({ code: 'provider-rate-limit' });
    expect(breaker.recordFailure).toHaveBeenCalledWith('claude', 'provider-rate-limit', { probe: true });
  });
});
