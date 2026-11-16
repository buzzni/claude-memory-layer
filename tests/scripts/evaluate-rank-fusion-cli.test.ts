import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { tsxArgs, tsxCommand } from '../helpers/tsx-process.js';

const run = (...args: string[]) => spawnSync(tsxCommand, tsxArgs('scripts/evaluate-rank-fusion.ts', ...args), {
  cwd: process.cwd(),
  encoding: 'utf8'
});

describe('evaluate-rank-fusion CLI', () => {
  it('requires a fixture and a model cache', () => {
    const result = run('--fixture', 'benchmarks/replay/golden-memory-usefulness-v1.json');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--fixture and --model-cache are required');
  });

  it('rejects an unknown reranker before loading any model', () => {
    const result = run('--fixture', 'benchmarks/replay/golden-memory-usefulness-v1.json', '--model-cache', '.', '--reranker', 'nope');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--reranker must be none or one of mmarco-minilm, bge-m3');
  });
});
