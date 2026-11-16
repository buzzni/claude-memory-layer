#!/usr/bin/env node
// Starts the built bundles in dist/ the way users and hosts do. Run after
// `npm run build`: node scripts/smoke-dist.mjs [package-root]
//
// typecheck, lint and vitest all run against src/, so a bundle that dies at
// startup passes every one of them (#198). The known case: a source file that
// imports a name the build banner already declares (`createRequire`,
// `require`, `__filename`, `__dirname`) builds fine and then throws
// "Identifier ... has already been declared" before any code runs.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? process.cwd());
const dist = path.join(root, 'dist');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const TIMEOUT_MS = 30_000;

// Hooks Claude Code and Codex spawn with an event on stdin. Worker and daemon
// bundles are only syntax-checked: running them starts background work.
const STDIN_HOOKS = [
  'session-start', 'user-prompt-submit', 'post-tool-use', 'stop', 'session-end',
  'codex-session-start', 'codex-user-prompt-submit', 'codex-session-end'
];
// Copied as-is by the build, not bundled.
const COPIED_DIRS = new Set(['ui', 'skills', '.claude-plugin']);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cml-dist-smoke-'));
// Nothing inherited beyond PATH, so a CLAUDE_MEMORY_* override in the caller's
// environment cannot point the bundles at a real memory store.
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: home };
const failures = [];

function report(label, ok, detail) {
  if (ok) {
    console.log(`ok   ${label}`);
    return;
  }
  failures.push(label);
  console.error(`FAIL ${label}\n${detail.trim()}\n`);
}

function describeRun({ status, signal, stdout, stderr }) {
  return `exit=${status} signal=${signal ?? 'none'}\nstdout: ${stdout.trim().slice(0, 500)}\nstderr: ${stderr.trim().slice(0, 2000)}`;
}

function run(relativePath, args, input = '') {
  const result = spawnSync(process.execPath, [path.join(dist, relativePath), ...args], {
    cwd: home, env, input, encoding: 'utf8', timeout: TIMEOUT_MS
  });
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Sends `initialize` and closes stdin once the reply line arrives. */
function initializeMcp(relativePath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dist, relativePath)], { cwd: home, env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    // A bundle that dies at startup closes the pipe before the write lands.
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('\n')) child.stdin.end();
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dist-smoke', version } }
    })}\n`);
  });
}

try {
  const bundles = fs.readdirSync(dist, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.js') && !COPIED_DIRS.has(file.split(path.sep)[0]))
    .sort();
  for (const bundle of bundles) {
    const checked = spawnSync(process.execPath, ['--check', path.join(dist, bundle)], { encoding: 'utf8', timeout: TIMEOUT_MS });
    report(`node --check dist/${bundle}`, checked.status === 0, checked.stderr ?? '');
  }

  const cli = run('cli/index.js', ['--version']);
  report(`dist/cli/index.js --version prints ${version}`, cli.status === 0 && cli.stdout.trim() === version, describeRun(cli));

  const mcp = await initializeMcp('mcp/index.js');
  const reply = parseJson(mcp.stdout.split('\n')[0]);
  report(
    'dist/mcp/index.js answers initialize',
    mcp.status === 0 && reply?.id === 1 && reply.result?.serverInfo?.version === version,
    describeRun(mcp)
  );

  for (const hook of STDIN_HOOKS) {
    const result = run(`hooks/${hook}.js`, []);
    const output = parseJson(result.stdout);
    report(
      `dist/hooks/${hook}.js prints a JSON envelope on empty stdin`,
      result.status === 0 && typeof output === 'object' && output !== null && !Array.isArray(output),
      describeRun(result)
    );
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`dist smoke failed: ${failures.length} check(s)`);
  process.exit(1);
}
console.log('dist smoke passed');
