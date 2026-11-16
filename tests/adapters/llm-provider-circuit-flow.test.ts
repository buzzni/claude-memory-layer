import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCliProvider } from '../../src/adapters/llm/cli-provider.js';
import {
  ProviderCircuitBreaker,
  getProviderCircuitStatePath,
  readProviderCircuitStates
} from '../../src/adapters/llm/provider-circuit-breaker.js';
import { generateLlmSessionSummary } from '../../src/adapters/llm/session-summary-llm.js';

/**
 * End to end against a stub `claude` on PATH that answers like the real CLI
 * does for each failure kind: the message on stdout, exit 1, empty stderr.
 */
const FAKE_CLAUDE = `#!/bin/sh
cat > /dev/null
echo call >> "$FAKE_CLAUDE_DIR/calls"
case "$(cat "$FAKE_CLAUDE_DIR/mode")" in
  quota) echo 'Claude AI usage limit reached|1767225600'; exit 1 ;;
  auth) echo 'Not logged in · Please run /login'; exit 1 ;;
  crash) echo 'segfault' >&2; exit 2 ;;
  *) echo '- 결정: 스텁 응답'; exit 0 ;;
esac
`;

const START = Date.parse('2026-01-01T00:00:00.000Z');

let root: string;
let fakeDir: string;
let clock: number;

function setMode(mode: 'quota' | 'auth' | 'crash' | 'ok'): void {
  fs.writeFileSync(path.join(fakeDir, 'mode'), mode);
}

function calls(): number {
  try {
    return fs.readFileSync(path.join(fakeDir, 'calls'), 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cml-breaker-flow-'));
  fakeDir = path.join(root, 'bin');
  fs.mkdirSync(fakeDir);
  fs.writeFileSync(path.join(fakeDir, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  setMode('ok');
  clock = START;
  vi.stubEnv('HOME', path.join(root, 'home'));
  vi.stubEnv('PATH', `${fakeDir}${path.delimiter}${process.env.PATH ?? ''}`);
  vi.stubEnv('FAKE_CLAUDE_DIR', fakeDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('provider circuit breaker with a stub CLI', () => {
  it('opens on quota failures, probes once per cooldown, and closes when the provider recovers', async () => {
    const breaker = new ProviderCircuitBreaker({
      filePath: path.join(root, 'breaker.json'),
      now: () => clock,
      config: { enabled: true, failureThreshold: 3, cooldownMs: 60_000, maxCooldownMs: 240_000 }
    });
    const call = () => runCliProvider({
      provider: 'claude',
      model: null,
      prompt: 'hi',
      timeoutMs: 10_000,
      scratchDirName: 'cml-breaker-flow',
      label: 'flow provider',
      breaker
    });

    setMode('quota');
    for (let i = 0; i < 3; i += 1) await expect(call()).rejects.toMatchObject({ code: 'provider-rate-limit' });
    expect(calls()).toBe(3);

    // Open: skipped without starting the CLI.
    await expect(call()).rejects.toMatchObject({ code: 'provider-circuit-open' });
    expect(calls()).toBe(3);

    // Cooldown over: one probe, still limited, reopens for twice as long.
    clock = START + 60_000;
    await expect(call()).rejects.toMatchObject({ code: 'provider-rate-limit' });
    expect(calls()).toBe(4);
    await expect(call()).rejects.toMatchObject({ code: 'provider-circuit-open' });
    expect(calls()).toBe(4);

    // A crash during the probe is not evidence either way: same cooldown.
    clock = START + 180_000;
    setMode('crash');
    await expect(call()).rejects.toMatchObject({ code: 'provider-error' });
    expect(readProviderCircuitStates(path.join(root, 'breaker.json')).claude).toMatchObject({
      state: 'open', cooldownMs: 120_000
    });

    // Quota reset: the next probe succeeds and the breaker closes.
    clock = START + 300_000;
    setMode('ok');
    await expect(call()).resolves.toContain('스텁 응답');
    await expect(call()).resolves.toContain('스텁 응답');
    expect(calls()).toBe(7);
    expect(readProviderCircuitStates(path.join(root, 'breaker.json')).claude).toBeUndefined();
  });

  it('protects session summaries through the default on-disk breaker in the memory root', async () => {
    vi.stubEnv('CLAUDE_MEMORY_LLM_BREAKER', 'on');
    setMode('auth');
    const events = [
      { eventType: 'user_prompt', content: '무엇을 할까' },
      { eventType: 'agent_response', content: '이렇게 하기로 했다' }
    ];

    for (let i = 0; i < 3; i += 1) {
      await expect(generateLlmSessionSummary(events)).rejects.toMatchObject({ code: 'provider-auth' });
    }
    await expect(generateLlmSessionSummary(events)).rejects.toMatchObject({ code: 'provider-circuit-open' });
    expect(calls()).toBe(3);
    expect(readProviderCircuitStates(getProviderCircuitStatePath(path.join(root, 'home'))).claude).toMatchObject({
      state: 'open', reason: 'provider-auth'
    });
  });
});
