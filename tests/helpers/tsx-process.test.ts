import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { tsxArgs, tsxCommand } from './tsx-process.js';

describe('tsx process helper', () => {
  it('runs a TypeScript entry point directly as a child of the test process', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cml-tsx-process-'));
    const entry = path.join(dir, 'entry.ts');
    writeFileSync(entry, 'const parent: number = process.ppid;\nconsole.log(JSON.stringify({ parent, argv: process.argv.slice(2) }));\n');

    const result = spawnSync(tsxCommand, tsxArgs(entry, '--flag', 'value'), { encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ parent: process.pid, argv: ['--flag', 'value'] });
  });

  it('is the only way tests launch tsx, so vitest.config.ts can classify them', () => {
    const testsRoot = path.resolve('tests');
    const bypasses = readdirSync(testsRoot, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') && file !== path.join('helpers', 'tsx-process.ts'))
      .filter((file) => /'npx',\s*\[\s*'tsx'|'--import',\s*'tsx'|resolve\('tsx|tsx\/dist\/cli/.test(readFileSync(path.join(testsRoot, file), 'utf8')));

    expect(bypasses).toEqual([]);
  });
});
