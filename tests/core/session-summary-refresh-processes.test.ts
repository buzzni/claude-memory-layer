import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tsxArgs, tsxCommand } from '../helpers/tsx-process.js';
import { DEFAULT_SESSION_SUMMARY_REFRESH } from '../../src/core/engine/memory-ingest-service.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

/**
 * Only one summary run per store at a time is what keeps two daemons (or a
 * daemon and a pending retry) from each storing a refresh of the same session.
 * The semantic daemon takes `summary-worker.lock` with WorkerLock before it
 * calls generateLlmSessionSummary and skips the run when it cannot; each child
 * here does the same against one store, all released at once.
 */

const STORE_URL = pathToFileURL(path.resolve('src/core/sqlite-event-store.ts')).href;
const INGEST_URL = pathToFileURL(path.resolve('src/core/engine/memory-ingest-service.ts')).href;
const LOCK_URL = pathToFileURL(path.resolve('src/core/worker-lock.ts')).href;
const PROCESSES = 4;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cml-summary-procs-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function runEntry<T>(entry: string, ...args: string[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxCommand, tsxArgs(entry, ...args), { stdio: ['ignore', 'pipe', 'pipe'] });
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

describe('summary refresh across processes', () => {
  it('stores one summary and calls the provider once when several processes refresh the same session', async () => {
    const dbPath = path.join(dir, 'events.sqlite');
    const seed = new SQLiteEventStore(dbPath);
    await seed.initialize();
    let tick = Date.parse('2026-11-17T00:00:00.000Z');
    const exchange = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await seed.append({ eventType: i % 2 ? 'agent_response' : 'user_prompt', sessionId: 's', timestamp: new Date(tick++), content: `대화 ${tick}` });
      }
    };
    await exchange(2);
    await seed.append({ eventType: 'tool_observation', sessionId: 's', timestamp: new Date(tick++), content: '{}' });
    await seed.append({ eventType: 'session_summary', sessionId: 's', timestamp: new Date(tick++), content: '- 결정: 첫 요약', metadata: { summarizedExchangeCount: 2 } });
    await exchange(DEFAULT_SESSION_SUMMARY_REFRESH.minNewExchanges);
    await seed.close();

    const entry = path.join(dir, 'summarize.mts');
    const goFile = path.join(dir, 'go');
    fs.writeFileSync(entry, [
      `import * as fs from 'node:fs';`,
      `import { SQLiteEventStore } from ${JSON.stringify(STORE_URL)};`,
      `import { MemoryIngestService } from ${JSON.stringify(INGEST_URL)};`,
      `import { WorkerLock } from ${JSON.stringify(LOCK_URL)};`,
      `const [dbPath, lockPath, goFile] = process.argv.slice(2);`,
      `const store = new SQLiteEventStore(dbPath);`,
      `await store.initialize();`,
      `let called = false;`,
      `const service = new MemoryIngestService({`,
      `  initialize: async () => {}, eventStore: store, markdownMirror: { append: async () => {} }, createToolEmbedding: () => '',`,
      `  llmSummaryGenerator: async () => {`,
      `    called = true;`,
      `    await new Promise((resolve) => setTimeout(resolve, 300));`,
      `    return { text: '- 결정: ' + process.pid, metadata: { generated: 'llm' } };`,
      `  }`,
      `});`,
      `fs.writeFileSync(goFile + '.' + process.pid, '');`,
      `while (!fs.existsSync(goFile)) { /* spin */ }`,
      `const lock = new WorkerLock(lockPath);`,
      `const acquired = lock.acquire().acquired;`,
      `if (acquired) { try { await service.generateLlmSessionSummary('s'); } finally { lock.release(); } }`,
      `await store.close();`,
      `process.stdout.write(JSON.stringify({ acquired, called }));`
    ].join('\n'));

    const runs = Array.from({ length: PROCESSES }, () =>
      runEntry<{ acquired: boolean; called: boolean }>(entry, dbPath, path.join(dir, 'summary-worker.lock'), goFile));
    await expect.poll(
      () => fs.readdirSync(dir).filter((name) => name.startsWith('go.')).length,
      { timeout: 90_000, interval: 50 }
    ).toBe(PROCESSES);
    fs.writeFileSync(goFile, '');
    const results = await Promise.all(runs);

    // A process that got the lock after the first one let go found nothing due.
    expect(results.filter((result) => result.called)).toHaveLength(1);
    const store = new SQLiteEventStore(dbPath);
    await store.initialize();
    const visible = (await store.getSessionEvents('s')).filter((event) => event.eventType === 'session_summary');
    expect(visible).toHaveLength(1);
    expect(visible[0].content).not.toBe('- 결정: 첫 요약');
    await store.close();
  }, 120_000);
});
