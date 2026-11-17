import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { commonOptions, HOOK_ENTRIES } from '../../scripts/build.js';

/**
 * The hook bundles as scripts/build.ts makes them: what each loads before
 * its hook runs, and whether capture and keyword recall run when the native
 * vector and embedding backends cannot load. A module loaded with import()
 * inside a function is not in the load lists; the source-level rule in
 * scripts/check-import-boundaries.mjs keeps import() out of module scope.
 */

const repoRoot = process.cwd();
const NATIVE_BACKENDS = ['@lancedb/lancedb', '@huggingface/transformers', '@xenova/transformers'];
/** Entries that run on every edit or tool call and often stop before storing anything. */
const LIGHT_ENTRIES = ['pre-tool-use', 'post-tool-use'];
const LOAD_KINDS = new Set(['import-statement', 'require-call']);

let root: string;
let pkg: string;
let loads: Map<string, string[]>;
let bundledInputs: Map<string, string[]>;

/**
 * A package root holding the built hooks, whose node_modules links every
 * dependency of this checkout except the native backends, which are
 * replaced by packages that throw when loaded.
 */
function makePackage(): string {
  const dir = path.join(root, 'pkg');
  const modules = path.join(dir, 'node_modules');
  mkdirSync(modules, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cml-hook-bundle-test', type: 'module' }));
  const brokenScopes = new Set(NATIVE_BACKENDS.map((name) => name.split('/')[0]));
  for (const entry of readdirSync(path.join(repoRoot, 'node_modules'))) {
    if (!brokenScopes.has(entry)) symlinkSync(path.join(repoRoot, 'node_modules', entry), path.join(modules, entry));
  }
  for (const name of NATIVE_BACKENDS) {
    const stub = path.join(modules, name);
    mkdirSync(stub, { recursive: true });
    writeFileSync(path.join(stub, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
    writeFileSync(path.join(stub, 'index.js'), `throw new Error("Cannot find module '${name}-test-platform'");\n`);
  }
  mkdirSync(path.join(dir, '.claude-plugin'));
  cpSync(path.join(repoRoot, '.claude-plugin', 'hook-launcher.cjs'), path.join(dir, '.claude-plugin', 'hook-launcher.cjs'));
  return dir;
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'cml-hook-bundles-'));
  pkg = makePackage();
  const result = await esbuild.build({
    ...commonOptions,
    entryPoints: HOOK_ENTRIES.map((name) => path.join(repoRoot, 'src', 'hooks', `${name}.ts`)),
    outdir: path.join(pkg, 'dist', 'hooks'),
    sourcemap: false,
    metafile: true,
    logLevel: 'silent'
  });
  loads = new Map();
  bundledInputs = new Map();
  for (const output of Object.values(result.metafile.outputs)) {
    if (!output.entryPoint) continue;
    const name = path.basename(output.entryPoint, '.ts');
    loads.set(name, output.imports.filter((ref) => LOAD_KINDS.has(ref.kind)).map((ref) => ref.path));
    bundledInputs.set(name, Object.keys(output.inputs));
  }
}, 120_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('hook entry bundles', () => {
  it('load no native vector or embedding backend before the hook runs', () => {
    expect([...loads.keys()].sort()).toEqual([...HOOK_ENTRIES].sort());
    for (const [name, specifiers] of loads) {
      expect(specifiers.filter((specifier) => NATIVE_BACKENDS.some((pkgName) => specifier === pkgName || specifier.startsWith(`${pkgName}/`))), name)
        .toEqual([]);
    }
  });

  it.each(LIGHT_ENTRIES)('%s loads neither SQLite, zod nor the memory service before deciding to store', (name) => {
    expect(loads.get(name)!.filter((specifier) => specifier === 'better-sqlite3' || specifier === 'zod' || specifier.startsWith('zod/')))
      .toEqual([]);
    expect(bundledInputs.get(name)!.filter((input) => input.includes('services/memory-service'))).toEqual([]);
  });
});

describe('built Claude hooks with the native backends unloadable', () => {
  let home: string;
  let project: string;
  let transcript: string;

  beforeAll(() => {
    home = path.join(root, 'home');
    project = path.join(root, 'project');
    transcript = path.join(root, 'transcript.jsonl');
    mkdirSync(path.join(home, '.claude-code', 'memory'), { recursive: true });
    mkdirSync(project);
    writeFileSync(path.join(root, 'pre-edit-on.json'), JSON.stringify({ preEditCheck: { enabled: true } }));
    // No daemon here: hooks that ask for one find no script and drop the semantic lane.
    rmSync(path.join(pkg, 'dist', 'hooks', 'semantic-daemon.js'));
  });

  function runHook(hook: string, input: Record<string, unknown>, env: Record<string, string> = {}) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [path.join(pkg, '.claude-plugin', 'hook-launcher.cjs'), hook], {
        cwd: project,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          CLAUDE_PLUGIN_ROOT: pkg,
          CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
          CLAUDE_MEMORY_SUMMARY_MODE: 'rule',
          CLAUDE_MEMORY_SEMANTIC_SOCKET: path.join(root, 'semantic.sock'),
          ...env
        }
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify({ cwd: project, ...input }));
    });
  }

  function storedTypes(): string[] {
    const stores: string[] = [];
    (function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === 'events.sqlite') stores.push(full);
      }
    })(path.join(home, '.claude-code', 'memory'));
    return stores.flatMap((store) => {
      const db = new Database(store, { readonly: true });
      try {
        return (db.prepare('SELECT event_type FROM events').all() as Array<{ event_type: string }>).map((row) => row.event_type);
      } finally {
        db.close();
      }
    });
  }

  async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return check();
  }

  it('run all seven hooks, store the session and recall it by keyword in the next one', async () => {
    const answer = 'The monorepo builds with pnpm workspaces; the yarn lockfile was removed.';
    const edit = { file_path: path.join(project, 'package.json'), old_string: 'yarn', new_string: 'pnpm' };
    const runs = [
      await runHook('session-start', { session_id: 'first', source: 'startup' }),
      await runHook('user-prompt-submit', { session_id: 'first', prompt: 'Should this monorepo build with pnpm workspaces or yarn?' }),
      await runHook('pre-tool-use', { session_id: 'first', tool_name: 'Edit', tool_input: edit }, { CLAUDE_MEMORY_OPERATIONS_CONFIG_PATH: path.join(root, 'pre-edit-on.json') }),
      await runHook('post-tool-use', { session_id: 'first', tool_name: 'Edit', tool_use_id: 'toolu_1', tool_input: edit, tool_response: { content: 'Switched packageManager to pnpm' } }),
      await runHook('pre-compact', { session_id: 'first', transcript_path: transcript, trigger: 'auto' })
    ];
    writeFileSync(transcript, `${JSON.stringify({
      type: 'assistant',
      sessionId: 'first',
      uuid: 'assistant-1',
      message: { role: 'assistant', content: [{ type: 'text', text: answer }] }
    })}\n`);
    runs.push(await runHook('stop', { session_id: 'first', transcript_path: transcript, permission_mode: 'default', stop_hook_active: false }));
    runs.push(await runHook('session-end', { session_id: 'first', transcript_path: transcript, reason: 'exit' }));

    expect(runs.map((run) => run.code)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(runs.map((run) => run.stderr).join('')).not.toContain('Cannot find module');
    expect(await waitFor(() => storedTypes().includes('session_summary'), 15_000)).toBe(true);
    expect(storedTypes()).toEqual(expect.arrayContaining(['user_prompt', 'tool_observation', 'agent_response', 'session_summary']));

    const next = await runHook('session-start', { session_id: 'second', source: 'startup' });
    expect(next.code).toBe(0);
    expect(JSON.parse(next.stdout).hookSpecificOutput.additionalContext).toContain(answer);
    expect(existsSync(path.join(pkg, 'dist', 'hooks', 'post-tool-use-handler.js'))).toBe(true);
  }, 60_000);
});
