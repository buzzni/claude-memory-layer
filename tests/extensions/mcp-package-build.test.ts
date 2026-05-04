import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('MCP package/build wiring', () => {
  it('exposes a package bin and build output for the MCP stdio server', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      bin?: Record<string, string>;
    };
    const packageLock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
      packages?: Record<string, { bin?: Record<string, string> }>;
    };
    const buildScript = readFileSync('scripts/build.ts', 'utf8');

    expect(packageJson.bin).toMatchObject({
      'claude-memory-layer': 'dist/cli/index.js',
      'claude-memory-layer-mcp': 'dist/mcp/index.js'
    });
    expect(packageLock.packages?.['']?.bin).toMatchObject(packageJson.bin ?? {});
    expect(buildScript).toContain("entryPoints: ['src/mcp/index.ts']");
    expect(buildScript).toContain("outfile: 'dist/mcp/index.js'");
  });
});
