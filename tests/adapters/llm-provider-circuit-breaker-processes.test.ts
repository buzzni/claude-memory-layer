import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tsxArgs, tsxCommand } from '../helpers/tsx-process.js';
import { ProviderCircuitBreaker, type ProviderCircuitConfig } from '../../src/adapters/llm/provider-circuit-breaker.js';
import { listPendingSummaries, savePendingSummary } from '../../src/adapters/llm/summary-pending.js';

const MODULE_URL = pathToFileURL(path.resolve('src/adapters/llm/provider-circuit-breaker.ts')).href;
const PENDING_MODULE_URL = pathToFileURL(path.resolve('src/adapters/llm/summary-pending.ts')).href;
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

function runEntry<T>(entry: string, ...args: string[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxCommand, tsxArgs(entry, ...args), {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(JSON.parse(stdout) as T);
      else reject(new Error(`child exited ${code}: ${stderr}`));
    });
  });
}

/** Waits until every child is spinning on the go file, then creates it. */
async function releaseWhenReady(goFile: string, count: number): Promise<void> {
  await expect.poll(
    () => fs.readdirSync(dir).filter((name) => name.startsWith('go.')).length,
    { timeout: 45_000, interval: 50 }
  ).toBe(count);
  fs.writeFileSync(goFile, '');
}

describe('ProviderCircuitBreaker across processes', () => {
  it('lets exactly one of many concurrent processes probe', async () => {
    const filePath = path.join(dir, 'llm-provider-breaker.json');
    new ProviderCircuitBreaker({ filePath, now: () => START, config: CONFIG })
      .recordFailure('claude', 'provider-rate-limit', { allowed: true, probe: false });

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
      `process.stdout.write(JSON.stringify(breaker.admit('claude', 60000)));`
    ].join('\n'));

    const runs = Array.from({ length: PROCESSES }, () =>
      runEntry<{ allowed: boolean }>(entry, filePath, goFile, String(START + CONFIG.cooldownMs)));
    await releaseWhenReady(goFile, PROCESSES);

    const results = await Promise.all(runs);
    expect(results.filter((result) => result.allowed)).toEqual([{ allowed: true, probe: true, claimId: expect.any(String) }]);
  }, 60_000);
});

describe('summary pending queue across processes', () => {
  it('keeps every session when several processes save at once (review case: 2 of 5 survived)', async () => {
    const homeDir = path.join(dir, 'home');
    savePendingSummary('existing', { homeDir });

    const entry = path.join(dir, 'save.ts');
    const goFile = path.join(dir, 'go');
    fs.writeFileSync(entry, [
      `import * as fs from 'node:fs';`,
      `import { savePendingSummary } from ${JSON.stringify(PENDING_MODULE_URL)};`,
      `const [homeDir, goFile, sessionId] = process.argv.slice(2);`,
      `fs.writeFileSync(goFile + '.' + process.pid, '');`,
      `while (!fs.existsSync(goFile)) { /* spin */ }`,
      `savePendingSummary(sessionId, { homeDir });`,
      `process.stdout.write('true');`
    ].join('\n'));

    const savers = 4;
    const runs = Array.from({ length: savers }, (_, i) => runEntry<boolean>(entry, homeDir, goFile, `s${i}`));
    await releaseWhenReady(goFile, savers);
    await Promise.all(runs);

    expect(listPendingSummaries({ homeDir }).map((entry) => entry.sessionId).sort())
      .toEqual(['existing', 's0', 's1', 's2', 's3']);
  }, 60_000);
});
