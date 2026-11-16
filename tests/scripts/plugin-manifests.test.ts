import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CLAUDE_PLUGIN_NAME, PLUGIN_HOOK_MATCHERS, PLUGIN_HOOKS, REQUIRED_HOOK_FILES } from '../../src/apps/cli/claude-settings-hooks.js';

const repoRoot = process.cwd();

function readJson<T = Record<string, unknown>>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8')) as T;
}

type HookConfig = { hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>> };

const pkg = readJson<{ version: string }>('package.json');
const plugin = readJson<{ name: string; version: string; repository: unknown; hooks: string; commands?: string }>(
  '.claude-plugin/plugin.json'
);
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
      // Same matcher as install writes, so the launcher can tell an install covers it.
      expect(hooks[event].map((entry) => entry.matcher), event).toEqual([PLUGIN_HOOK_MATCHERS[event as keyof typeof PLUGIN_HOOKS] ?? '']);
      // scripts/build.ts builds dist/hooks/<name>.js from src/hooks/<name>.ts.
      expect(existsSync(path.join(repoRoot, 'src', 'hooks', `${hookName}.ts`)), hookName).toBe(true);
    }
  });

  it('points plugin.json at the slash command files, which Claude Code does not look for inside .claude-plugin/', () => {
    // Without the field only <plugin root>/commands/ is read, so these were never loaded.
    expect(plugin.commands).toBe('./.claude-plugin/commands/');
    expect(readdirSync(path.join(repoRoot, plugin.commands!)).filter((file) => file.endsWith('.md'))).not.toEqual([]);
  });

  it('runs every slash command through the claude-memory-layer bin with a top-level CLI subcommand', () => {
    // The command runs in the user's project, and a marketplace install has no dist/,
    // so the CLI is reached the way hook-launcher.cjs finds it: the bin on PATH.
    const cliSource = readFileSync(path.join(repoRoot, 'src', 'apps', 'cli', 'index.ts'), 'utf8');
    const subcommands = new Set([...cliSource.matchAll(/^program\n {2}\.command\('([\w-]+)/gm)].map((match) => match[1]));
    const commandsDir = path.join(repoRoot, plugin.commands ?? '.claude-plugin/commands');

    for (const file of readdirSync(commandsDir).filter((name) => name.endsWith('.md'))) {
      const body = readFileSync(path.join(commandsDir, file), 'utf8');
      const invocations = [...body.matchAll(/^```bash\n(.+)\n```$/gm)].map((match) => match[1]);
      expect(invocations, file).toHaveLength(1);
      const [bin, subcommand] = invocations[0].split(' ');
      expect(bin, file).toBe('claude-memory-layer');
      expect(subcommands, file).toContain(subcommand);
    }
  });

  it('gives the launcher the same hook-to-event map and matchers that install writes', () => {
    const { HOOK_EVENTS, HOOK_MATCHERS } = createRequire(import.meta.url)('../../.claude-plugin/hook-launcher.cjs') as {
      HOOK_EVENTS: Record<string, string>;
      HOOK_MATCHERS: Record<string, string>;
    };
    expect(HOOK_EVENTS).toEqual(Object.fromEntries(
      Object.entries(PLUGIN_HOOKS).map(([event, fileName]) => [fileName.replace(/\.js$/, ''), event])
    ));
    expect(HOOK_MATCHERS).toEqual(Object.fromEntries(
      Object.entries(PLUGIN_HOOK_MATCHERS).map(([event, matcher]) => [
        PLUGIN_HOOKS[event as keyof typeof PLUGIN_HOOKS].replace(/\.js$/, ''),
        matcher
      ])
    ));
  });

  it('has doctor require every file the launcher requires next to a hook', () => {
    const { HOOK_COMPANIONS } = createRequire(import.meta.url)('../../.claude-plugin/hook-launcher.cjs') as {
      HOOK_COMPANIONS: Record<string, string[]>;
    };
    for (const [hook, companions] of Object.entries(HOOK_COMPANIONS)) {
      expect(REQUIRED_HOOK_FILES, hook).toEqual(expect.arrayContaining([`${hook}.js`, ...companions]));
    }
  });
});
