// Hook cold-start breakdown. Runs each hook through the plugin launcher of
// an installed package with trace.cjs preloaded, as Claude Code would, and
// splits each run into phases (see README.md).
//
// node cold-start.mjs --pkg <package root with dist/> --work <dir> [--reps 15] [--warmup 2] [--label run]
//   [--hooks 'post-tool-use(stored),post-tool-use(skipped)']
// Env: CML_MODEL_SRC=<dir to copy as models/Xenova into the temp HOME> (no download),
//      CML_EXTRA_ENV='{"CLAUDE_MEMORY_SUMMARY_MODE":"rule"}' (extra env for every hook run).
// Writes <work>/rows-<label>.json and summary-<label>.json; <work> keeps its HOME
// and store between invocations, so rounds of one side share state.
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
const pkg = path.resolve(args.pkg);
const work = path.resolve(args.work);
const reps = Number(args.reps ?? 15);
const warmup = Number(args.warmup ?? 2);
const label = args.label ?? 'run';
const only = args.hooks ? new Set(args.hooks.split(',')) : null;
const launcher = path.join(pkg, '.claude-plugin', 'hook-launcher.cjs');

const home = path.join(work, 'home');
const proj = path.join(work, 'proj');
const traceOut = path.join(work, `trace-${label}.jsonl`);
const transcript = path.join(work, 'transcript.jsonl');
const preEditOn = path.join(work, 'operations-pre-edit-on.json');

if (!fs.existsSync(home)) {
  fs.mkdirSync(path.join(home, '.claude-code', 'memory', 'models'), { recursive: true });
  if (process.env.CML_MODEL_SRC) {
    fs.cpSync(process.env.CML_MODEL_SRC, path.join(home, '.claude-code', 'memory', 'models', 'Xenova'), { recursive: true });
  }
  fs.mkdirSync(proj, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: proj });
  fs.writeFileSync(path.join(proj, 'README.md'), '# bench project\n');
  fs.writeFileSync(preEditOn, JSON.stringify({ preEditCheck: { enabled: true } }));
}
fs.rmSync(traceOut, { force: true });

const baseEnv = {
  PATH: process.env.PATH,
  HOME: home,
  TMPDIR: path.join(work, 'tmp'),
  CLAUDE_PLUGIN_ROOT: pkg,
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
  CML_TRACE_OUT: traceOut,
  CML_TRACE_PKG: pkg,
  NODE_OPTIONS: `--require ${path.join(here, 'trace.cjs')}`,
  ...(process.env.CML_EXTRA_ENV ? JSON.parse(process.env.CML_EXTRA_ENV) : {})
};
fs.mkdirSync(baseEnv.TMPDIR, { recursive: true });

function run(hook, payload, extraEnv = {}) {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const child = spawn(process.execPath, [launcher, hook], { cwd: proj, env: { ...baseEnv, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ wallMs: Number(process.hrtime.bigint() - start) / 1e6, code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

function scenarios(i) {
  const sid = `bench-${label}-${i}-${Date.now()}`;
  fs.appendFileSync(transcript, `${JSON.stringify({ type: 'assistant', sessionId: sid, uuid: `u-${sid}`, message: { role: 'assistant', content: [{ type: 'text', text: `Iteration ${i}: the hook runtime reads stdin with a timeout and fails open on malformed input, so a broken payload never blocks the session.` }] } })}\n`);
  const editInput = { file_path: path.join(proj, 'README.md'), old_string: '# bench', new_string: `# bench ${i}` };
  return [
    ['session-start', 'session-start', { session_id: sid, cwd: proj, source: 'startup', hook_event_name: 'SessionStart' }],
    ['user-prompt-submit', 'user-prompt-submit', { session_id: sid, cwd: proj, prompt: `How does the hook runtime handle stdin timeouts and malformed payloads? (iteration ${i})`, hook_event_name: 'UserPromptSubmit' }],
    ['pre-tool-use(off)', 'pre-tool-use', { session_id: sid, cwd: proj, tool_name: 'Edit', tool_input: editInput, hook_event_name: 'PreToolUse' }],
    ['pre-tool-use(on)', 'pre-tool-use', { session_id: sid, cwd: proj, tool_name: 'Edit', tool_input: editInput, hook_event_name: 'PreToolUse' }, { CLAUDE_MEMORY_OPERATIONS_CONFIG_PATH: preEditOn }],
    ['post-tool-use(stored)', 'post-tool-use', { session_id: sid, cwd: proj, tool_name: 'Edit', tool_use_id: `t-${i}`, tool_input: editInput, tool_response: { content: `Edited README.md heading to bench ${i}` }, hook_event_name: 'PostToolUse' }],
    ['post-tool-use(skipped)', 'post-tool-use', { session_id: sid, cwd: proj, tool_name: 'Read', tool_use_id: `r-${i}`, tool_input: { file_path: path.join(proj, 'README.md') }, tool_response: { content: '# bench' }, hook_event_name: 'PostToolUse' }],
    ['pre-compact', 'pre-compact', { session_id: sid, cwd: proj, transcript_path: transcript, trigger: 'auto', hook_event_name: 'PreCompact' }],
    ['stop', 'stop', { session_id: sid, cwd: proj, transcript_path: transcript, permission_mode: 'default', stop_hook_active: false, hook_event_name: 'Stop' }],
    ['session-end', 'session-end', { session_id: sid, cwd: proj, transcript_path: transcript, reason: 'exit', hook_event_name: 'SessionEnd' }]
  ].filter(([name]) => !only || only.has(name));
}

const rows = [];
for (let i = 0; i < warmup + reps; i += 1) {
  for (const [name, hook, payload, extraEnv] of scenarios(i)) {
    const before = fs.existsSync(traceOut) ? fs.readFileSync(traceOut, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    const r = await run(hook, payload, extraEnv);
    const lines = fs.existsSync(traceOut) ? fs.readFileSync(traceOut, 'utf8').trim().split('\n').filter(Boolean) : [];
    const trace = lines.length > before ? JSON.parse(lines[lines.length - 1]) : null;
    rows.push({ iter: i, warm: i >= warmup, name, code: r.code, wallMs: r.wallMs, trace, stdoutLen: r.stdout.length, stderr: r.stderr.slice(0, 400) });
  }
}

function q(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[idx];
}
const summary = {};
for (const row of rows.filter((r) => r.warm)) {
  const t = row.trace;
  if (!t) continue;
  const load = (t.stdinAt ?? t.exitAt) - t.preloadEnd;
  const db = t.sqliteOpenMs + t.sqliteExecMs;
  const work = t.stdinAt === null ? 0 : t.exitAt - t.stdinAt - db - t.cpSyncMs;
  const s = summary[row.name] ??= { wall: [], boot: [], load: [], db: [], git: [], work: [], teardown: [], codes: new Set(), opens: [] };
  s.wall.push(row.wallMs);
  s.boot.push(t.preloadStart);
  s.load.push(load);
  s.db.push(db);
  s.git.push(t.cpSyncMs);
  s.work.push(work);
  s.teardown.push(row.wallMs - t.exitAt);
  s.codes.add(row.code);
  s.opens.push(t.sqliteOpens);
}
const table = Object.entries(summary).map(([name, s]) => ({
  hook: name,
  n: s.wall.length,
  codes: [...s.codes].join(','),
  sqliteOpens: q(s.opens, 0.5),
  ...Object.fromEntries(['wall', 'boot', 'load', 'db', 'git', 'work', 'teardown'].flatMap((k) => [[`${k}_p50`, +q(s[k], 0.5).toFixed(1)], [`${k}_p90`, +q(s[k], 0.9).toFixed(1)]]))
}));
fs.writeFileSync(path.join(work, `rows-${label}.json`), JSON.stringify(rows, null, 1));
fs.writeFileSync(path.join(work, `summary-${label}.json`), JSON.stringify(table, null, 1));
console.table(table.map((r) => ({ hook: r.hook, n: r.n, codes: r.codes, opens: r.sqliteOpens, wall: `${r.wall_p50}/${r.wall_p90}`, boot: `${r.boot_p50}/${r.boot_p90}`, load: `${r.load_p50}/${r.load_p90}`, db: `${r.db_p50}/${r.db_p90}`, sync_cp: `${r.git_p50}/${r.git_p90}`, work: `${r.work_p50}/${r.work_p90}`, exit: `${r.teardown_p50}/${r.teardown_p90}` })));
const errs = rows.filter((r) => r.code !== 0 || r.stderr);
if (errs.length) console.log('non-clean runs:', errs.slice(0, 5).map((r) => ({ name: r.name, iter: r.iter, code: r.code, stderr: r.stderr })));
