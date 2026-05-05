import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

interface PackageJson {
  main: string;
  bin: Record<string, string>;
}

describe('package build entrypoints', () => {
  it('builds the root package main declared in package.json', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as PackageJson;
    const buildScript = readFileSync('scripts/build.ts', 'utf-8');

    expect(pkg.main).toBe('dist/index.js');
    expect(buildScript).toContain("entryPoints: ['src/index.ts']");
    expect(buildScript).toContain("outfile: 'dist/index.js'");
  });

  it('keeps MCP package bin wiring covered by the build script', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as PackageJson;
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf-8')) as { packages: Record<string, { bin?: Record<string, string> }> };
    const buildScript = readFileSync('scripts/build.ts', 'utf-8');

    expect(pkg.bin['claude-memory-layer-mcp']).toBe('dist/mcp/index.js');
    expect(lock.packages[''].bin).toMatchObject(pkg.bin);
    expect(buildScript).toContain("entryPoints: ['src/mcp/index.ts']");
    expect(buildScript).toContain("outfile: 'dist/mcp/index.js'");
  });
});
