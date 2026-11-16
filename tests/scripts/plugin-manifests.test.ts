import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CLAUDE_PLUGIN_NAME, PLUGIN_HOOKS } from '../../src/apps/cli/claude-settings-hooks.js';

const repoRoot = process.cwd();

function readJson<T = Record<string, unknown>>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8')) as T;
}

type HookConfig = { hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>> };

const pkg = readJson<{ version: string }>('package.json');
const plugin = readJson<{ name: string; version: string; repository: unknown; hooks: string }>('.claude-plugin/plugin.json');
const marketplace = readJson<{
  name: string;
  owner: { name: string };
  plugins: Array<{ name: string; source: string; version: string }>;
}>('.claude-plugin/marketplace.json');

/**
 * Mirrors `claude plugin validate`, which CI cannot run (no claude binary):
 * the rules here are the ones it rejected or warned on for this repository.
 */
describe('Claude Code plugin manifests', () => {
  it('lists this repository root as the marketplace plugin', () => {
    expect(marketplace.name).toBeTruthy();
    expect(marketplace.owner.name).toBeTruthy();
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: plugin.name, source: './', version: pkg.version })
    ]);
  });

  it('uses a plugin name Claude Code does not reserve, matching what doctor looks for', () => {
    expect(plugin.name).not.toMatch(/^(claude|anthropic|anthropics|cc-plugin)-/);
    expect(plugin.name).toBe(CLAUDE_PLUGIN_NAME);
  });

  it('declares the version from package.json and a string repository', () => {
    expect(plugin.version).toBe(pkg.version);
    expect(typeof plugin.repository).toBe('string');
  });

  it('points plugin.json at a hooks file inside the plugin', () => {
    expect(plugin.hooks).toMatch(/^\.\//);
    expect(existsSync(path.join(repoRoot, plugin.hooks))).toBe(true);
  });

  it('routes every hook event through the launcher to a hook the build produces', () => {
    const { hooks } = readJson<HookConfig>(plugin.hooks);
    expect(Object.keys(hooks).sort()).toEqual(Object.keys(PLUGIN_HOOKS).sort());

    for (const [event, fileName] of Object.entries(PLUGIN_HOOKS)) {
      const commands = hooks[event].flatMap((entry) => entry.hooks.map((hook) => hook.command));
      const hookName = fileName.replace(/\.js$/, '');
      expect(commands).toEqual([`node "\${CLAUDE_PLUGIN_ROOT}/.claude-plugin/hook-launcher.cjs" ${hookName}`]);
      // scripts/build.ts builds dist/hooks/<name>.js from src/hooks/<name>.ts.
      expect(existsSync(path.join(repoRoot, 'src', 'hooks', `${hookName}.ts`)), hookName).toBe(true);
    }
  });

  it('gives the launcher the same hook-to-event map that install writes', () => {
    const { HOOK_EVENTS } = createRequire(import.meta.url)('../../.claude-plugin/hook-launcher.cjs') as {
      HOOK_EVENTS: Record<string, string>;
    };
    expect(HOOK_EVENTS).toEqual(Object.fromEntries(
      Object.entries(PLUGIN_HOOKS).map(([event, fileName]) => [fileName.replace(/\.js$/, ''), event])
    ));
  });
});
