import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const launcher = path.join(process.cwd(), '.claude-plugin', 'hook-launcher.cjs');

/** Stand-in hook: echoes its stdin so a test can see it ran and got the payload. */
const FAKE_HOOK = `let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ ran: __filename, input })); });
`;

function makeFakePackage(root: string): string {
  mkdirSync(path.join(root, 'dist', 'hooks'), { recursive: true });
  mkdirSync(path.join(root, 'dist', 'cli'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'claude-memory-layer' }));
  writeFileSync(path.join(root, 'dist', 'cli', 'index.js'), '');
  for (const hook of ['session-start', 'user-prompt-submit']) {
    writeFileSync(path.join(root, 'dist', 'hooks', `${hook}.js`), FAKE_HOOK);
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

function runLauncher(env: NodeJS.ProcessEnv, hook: string, input = '{"session_id":"s1"}') {
  return spawnSync(process.execPath, [launcher, hook], { env, input, encoding: 'utf8' });
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

    expect(JSON.parse(result.stdout).ran).toBe(path.join(packageRoot, 'dist', 'hooks', 'session-start.js'));
  });

  it('prefers the plugin root when it is itself a built package', () => {
    const { home, binDir, pluginRoot, env } = makeEnv('plugin-root');
    makeFakePackage(pluginRoot);
    installOnPath(binDir, makeFakePackage(path.join(home, 'global')));

    const result = runLauncher(env, 'session-start');

    expect(JSON.parse(result.stdout).ran).toBe(path.join(pluginRoot, 'dist', 'hooks', 'session-start.js'));
  });

  it('skips an event that `claude-memory-layer install` already registered in settings.json', () => {
    const { home, binDir, env } = makeEnv('dedupe');
    installOnPath(binDir, makeFakePackage(path.join(home, 'global')));
    writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: '',
          hooks: [{ type: 'command', command: "node '/usr/lib/node_modules/claude-memory-layer/dist/hooks/session-start.js'" }]
        }]
      }
    }));

    const skipped = runLauncher(env, 'session-start');
    const notRegistered = runLauncher(env, 'user-prompt-submit');

    expect(skipped.status).toBe(0);
    expect(skipped.stdout).toBe('');
    expect(JSON.parse(notRegistered.stdout).ran).toContain('user-prompt-submit.js');
  });

  it('does nothing for an unknown hook name', () => {
    const { home, binDir, env } = makeEnv('unknown');
    installOnPath(binDir, makeFakePackage(path.join(home, 'global')));

    const result = runLauncher(env, 'not-a-hook');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});
