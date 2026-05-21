import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

function writeFixture(name: string, fixture: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-replay-cli-'));
  const fixturePath = path.join(dir, `${name}.json`);
  writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  return fixturePath;
}

function runReplayCli(args: string[]) {
  return spawnSync('npx', ['tsx', 'scripts/replay-retrieval-benchmark.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });
}

function runBenchmarkReplayScript(args: string[]) {
  return spawnSync('npm', ['run', 'benchmark:replay', '--', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });
}

describe('replay retrieval benchmark CLI threshold gate', () => {
  it('wires npm benchmark:replay to fail closed when replay thresholds are violated', () => {
    const fixturePath = writeFixture('npm-threshold-failure', {
      name: 'npm-threshold-failure-fixture',
      ks: [1, 3],
      metadata: { rawContentIncluded: false },
      queries: [
        {
          queryId: 'q-npm-forbidden-hit',
          category: 'topic-shift-no-match',
          query: 'npm replay threshold marker',
          expectation: 'no_match',
          expectedIds: [],
          expectedRelevance: {},
          forbiddenIds: ['m-forbidden']
        }
      ],
      memories: [
        {
          id: 'm-forbidden',
          content: 'npm replay threshold marker should trip the default gate'
        }
      ]
    });

    const result = runBenchmarkReplayScript([
      '--fixture', fixturePath,
      '--format', 'json'
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"failedQueryCount"');
    expect(result.stdout).not.toContain('npm replay threshold marker');
    expect(result.stderr).toContain('Replay threshold gate failed');
    expect(result.stderr).toContain('failedQueryCount');
    expect(result.stderr).toContain('forbiddenHitCount');
    expect(result.stderr).toContain('noMatchAccuracy');
  });

  it('exits non-zero when configured golden thresholds are violated', () => {
    const fixturePath = writeFixture('threshold-failure', {
      name: 'threshold-failure-fixture',
      ks: [1, 3],
      metadata: { rawContentIncluded: false },
      queries: [
        {
          queryId: 'q-forbidden-hit',
          category: 'topic-shift-no-match',
          query: 'synthetic forbidden replay marker',
          expectation: 'no_match',
          expectedIds: [],
          expectedRelevance: {},
          forbiddenIds: ['m-forbidden']
        }
      ],
      memories: [
        {
          id: 'm-forbidden',
          content: 'synthetic forbidden replay marker should not be selected'
        }
      ]
    });

    const result = runReplayCli([
      '--fixture', fixturePath,
      '--format', 'json',
      '--max-failed-queries', '0',
      '--max-forbidden-hits', '0',
      '--min-no-match-accuracy', '1'
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"failedQueryCount"');
    expect(result.stdout).not.toContain('synthetic forbidden replay marker');
    expect(result.stderr).toContain('Replay threshold gate failed');
    expect(result.stderr).toContain('failedQueryCount');
    expect(result.stderr).toContain('forbiddenHitCount');
    expect(result.stderr).toContain('noMatchAccuracy');
  });

  it('exits zero when all configured thresholds pass', () => {
    const fixturePath = writeFixture('threshold-pass', {
      name: 'threshold-pass-fixture',
      ks: [1, 3],
      metadata: { rawContentIncluded: false },
      queries: [
        {
          queryId: 'q-positive',
          category: 'debugging',
          query: 'alpha replay anchor',
          expectation: 'match',
          expectedIds: ['m-positive'],
          expectedRelevance: { 'm-positive': 2 }
        },
        {
          queryId: 'q-no-match',
          category: 'topic-shift-no-match',
          query: 'unrelated zzz no match surface',
          expectation: 'no_match',
          expectedIds: [],
          expectedRelevance: {},
          forbiddenIds: ['m-positive']
        }
      ],
      memories: [
        {
          id: 'm-positive',
          content: 'alpha replay anchor'
        }
      ]
    });

    const result = runReplayCli([
      '--fixture', fixturePath,
      '--format', 'json',
      '--min-score', '0.99',
      '--max-failed-queries', '0',
      '--max-forbidden-hits', '0',
      '--min-query-yield', '1',
      '--min-no-match-accuracy', '1'
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('Replay threshold gate failed');
    expect(result.stdout).toContain('"failedQueryCount": 0');
  });

  it('rejects malformed threshold values before running the benchmark', () => {
    const fixturePath = writeFixture('threshold-invalid', {
      name: 'threshold-invalid-fixture',
      ks: [1],
      queries: [],
      memories: []
    });

    const result = runReplayCli([
      '--fixture', fixturePath,
      '--min-query-yield', '1oops'
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid --min-query-yield');
    expect(result.stdout).toBe('');
  });
});
