#!/usr/bin/env node
'use strict';

/**
 * Entry point for the hooks declared in .claude-plugin/hooks.json.
 *
 * A marketplace install is a git checkout: no dist/ (gitignored) and no
 * node_modules (the plugin installer never runs npm install), so the hooks
 * cannot run from the plugin directory itself. This launcher instead runs the
 * hook from a built claude-memory-layer package — the plugin root when it is
 * one, otherwise the npm-installed package — and exits 0 without running
 * anything when there is none, so a missing package never blocks a session.
 * PATH is the trust boundary here, as it already is for the `node` that every
 * hook command runs: the package is found through the `claude-memory-layer`
 * bin on it.
 *
 * It skips an event only when settings.json certainly runs the same hook
 * already (`claude-memory-layer install`). Anything less certain still runs:
 * the store drops a repeated event (dedupe key: session + content + type), so
 * a double run costs a second context injection, while a wrong skip loses the
 * capture. `claude-memory-layer doctor` reports the double registration.
 *
 * The hook is imported in this process rather than spawned: a child process
 * measured +28 ms per hook (median, Node 22, macOS) against +2 ms for the
 * import, and PostToolUse runs on every tool call.
 *
 * Usage:
 *   node hook-launcher.cjs <session-start|user-prompt-submit|post-tool-use|stop|session-end|pre-compact>
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PACKAGE_NAME = 'claude-memory-layer';

/** Hook file name -> Claude Code event, mirroring PLUGIN_HOOKS in src/apps/cli/claude-settings-hooks.ts. */
const HOOK_EVENTS = {
  'session-start': 'SessionStart',
  'user-prompt-submit': 'UserPromptSubmit',
  'post-tool-use': 'PostToolUse',
  stop: 'Stop',
  'session-end': 'SessionEnd',
  'pre-compact': 'PreCompact'
};

const MISSING_PACKAGE_NOTICE = `${PACKAGE_NAME}: npm package not found, memory hooks are inactive. `
  + `Install it with: npm install -g ${PACKAGE_NAME}`;

/** Same default and env override as the hook runtime's own watchdog (hook-runtime.ts). */
const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
/** Past the runtime watchdog plus its delivery-report grace, so it never cuts a working hook short. */
const CEILING_GRACE_MS = 2_000;

/** A hook that exits 2 blocks the prompt or tool call; a failing memory hook must not. */
const BLOCKING_EXIT_CODE = 2;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function isPackageRoot(dir) {
  const manifest = readJson(path.join(dir, 'package.json'));
  return Boolean(manifest && manifest.name === PACKAGE_NAME);
}

function packageRootOf(filePath) {
  let dir = path.dirname(filePath);
  while (true) {
    if (isPackageRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The script of `node <path>`, the only command shape `install` writes; null for anything else. */
function literalNodeScript(command) {
  const match = /^\s*(\S+)\s+(?:'([^']*)'|"([^"$`\\]*)"|([^\s'"$`\\;&|<>()]+))\s*$/.exec(command);
  if (!match || !/^node(?:\.exe)?$/.test(path.basename(match[1]))) return null;
  return match[2] ?? match[3] ?? match[4];
}

/** Matchers that let a settings.json hook fire on every occurrence of its event. */
function matchesEverything(matcher) {
  return matcher === undefined || matcher === '' || matcher === '*';
}

/**
 * True only when settings.json runs this package's hook file for every
 * occurrence of the event: a catch-all matcher, a plain `node <path>` command,
 * and a path that exists inside a claude-memory-layer package.
 */
function settingsRunsSameHook(settings, event, hookFile) {
  const entries = settings && settings.hooks && settings.hooks[event];
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => entry && matchesEverything(entry.matcher) && Array.isArray(entry.hooks)
    && entry.hooks.some((hook) => {
      const script = hook && hook.type === 'command' && typeof hook.command === 'string'
        ? literalNodeScript(hook.command)
        : null;
      if (!script || !path.isAbsolute(script)) return false;
      try {
        const target = fs.realpathSync(script);
        return path.basename(target) === `${hookFile}.js`
          && path.basename(path.dirname(target)) === 'hooks'
          && packageRootOf(target) !== null;
      } catch {
        return false;
      }
    }));
}

/**
 * The package behind a `claude-memory-layer` bin in one PATH directory. npm
 * links the bin into the package on POSIX; on Windows it writes shims
 * (`claude-memory-layer`, `.cmd`) next to `node_modules/` instead.
 */
function packageRootFromBinDir(dir) {
  const bin = ['', '.cmd'].map((ext) => path.join(dir, `${PACKAGE_NAME}${ext}`)).find((file) => fs.existsSync(file));
  if (!bin) return null;
  try {
    const linked = packageRootOf(fs.realpathSync(bin));
    if (linked) return linked;
  } catch {
    // unreadable bin; try the npm layouts below
  }
  return [
    path.join(dir, 'node_modules', PACKAGE_NAME),
    path.join(dir, '..', 'lib', 'node_modules', PACKAGE_NAME)
  ].find(isPackageRoot) || null;
}

/** The built hook file the launcher would run, or null when no package provides it. */
function resolveHookTarget(hookFile, { pluginRoot, pathEnv }) {
  const roots = [pluginRoot];
  for (const dir of (pathEnv || '').split(path.delimiter)) {
    if (dir) roots.push(packageRootFromBinDir(dir));
  }
  return roots
    .filter(Boolean)
    .map((root) => path.join(root, 'dist', 'hooks', `${hookFile}.js`))
    .find((candidate) => fs.existsSync(candidate)) || null;
}

function hookTimeoutMs() {
  const parsed = Number.parseInt(process.env.CLAUDE_MEMORY_HOOK_TIMEOUT_MS || '', 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_HOOK_TIMEOUT_MS;
}

function fail(message) {
  process.stderr.write(`${PACKAGE_NAME} hook launcher: ${message}\n`);
  // Non-blocking error, as when settings.json runs a hook that crashes.
  process.exitCode = 1;
}

async function main() {
  const hookFile = process.argv[2];
  const event = HOOK_EVENTS[hookFile];
  if (!event) return;

  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  if (settingsRunsSameHook(readJson(path.join(configDir, 'settings.json')), event, hookFile)) return;

  const target = resolveHookTarget(hookFile, { pluginRoot: process.env.CLAUDE_PLUGIN_ROOT, pathEnv: process.env.PATH });
  if (!target) {
    // Once per session is enough; SessionStart shows systemMessage to the user.
    if (event === 'SessionStart') process.stdout.write(`${JSON.stringify({ systemMessage: MISSING_PACKAGE_NOTICE })}\n`);
    return;
  }

  process.on('exit', () => {
    if (process.exitCode === BLOCKING_EXIT_CODE) process.exitCode = 1;
  });
  // The runtime watchdog bounds the hook once it runs; this bounds a hook that
  // stalls before installing it (e.g. while loading). Unref'd, so it never
  // keeps a finished hook alive.
  setTimeout(() => {
    fail(`${hookFile} did not finish within ${hookTimeoutMs() + CEILING_GRACE_MS} ms`);
    process.exit();
  }, hookTimeoutMs() + CEILING_GRACE_MS).unref();

  // The built hooks run on import and read stdin themselves.
  await import(pathToFileURL(target).href);
}

module.exports = { HOOK_EVENTS, resolveHookTarget };

if (require.main === module) {
  main().catch((error) => fail(error && error.message ? error.message : String(error)));
}
