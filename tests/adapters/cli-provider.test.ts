import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ spawn: spawnMock }));

import { buildCliProviderEnv, runCliProvider } from '../../src/adapters/llm/cli-provider.js';

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
