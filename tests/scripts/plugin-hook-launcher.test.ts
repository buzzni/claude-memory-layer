import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const launcher = path.join(process.cwd(), '.claude-plugin', 'hook-launcher.cjs');
const { HOOK_EVENTS } = createRequire(import.meta.url)(launcher) as { HOOK_EVENTS: Record<string, string> };
const HOOK_FILES = Object.keys(HOOK_EVENTS);

/** Stand-in hook: echoes its stdin so a test can see it ran and got the payload. */
const FAKE_HOOK = `let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ ran: __filename, input })); });
`;

function makeFakePackage(root: string, hookSource = FAKE_HOOK): string {
  mkdirSync(path.join(root, 'dist', 'hooks'), { recursive: true });
  mkdirSync(path.join(root, 'dist', 'cli'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'claude-memory-layer' }));
  writeFileSync(path.join(root, 'dist', 'cli', 'index.js'), '');
  for (const hook of HOOK_FILES) {
    writeFileSync(path.join(root, 'dist', 'hooks', `${hook}.js`), hookSource);
  }
  return root;
}

/** A temp HOME with an empty plugin checkout (no dist/) and an empty PATH. */
function makeEnv(name: string) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), `cml-hook-launcher-${name}-`)));
  const pluginRoot = path.join(home, 'plugin-checkout');
  const binDir = path.join(home, 'bin');
  mkdirSync(pluginRoot);
  mkdirSync(binDir);
  mkdirSync(path.join(home, '.claude'));
  return {
    home,
    pluginRoot,
    binDir,
    env: {
      HOME: home,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      PATH: binDir
    } as NodeJS.ProcessEnv
  };
}

/** npm's global layout: <prefix>/bin/claude-memory-layer -> <package>/dist/cli/index.js */
function installOnPath(binDir: string, packageRoot: string): void {
  symlinkSync(path.join(packageRoot, 'dist', 'cli', 'index.js'), path.join(binDir, 'claude-memory-layer'));
}

function writeSettingsHook(home: string, event: string, hook: { matcher?: string; command: string }): void {
  writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    hooks: { [event]: [{ matcher: hook.matcher ?? '', hooks: [{ type: 'command', command: hook.command }] }] }
  }));
}

function runLauncher(env: NodeJS.ProcessEnv, hook: string, input = '{"session_id":"s1"}') {
  return spawnSync(process.execPath, [launcher, hook], { env, input, encoding: 'utf8' });
}

function ranHook(result: ReturnType<typeof runLauncher>): string | undefined {
  return result.stdout ? (JSON.parse(result.stdout) as { ran?: string }).ran : undefined;
}

describe('plugin hook launcher', () => {
  it('exits 0 and tells the user once, at SessionStart, when no package is installed', () => {
    const { env } = makeEnv('missing');

    const sessionStart = runLauncher(env, 'session-start');
    const prompt = runLauncher(env, 'user-prompt-submit');

    expect(sessionStart.status).toBe(0);
    expect(JSON.parse(sessionStart.stdout).systemMessage).toContain('npm install -g claude-memory-layer');
    expect(prompt.status).toBe(0);
    expect(prompt.stdout).toBe('');
  });

  it('runs the hook of the package whose bin is on PATH, passing stdin through', () => {
    const { home, binDir, env } = makeEnv('path');
    const packageRoot = makeFakePackage(path.join(home, 'lib', 'node_modules', 'claude-memory-layer'));
    installOnPath(binDir, packageRoot);

    const result = runLauncher(env, 'user-prompt-submit', '{"prompt":"hi"}');

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ran: path.join(packageRoot, 'dist', 'hooks', 'user-prompt-submit.js'),
      input: '{"prompt":"hi"}'
    });
  });

  it('keeps searching PATH past a claude-memory-layer that is not the package, such as a wrapper script', () => {
    const { home, binDir, env } = makeEnv('wrapper');
    const wrapperDir = path.join(home, 'wrapper-bin');
    mkdirSync(wrapperDir);
    writeFileSync(path.join(wrapperDir, 'claude-memory-layer'), '#!/bin/sh\n');
    const packageRoot = makeFakePackage(path.join(home, 'global'));
    installOnPath(binDir, packageRoot);

    const result = runLauncher({ ...env, PATH: [wrapperDir, binDir].join(path.delimiter) }, 'session-start');

    expect(ranHook(result)).toBe(path.join(packageRoot, 'dist', 'hooks', 'session-start.js'));
  });

  it('finds a Windows npm install from its .cmd shim next to node_modules', () => {
    const { home, env } = makeEnv('windows-shim');
    const prefix = path.join(home, 'AppData', 'Roaming', 'npm');
    const packageRoot = makeFakePackage(path.join(prefix, 'node_modules', 'claude-memory-layer'));
    writeFileSync(path.join(prefix, 'claude-memory-layer.cmd'), '@ECHO off\r\n');

    const result = runLauncher({ ...env, PATH: prefix }, 'stop');

    expect(ranHook(result)).toBe(path.join(packageRoot, 'dist', 'hooks', 'stop.js'));
  });

  it('finds a POSIX npm install whose bin is a copied shim rather than a symlink', () => {
    const { home, env } = makeEnv('posix-shim');
    const prefix = path.join(home, 'prefix');
    const packageRoot = makeFakePackage(path.join(prefix, 'lib', 'node_modules', 'claude-memory-layer'));
    mkdirSync(path.join(prefix, 'bin'));
    writeFileSync(path.join(prefix, 'bin', 'claude-memory-layer'), '#!/bin/sh\n');

    const result = runLauncher({ ...env, PATH: path.join(prefix, 'bin') }, 'stop');

    expect(ranHook(result)).toBe(path.join(packageRoot, 'dist', 'hooks', 'stop.js'));
  });

  it('prefers the plugin root when it is itself a built package', () => {
    const { home, binDir, pluginRoot, env } = makeEnv('plugin-root');
    makeFakePackage(pluginRoot);
    installOnPath(binDir, makeFakePackage(path.join(home, 'global')));

    const result = runLauncher(env, 'session-start');

    expect(ranHook(result)).toBe(path.join(pluginRoot, 'dist', 'hooks', 'session-start.js'));
  });

  it.each(HOOK_FILES)('skips %s when `claude-memory-layer install` already runs that hook from settings.json', (hookFile) => {
    const { home, binDir, env } = makeEnv(`dedupe-${hookFile}`);
    const packageRoot = makeFakePackage(path.join(home, 'lib', 'node_modules', 'claude-memory-layer'));
    installOnPath(binDir, packageRoot);
    writeSettingsHook(home, HOOK_EVENTS[hookFile], {
      command: `node '${path.join(packageRoot, 'dist', 'hooks', `${hookFile}.js`)}'`
    });

    const skipped = runLauncher(env, hookFile);
    const otherHook = HOOK_FILES.find((file) => file !== hookFile)!;

    expect(skipped.status).toBe(0);
    expect(skipped.stdout).toBe('');
    expect(ranHook(runLauncher(env, otherHook))).toContain(`${otherHook}.js`);
  });

  it.each([
    ['a matcher that covers only some tools', { matcher: 'Bash', command: (hook: string) => `node '${hook}'` }],
    ['a registration whose hook file is gone', { command: () => "node '/gone/claude-memory-layer/dist/hooks/post-tool-use.js'" }],
    ['a command that is not a plain node invocation', { command: (hook: string) => `echo '${hook}'` }],
    ['a wrapped node invocation', { command: (hook: string) => `env FOO=1 node '${hook}'` }]
  ])('still runs when settings.json has %s', (_label, settingsHook) => {
    const { home, binDir, env } = makeEnv('uncertain');
    const packageRoot = makeFakePackage(path.join(home, 'lib', 'node_modules', 'claude-memory-layer'));
    installOnPath(binDir, packageRoot);
    const hookPath = path.join(packageRoot, 'dist', 'hooks', 'post-tool-use.js');
    writeSettingsHook(home, 'PostToolUse', { matcher: settingsHook.matcher, command: settingsHook.command(hookPath) });

    expect(ranHook(runLauncher(env, 'post-tool-use'))).toBe(hookPath);
  });

  it('turns a hook exit code of 2, which would block the prompt, into a non-blocking 1', () => {
    const { home, binDir, env } = makeEnv('exit-2');
    installOnPath(binDir, makeFakePackage(path.join(home, 'global'), 'process.exit(2);\n'));

    expect(runLauncher(env, 'user-prompt-submit').status).toBe(1);
  });

  it('reports a hook that fails to load as a non-blocking error', () => {
    const { home, binDir, env } = makeEnv('load-error');
    installOnPath(binDir, makeFakePackage(path.join(home, 'global'), "throw new Error('native binding missing');\n"));

    const result = runLauncher(env, 'user-prompt-submit');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('native binding missing');
  });

  it('ends a hook that stalls before the runtime watchdog can stop it', () => {
    const { home, binDir, env } = makeEnv('stall');
    installOnPath(binDir, makeFakePackage(path.join(home, 'global'), 'setInterval(() => {}, 1000);\n'));

    const started = Date.now();
    const result = runLauncher({ ...env, CLAUDE_MEMORY_HOOK_TIMEOUT_MS: '100' }, 'user-prompt-submit');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('did not finish within 2100 ms');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('does nothing for an unknown hook name', () => {
    const { home, binDir, env } = makeEnv('unknown');
    installOnPath(binDir, makeFakePackage(path.join(home, 'global')));

    const result = runLauncher(env, 'not-a-hook');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});
