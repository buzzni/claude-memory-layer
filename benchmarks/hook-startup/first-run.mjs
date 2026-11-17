// First-run behaviour of an installed package, e.g. one with a dependency
// removed (see README.md): two sessions through the plugin launcher in a
// fresh temp HOME, then `search`, `status` and `doctor`.
// node first-run.mjs --prefix <npm -g prefix> --work <fresh dir> [--models <dir to copy as models/Xenova>] [--settle 6000]
// <work> is deleted first. Prints each step's exit code, stdout and stderr, and the memory root's files.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
const prefix = path.resolve(args.prefix);
const work = path.resolve(args.work);
const pkg = path.join(prefix, 'lib', 'node_modules', 'claude-memory-layer');
const bin = path.join(prefix, 'bin');
const home = path.join(work, 'home');
const proj = path.join(work, 'proj');
const transcript = path.join(work, 'transcript.jsonl');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(path.join(home, '.claude-code', 'memory'), { recursive: true });
if (args.models) fs.cpSync(args.models, path.join(home, '.claude-code', 'memory', 'models', 'Xenova'), { recursive: true });
fs.mkdirSync(proj, { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: proj });

const env = {
  PATH: `${bin}:${process.env.PATH}`,
  HOME: home,
  TMPDIR: path.join(work, 'tmp'),
  CLAUDE_PLUGIN_ROOT: pkg,
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
  CLAUDE_MEMORY_SUMMARY_MODE: 'rule'
};
fs.mkdirSync(env.TMPDIR, { recursive: true });

const launcher = path.join(pkg, '.claude-plugin', 'hook-launcher.cjs');
function hook(name, payload) {
  return new Promise((resolve) => {
    const t = Date.now();
    const child = spawn(process.execPath, [launcher, name], { cwd: proj, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ name, code, ms: Date.now() - t, out: out.trim(), err: err.trim() }));
    child.stdin.end(JSON.stringify(payload));
  });
}
function cli(...cliArgs) {
  const r = spawnSync(path.join(bin, 'claude-memory-layer'), cliArgs, { cwd: proj, env, encoding: 'utf8', timeout: 120000 });
  return { cmd: cliArgs.join(' '), code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function clip(s, n = 700) {
  return s.length > n ? `${s.slice(0, n)}…(+${s.length - n})` : s;
}

const log = [];
const record = (r) => { log.push(r); console.log(`\n### ${r.name ?? r.cmd} code=${r.code}${r.ms !== undefined ? ` ${r.ms}ms` : ''}\nstdout: ${clip(r.out)}\nstderr: ${clip(r.err)}`); };

record(cli('--version'));
const s1 = `fr-a-${Date.now()}`;
record(await hook('session-start', { session_id: s1, cwd: proj, source: 'startup', hook_event_name: 'SessionStart' }));
record(await hook('user-prompt-submit', { session_id: s1, cwd: proj, prompt: 'Decision: this monorepo uses pnpm workspaces for every build; never run yarn here because the lockfile is pnpm-lock.yaml.', hook_event_name: 'UserPromptSubmit' }));
record(await hook('post-tool-use', { session_id: s1, cwd: proj, tool_name: 'Edit', tool_use_id: 't1', tool_input: { file_path: path.join(proj, 'package.json'), old_string: '"yarn"', new_string: '"pnpm"' }, tool_response: { content: 'Switched packageManager to pnpm in package.json' }, hook_event_name: 'PostToolUse' }));
fs.appendFileSync(transcript, `${JSON.stringify({ type: 'assistant', sessionId: s1, uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'I switched the monorepo to pnpm workspaces and removed the yarn lockfile; builds now run with pnpm -r build.' }] } })}\n`);
record(await hook('stop', { session_id: s1, cwd: proj, transcript_path: transcript, permission_mode: 'default', stop_hook_active: false, hook_event_name: 'Stop' }));
record(await hook('session-end', { session_id: s1, cwd: proj, transcript_path: transcript, reason: 'exit', hook_event_name: 'SessionEnd' }));
await sleep(Number(args.settle ?? 6000));

const s2 = `fr-b-${Date.now()}`;
record(await hook('session-start', { session_id: s2, cwd: proj, source: 'startup', hook_event_name: 'SessionStart' }));
record(await hook('user-prompt-submit', { session_id: s2, cwd: proj, prompt: 'Which package manager does this monorepo use for builds, pnpm or yarn?', hook_event_name: 'UserPromptSubmit' }));
record(cli('search', 'pnpm workspaces'));
record(cli('status'));
record(cli('doctor'));

const pendingDir = path.join(home, '.claude-code', 'memory');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'models') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else files.push(path.relative(pendingDir, p));
  }
})(pendingDir);
console.log('\n### memory root files\n' + files.sort().join('\n'));
fs.writeFileSync(path.join(work, 'log.json'), JSON.stringify(log, null, 1));
