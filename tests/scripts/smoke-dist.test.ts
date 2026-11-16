// @load-sensitive: each case starts a node process per fixture bundle.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const smokeScript = path.join(process.cwd(), 'scripts', 'smoke-dist.mjs');

// The prelude scripts/build.ts puts at the top of every bundle.
const BANNER = "import { createRequire } from 'module';\nconst require = createRequire(import.meta.url);\n";

const HOOKS = [
  'session-start', 'user-prompt-submit', 'post-tool-use', 'stop', 'session-end',
  'codex-session-start', 'codex-user-prompt-submit', 'codex-session-end'
];

const roots: string[] = [];

function writeBundle(root: string, relativePath: string, body: string) {
  const file = path.join(root, 'dist', relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, BANNER + body, 'utf8');
}

/** A package root whose dist/ starts the way the real bundles do. */
function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'cml-dist-smoke-fixture-'));
  roots.push(root);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module', version: '9.9.9' }), 'utf8');
  writeBundle(root, 'cli/index.js', "if (process.argv[2] === '--version') console.log('9.9.9');\n");
  writeBundle(root, 'mcp/index.js', `
process.stdin.setEncoding('utf8');
process.stdin.once('data', (line) => {
  const { id } = JSON.parse(line);
  console.log(JSON.stringify({ jsonrpc: '2.0', id, result: { serverInfo: { name: 'fixture', version: '9.9.9' } } }));
});
process.stdin.resume();
`);
  for (const hook of HOOKS) writeBundle(root, `hooks/${hook}.js`, "process.stdin.resume(); process.stdin.on('end', () => console.log('{}'));\n");
  writeBundle(root, 'core/index.js', 'export const ready = true;\n');
  return root;
}

function runSmoke(root: string) {
  return spawnSync(process.execPath, [smokeScript, root], { encoding: 'utf8', timeout: 60_000 });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('dist smoke', () => {
  it('passes when every entry point starts and answers', () => {
    const result = runSmoke(createFixture());

    expect(result.status, result.stderr).toBe(0);
  });

  it('fails when a source import collides with a name the build banner declares (#198)', () => {
    const root = createFixture();
    // A library bundle no entry point runs: only the syntax check reaches it.
    writeBundle(root, 'core/index.js', "import { createRequire } from 'module';\nexport const ready = createRequire;\n");

    const result = runSmoke(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('core/index.js');
    expect(result.stderr).toContain("Identifier 'createRequire' has already been declared");
  });

  it('fails when a hook does not print a JSON envelope', () => {
    const root = createFixture();
    writeBundle(root, 'hooks/stop.js', "console.log('not json');\n");

    const result = runSmoke(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('hooks/stop.js');
  });

  it('fails when the CLI reports a version other than package.json', () => {
    const root = createFixture();
    writeBundle(root, 'cli/index.js', "console.log('0.0.0');\n");

    const result = runSmoke(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cli/index.js');
  });

  it('fails when the MCP server does not answer initialize', () => {
    const root = createFixture();
    writeBundle(root, 'mcp/index.js', 'process.exit(1);\n');

    const result = runSmoke(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('mcp/index.js');
  });
});
