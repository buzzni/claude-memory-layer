import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { tsxArgs, tsxCommand } from '../helpers/tsx-process.js';

const ROOT = process.cwd();
const tempDirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-eval-paths-'));
  tempDirs.push(dir);
  return dir;
};
const run = (args: string[]) => spawnSync(tsxCommand, tsxArgs(...args), { cwd: ROOT, encoding: 'utf8' });
const hasLocalPath = (value: unknown) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.includes(ROOT) || text.includes(homedir()) || text.includes(tmpdir());
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('evaluation outputs keep paths out of result fields', () => {
  it('evaluate-lesson-hybrid prints cacheDir as a path ref', () => {
    const cache = tempDir();
    const result = run(['scripts/evaluate-lesson-hybrid.ts', 'benchmarks/lesson-recall/calibration-v1.json', cache]);
    expect(result.status).toBe(2);
    // detail is the loader's own error text, outside this contract.
    const { provenance, detail: _detail, ...output } = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));

    expect(output.outcome).toBe('local_model_unavailable');
    expect(output.cacheDir).toMatch(/^outside-repo:[0-9a-f]{16}$/);
    expect(output.cacheDir).toBe(provenance.flags.cacheDir);
    expect(hasLocalPath(output)).toBe(false);
  });

  it('evaluate-lesson-hybrid-heldout writes fixture and cacheDir as path refs', () => {
    const outputPath = path.join(tempDir(), 'result.json');
    const result = run(['scripts/evaluate-lesson-hybrid-heldout.ts', 'benchmarks/lesson-recall/calibration-v1.json', outputPath]);
    expect([0, 1]).toContain(result.status);
    const written = JSON.parse(readFileSync(outputPath, 'utf8'));

    expect(written.fixture).toBe('benchmarks/lesson-recall/calibration-v1.json');
    expect(written.cacheDir).toBe('.cache/lesson-hybrid-e5');
    expect(hasLocalPath(written)).toBe(false);
    expect(JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))).fixture).toBe(written.fixture);
  });

  it('replay-retrieval-benchmark prints the qrels fixture as a path ref', () => {
    const fixturePath = path.join(tempDir(), 'fixture.json');
    writeFileSync(fixturePath, JSON.stringify({
      name: 'qrels-fixture',
      ks: [1],
      metadata: { rawContentIncluded: false },
      queries: [{ queryId: 'q1', query: 'marker', expectedIds: ['m1'], expectedRelevance: { m1: 1 } }],
      memories: [{ id: 'm1', content: 'marker memory' }, { id: 'm2', content: 'other' }]
    }));
    const inRepo = run(['scripts/replay-retrieval-benchmark.ts', '--fixture', path.join(ROOT, 'benchmarks/replay/memory-operations-v1.json'), '--format', 'markdown']);
    const outside = run(['scripts/replay-retrieval-benchmark.ts', '--fixture', fixturePath, '--format', 'markdown']);

    expect(inRepo.stdout).toContain('- Qrels: `benchmarks/replay/memory-operations-v1.json`\n');
    const qrels = outside.stdout.split('\n').find((line) => line.startsWith('- Qrels:'));
    expect(qrels).toMatch(/^- Qrels: `outside-repo:[0-9a-f]{16}`$/);
    expect(hasLocalPath(outside.stdout)).toBe(false);
  });
});
