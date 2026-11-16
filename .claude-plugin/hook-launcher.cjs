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
 *
 * It also defers to hooks that `claude-memory-layer install` wrote into
 * settings.json: both would fire on every event and capture and inject twice.
 *
 * Usage:
 *   node hook-launcher.cjs <session-start|user-prompt-submit|post-tool-use|stop|session-end>
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
  'session-end': 'SessionEnd'
};

const MISSING_PACKAGE_NOTICE = `${PACKAGE_NAME}: npm package not found, memory hooks are inactive. `
  + `Install it with: npm install -g ${PACKAGE_NAME}`;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Same rule as isPluginHookCommand() without a plugin path: the command names
 * this package and runs its hook file.
 */
function settingsRegistersHook(settings, event, hookFile) {
  const entries = settings && settings.hooks && settings.hooks[event];
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => (entry && Array.isArray(entry.hooks) ? entry.hooks : []).some((hook) => {
    const command = typeof hook.command === 'string' ? hook.command.replace(/\\/g, '/') : '';
    return command.includes(PACKAGE_NAME) && command.includes(`/hooks/${hookFile}.js`);
  }));
}

function packageRootOf(filePath) {
  let dir = path.dirname(filePath);
  while (true) {
    const manifest = readJson(path.join(dir, 'package.json'));
    if (manifest && manifest.name === PACKAGE_NAME) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The package the `claude-memory-layer` bin on PATH belongs to. */
function packageRootFromPath() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      const root = packageRootOf(fs.realpathSync(path.join(dir, PACKAGE_NAME)));
      if (root) return root;
    } catch {
      // not on this PATH entry
    }
  }
  return null;
}

function hookCandidates(hookFile) {
  return [process.env.CLAUDE_PLUGIN_ROOT, packageRootFromPath()]
    .filter(Boolean)
    .map((root) => path.join(root, 'dist', 'hooks', `${hookFile}.js`));
}

async function main() {
  const hookFile = process.argv[2];
  const event = HOOK_EVENTS[hookFile];
  if (!event) return;

  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  if (settingsRegistersHook(readJson(path.join(configDir, 'settings.json')), event, hookFile)) return;

  const target = hookCandidates(hookFile).find((candidate) => fs.existsSync(candidate));
  if (!target) {
    // Once per session is enough; SessionStart shows systemMessage to the user.
    if (event === 'SessionStart') process.stdout.write(`${JSON.stringify({ systemMessage: MISSING_PACKAGE_NOTICE })}\n`);
    return;
  }
  // The built hooks run on import and read stdin themselves.
  await import(pathToFileURL(target).href);
}

module.exports = { HOOK_EVENTS };

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${PACKAGE_NAME} hook launcher: ${error && error.message ? error.message : error}\n`);
  });
}
