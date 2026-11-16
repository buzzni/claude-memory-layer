import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const guardScript = path.join(process.cwd(), 'scripts', 'guard-release-artifact.cjs');

function runTarballGuard(files: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-tarball-guard-'));
  const packJsonPath = path.join(dir, 'pack-dry-run.json');
  writeFileSync(packJsonPath, JSON.stringify([{
    name: 'cml-fixture',
    version: '2.5.8',
    filename: 'cml-fixture-2.5.8.tgz',
    size: 1,
    unpackedSize: 1,
    files: files.map((filePath) => ({ path: filePath, size: 1, mode: 420 }))
  }]), 'utf8');
  return spawnSync('node', [guardScript, 'tarball', packJsonPath], { encoding: 'utf8' });
}

describe('release tarball guard', () => {
  it('fails when LICENSE would be missing from the published tarball', () => {
    const result = runTarballGuard(['package.json', 'README.md', 'dist/cli/index.js']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('LICENSE');
  });

  it.each(['README.md', 'README.ko.md'])('fails when %s would be missing from the published tarball', (readme) => {
    const files = ['LICENSE', 'README.md', 'README.ko.md', 'package.json', 'dist/cli/index.js'];
    const result = runTarballGuard(files.filter((file) => file !== readme));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(readme);
  });

  it('passes when the tarball carries the required files and nothing forbidden', () => {
    const result = runTarballGuard(['LICENSE', 'package.json', 'README.md', 'README.ko.md', 'dist/cli/index.js']);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ check: 'tarball', missing: [], suspicious: [] });
  });

  it('still fails on forbidden files when the required files are present', () => {
    const result = runTarballGuard(['LICENSE', 'README.md', 'README.ko.md', 'package.json', 'src/index.ts']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('forbidden');
  });
});
