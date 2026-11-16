import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tsxArgs, tsxCommand } from '../helpers/tsx-process.js';
import { ProviderCircuitBreaker, type ProviderCircuitConfig } from '../../src/adapters/llm/provider-circuit-breaker.js';

const MODULE_URL = pathToFileURL(path.resolve('src/adapters/llm/provider-circuit-breaker.ts')).href;
const START = Date.parse('2026-01-01T00:00:00.000Z');
const CONFIG: ProviderCircuitConfig = { enabled: true, failureThreshold: 1, cooldownMs: 60_000, maxCooldownMs: 60_000 };
const PROCESSES = 8;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cml-breaker-procs-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function runAdmitter(entry: string, filePath: string, goFile: string): Promise<{ allowed: boolean; probe?: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxCommand, tsxArgs(entry, filePath, goFile, String(START + CONFIG.cooldownMs)), {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(JSON.parse(stdout));
      else reject(new Error(`admitter exited ${code}: ${stderr}`));
    });
  });
}

describe('ProviderCircuitBreaker across processes', () => {
  it('lets exactly one of many concurrent processes probe', async () => {
    const filePath = path.join(dir, 'llm-provider-breaker.json');
    new ProviderCircuitBreaker({ filePath, now: () => START, config: CONFIG })
      .recordFailure('claude', 'provider-rate-limit', { probe: false });

    // Every child loads its modules first, then spins until the go file
    // appears, so the admit calls overlap instead of running one by one.
    const entry = path.join(dir, 'admit.ts');
    const goFile = path.join(dir, 'go');
    fs.writeFileSync(entry, [
      `import * as fs from 'node:fs';`,
      `import { ProviderCircuitBreaker } from ${JSON.stringify(MODULE_URL)};`,
      `const [filePath, goFile, now] = process.argv.slice(2);`,
      `const breaker = new ProviderCircuitBreaker({ filePath, now: () => Number(now), config: ${JSON.stringify(CONFIG)} });`,
      `fs.writeFileSync(goFile + '.' + process.pid, '');`,
      `while (!fs.existsSync(goFile)) { /* spin */ }`,
      `process.stdout.write(JSON.stringify(breaker.admit('claude')));`
    ].join('\n'));

    const runs = Array.from({ length: PROCESSES }, () => runAdmitter(entry, filePath, goFile));
    await expect.poll(
      () => fs.readdirSync(dir).filter((name) => name.startsWith('go.')).length,
      { timeout: 45_000, interval: 50 }
    ).toBe(PROCESSES);
    fs.writeFileSync(goFile, '');

    const results = await Promise.all(runs);
    expect(results.filter((result) => result.allowed)).toEqual([{ allowed: true, probe: true }]);
  }, 60_000);
});
