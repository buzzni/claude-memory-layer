import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  assertSplitAccess,
  findSplitOverlaps,
  fixtureSplit,
  loadSplitManifest,
  promptHash,
  type EvalCase,
  type EvalSplit
} from '../../scripts/eval-split.js';

const ROOT = process.cwd();
const FIXTURE_DIR = join(ROOT, 'benchmarks/lesson-recall');
const manifest = loadSplitManifest();
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const repoFixtures = () => readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.json') && name !== 'splits.json').sort();

describe('promptHash', () => {
  it('treats prompts that differ only in case, width, or whitespace as the same case', () => {
    expect(promptHash('  Undo the LAST\n release  ')).toBe(promptHash('undo the last release'));
    expect(promptHash('ＡＰＩ 키')).toBe(promptHash('api 키'));
    expect(promptHash('undo the last release')).not.toBe(promptHash('undo the first release'));
  });
});

describe('findSplitOverlaps', () => {
  const dev: EvalCase[] = [{ id: 'a', query: 'remove credentials from logs' }];
  it('reports a case id present in both splits', () => {
    expect(findSplitOverlaps({ dev, test: [{ id: 'a', query: 'something else' }] })).toEqual(['a']);
  });
  it('reports a normalized prompt present in both splits under different ids', () => {
    expect(findSplitOverlaps({ dev, test: [{ id: 'b', query: 'Remove  credentials from LOGS' }] })).toEqual(['a', 'b']);
  });
  it('accepts disjoint splits', () => {
    expect(findSplitOverlaps({ dev, test: [{ id: 'b', query: 'rotate the signing key' }] })).toEqual([]);
  });
});

describe('assertSplitAccess', () => {
  it('lets tuning read dev data', () => {
    expect(() => assertSplitAccess('dev', 'f.json', { finalReport: false, calibrating: true })).not.toThrow();
  });
  it('refuses test data by default', () => {
    expect(() => assertSplitAccess('test', 'f.json', { finalReport: false })).toThrow(/test split.*--final-report/);
  });
  it('allows test data only for an explicit final report', () => {
    expect(() => assertSplitAccess('test', 'f.json', { finalReport: true })).not.toThrow();
  });
  it('never calibrates on test data, even for a final report', () => {
    expect(() => assertSplitAccess('test', 'f.json', { finalReport: true, calibrating: true })).toThrow(/calibrat/);
  });
  it('refuses a fixture without a registered split', () => {
    expect(() => assertSplitAccess(undefined, 'f.json', { finalReport: true })).toThrow(/no registered split/);
  });
});

describe('fixtureSplit', () => {
  it('looks a fixture up by content hash, so an edited fixture loses its split', () => {
    const bytes = readFileSync(join(FIXTURE_DIR, 'calibration-v1.json'));
    expect(fixtureSplit(bytes, manifest)).toBe('dev');
    expect(fixtureSplit(Buffer.concat([bytes, Buffer.from(' ')]), manifest)).toBeUndefined();
  });
});

describe('benchmarks/lesson-recall split manifest', () => {
  it('registers every fixture with its current content hash', () => {
    const untagged = repoFixtures().filter((name) => {
      const entry = manifest.fixtures.find((fixture) => fixture.file === name);
      return !entry || entry.sha256 !== sha256(readFileSync(join(FIXTURE_DIR, name)));
    });
    expect(untagged, 'fixtures without a matching splits.json entry').toEqual([]);
    const listed = manifest.fixtures.filter((fixture) => !fixture.external).map((fixture) => fixture.file).sort();
    expect(listed).toEqual(repoFixtures());
  });

  it('keeps dev and test cases disjoint by case id and normalized prompt', () => {
    const cases: Record<EvalSplit, EvalCase[]> = { dev: [], test: [] };
    for (const fixture of manifest.fixtures.filter((entry) => !entry.external)) {
      cases[fixture.split].push(...(JSON.parse(readFileSync(join(FIXTURE_DIR, fixture.file), 'utf8')) as { cases: EvalCase[] }).cases);
    }
    expect(cases.dev.length).toBeGreaterThan(0);
    expect(cases.test.length).toBeGreaterThan(0);
    expect(findSplitOverlaps(cases)).toEqual([]);
  });
});

describe('tuning scripts refuse test fixtures', () => {
  const run = (script: string, args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts', script), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  const release = join(FIXTURE_DIR, 'release-v2-independent.json');

  it('evaluate-lesson-hybrid.ts stops before loading a model', () => {
    const result = run('evaluate-lesson-hybrid.ts', [release, tmpdir()]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/test split/);
  }, 60_000);

  it('evaluate-lesson-hybrid-heldout.ts stops before loading a model', () => {
    const result = run('evaluate-lesson-hybrid-heldout.ts', [release, join(tmpdir(), 'unused-result.json')]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/test split/);
  }, 60_000);
});
