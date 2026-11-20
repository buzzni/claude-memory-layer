// @load-sensitive: each case starts a node process per fixture bundle.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HOOK_ENTRIES } from '../../scripts/build.js';
import { PLUGIN_HOOKS } from '../../src/apps/cli/claude-settings-hooks.js';
import { tsxArgs, tsxCommand } from '../helpers/tsx-process.js';

const smokeScript = path.join(process.cwd(), 'scripts', 'smoke-dist.ts');

// The prelude scripts/build.ts puts at the top of every bundle.
const BANNER = "import { createRequire } from 'module';\nconst require = createRequire(import.meta.url);\n";

// Hooks whose empty output means "no instructions" / "allow" to the host.
const SILENT_HOOKS = new Set(['pre-compact', 'pre-tool-use']);

const roots: string[] = [];

function writeBundle(root: string, relativePath: string, body: string) {
  const file = path.join(root, 'dist', relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, BANNER + body, 'utf8');
}

function hookBody(output: string) {
  return `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(output)}));\n`;
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
  for (const hook of HOOK_ENTRIES) writeBundle(root, `hooks/${hook}.js`, hookBody(SILENT_HOOKS.has(hook) ? '' : '{}\n'));
  writeBundle(root, 'core/index.js', 'export const ready = true;\n');
  return root;
}

function runSmoke(root: string) {
  return spawnSync(tsxCommand, tsxArgs(smokeScript, root), { encoding: 'utf8', timeout: 60_000 });
}

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('dist smoke', () => {
  it('passes, running every hook the Claude Code install and plugin register, when every entry point starts and answers', () => {
    const result = runSmoke(createFixture());

    expect(result.status, result.stderr).toBe(0);
    for (const file of Object.values(PLUGIN_HOOKS)) {
      expect(result.stdout).toMatch(new RegExp(`^ok {3}dist/hooks/${file} exits 0`, 'm'));
    }
  });

  // The smoke reports every check on its own, so one run over a dist with one
  // broken entry point of each kind shows that each kind is caught.
  describe('fails a dist where', () => {
    let result: SpawnSyncReturns<string>;

    beforeAll(() => {
      const root = createFixture();
      // A library bundle no entry point runs: only the syntax check reaches it (#198).
      writeBundle(root, 'core/index.js', "import { createRequire } from 'module';\nexport const ready = createRequire;\n");
      writeBundle(root, 'cli/index.js', "console.log('0.0.0');\n");
      writeBundle(root, 'mcp/index.js', 'process.exit(1);\n');
      writeBundle(root, 'hooks/post-tool-use-failure.js', "console.log('{}'); process.exitCode = 1;\n");
      writeBundle(root, 'hooks/stop.js', "console.log('not json');\n");
      writeBundle(root, 'hooks/session-start.js', hookBody(''));
      rmSync(path.join(root, 'dist', 'hooks', 'pre-compact.js'));
      rmSync(path.join(root, 'dist', 'hooks', 'codex-session-end.js'));
      result = runSmoke(root);
    });

    it('exits 1 and still passes the entry points that work', () => {
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/^ok {3}dist\/hooks\/user-prompt-submit\.js /m);
    });

    it.each([
      ['a source import collides with a name the build banner declares (#198)', "FAIL node --check dist/core/index.js\n", "Identifier 'createRequire' has already been declared"],
      ['the CLI reports a version other than package.json', 'FAIL dist/cli/index.js --version', 'stdout: 0.0.0'],
      ['the MCP server does not answer initialize', 'FAIL dist/mcp/index.js answers initialize', 'exit=1'],
      ['a hook exits non-zero after printing its envelope', 'FAIL dist/hooks/post-tool-use-failure.js', 'exit=1'],
      ['a hook does not print a JSON envelope', 'FAIL dist/hooks/stop.js', 'stdout: not json'],
      ['a hook that must answer prints nothing', 'FAIL dist/hooks/session-start.js', 'exit=0'],
      ['a registered Claude Code hook is missing', 'FAIL dist/hooks/pre-compact.js', 'Cannot find module'],
      ['a registered Codex hook is missing', 'FAIL dist/hooks/codex-session-end.js', 'Cannot find module']
    ])('%s', (_case, label, detail) => {
      expect(result.stderr).toContain(label);
      // This check's report runs up to the next failed check.
      const report = result.stderr.slice(result.stderr.indexOf(label)).split(/\nFAIL /)[0];
      expect(report).toContain(detail);
    });
  });
});
