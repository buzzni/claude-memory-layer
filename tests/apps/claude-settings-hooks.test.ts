import { describe, expect, it } from 'vitest';

import {
  buildHookCommand,
  getHooksConfig,
  inspectPluginHookTargets,
  mergePluginHooksIntoSettings,
  removePluginHooksFromSettings,
  type ClaudeSettingsWithHooks
} from '../../src/apps/cli/claude-settings-hooks.js';

describe('Claude Code hook settings helpers', () => {
  it('quotes hook paths so plugin installs work when the path contains spaces', () => {
    expect(buildHookCommand('/tmp/project with spaces/dist', 'user-prompt-submit.js'))
      .toBe("node '/tmp/project with spaces/dist/hooks/user-prompt-submit.js'");

    const complexCommand = buildHookCommand("/tmp/project with $dollars 'quotes' and `ticks`/dist", 'stop.js');
    expect(complexCommand).toContain("'\\''quotes'\\''");
    expect(complexCommand).toContain('$dollars');
    expect(complexCommand).toContain('`ticks`');

    expect(getHooksConfig('/tmp/project with spaces/dist').UserPromptSubmit?.[0].hooks[0].command)
      .toBe("node '/tmp/project with spaces/dist/hooks/user-prompt-submit.js'");
  });

  it('merges plugin hooks without replacing unrelated hooks in the same categories', () => {
    const settings: ClaudeSettingsWithHooks = {
      theme: 'dark',
      hooks: {
        UserPromptSubmit: [
          {
            matcher: 'existing',
            hooks: [{ type: 'command', command: 'node /other/plugin.js' }]
          }
        ],
        Stop: [
          {
            matcher: 'old-plugin',
            hooks: [{ type: 'command', command: 'node /old/claude-memory-layer/dist/hooks/stop.js' }]
          }
        ]
      }
    };

    const merged = mergePluginHooksIntoSettings(settings, '/new/plugin dist');

    expect(merged.theme).toBe('dark');
    expect(merged.hooks?.UserPromptSubmit).toEqual([
      {
        matcher: 'existing',
        hooks: [{ type: 'command', command: 'node /other/plugin.js' }]
      },
      {
        matcher: '',
        hooks: [{ type: 'command', command: "node '/new/plugin dist/hooks/user-prompt-submit.js'" }]
      }
    ]);
    expect(merged.hooks?.Stop).toEqual([
      {
        matcher: '',
        hooks: [{ type: 'command', command: "node '/new/plugin dist/hooks/stop.js'" }]
      }
    ]);
  });

  it('uninstall removes only claude-memory-layer hook commands and leaves other hooks intact', () => {
    const settings: ClaudeSettingsWithHooks = {
      hooks: {
        SessionStart: [
          {
            matcher: 'keep-and-remove',
            hooks: [
              { type: 'command', command: 'node /opt/claude-memory-layer/dist/hooks/session-start.js' },
              { type: 'command', command: 'node /other/session-start-helper.js' }
            ]
          }
        ],
        PostToolUse: [
          {
            matcher: 'keep',
            hooks: [
              { type: 'command', command: 'node /other/post-tool-use-helper.js' },
              { type: 'command', command: 'node /other-plugin/hooks/post-tool-use.js' }
            ]
          }
        ]
      }
    };

    const removed = removePluginHooksFromSettings(settings, '/opt/claude-memory-layer/dist');

    expect(removed.hooks?.SessionStart).toEqual([
      {
        matcher: 'keep-and-remove',
        hooks: [{ type: 'command', command: 'node /other/session-start-helper.js' }]
      }
    ]);
    expect(removed.hooks?.PostToolUse).toEqual([
      {
        matcher: 'keep',
        hooks: [
          { type: 'command', command: 'node /other/post-tool-use-helper.js' },
          { type: 'command', command: 'node /other-plugin/hooks/post-tool-use.js' }
        ]
      }
    ]);
  });

  it('checks generated targets without expanding shell syntax in quoted paths', () => {
    const pluginPath = "/tmp/installed with $dollars 'quotes' `ticks` and {glob}*/dist";
    const settings = { hooks: getHooksConfig(pluginPath) };
    const targets: string[] = [];
    const checks = inspectPluginHookTargets(settings, pluginPath, {
      existsImpl: (target) => { targets.push(target); return true; },
      realpathImpl: (target) => target
    });
    expect(checks).toHaveLength(5);
    expect(checks.every((check) => check.status === 'current')).toBe(true);
    expect(targets.every((target) => target.startsWith(`${pluginPath}/hooks/`))).toBe(true);
  });

  it('treats symlink paths pointing at the same hook as current', () => {
    const checks = inspectPluginHookTargets({ hooks: getHooksConfig('/alias/claude-memory-layer/dist') }, '/real/dist', {
      existsImpl: () => true,
      realpathImpl: (target) => target.replace('/alias/claude-memory-layer', '/real')
    });
    expect(checks.every((check) => check.status === 'current')).toBe(true);
  });

  it('does not hide an old duplicate when a current command also exists', () => {
    const settings = { hooks: getHooksConfig('/new/claude-memory-layer/dist') };
    settings.hooks.Stop?.[0].hooks.push({ type: 'command', command: 'node /old/claude-memory-layer/dist/hooks/stop.js' });
    const checks = inspectPluginHookTargets(settings, '/new/claude-memory-layer/dist', {
      existsImpl: () => true,
      realpathImpl: (target) => target
    });
    expect(checks.filter((check) => check.hookName === 'Stop')).toEqual([
      { hookName: 'Stop', status: 'current' },
      { hookName: 'Stop', status: 'different-target' }
    ]);
  });

  it('does not count unrelated hooks with the same file names as CML hooks', () => {
    const settings = { hooks: getHooksConfig('/unrelated-plugin/dist') };
    const before = structuredClone(settings);
    const checks = inspectPluginHookTargets(settings, '/current/claude-memory-layer/dist', {
      existsImpl: () => true,
      realpathImpl: (target) => target
    });
    expect(checks.every((check) => check.status === 'missing')).toBe(true);
    expect(settings).toEqual(before);
  });

  it('does not expand environment variables or execute wrappers while checking targets', () => {
    const settings = { hooks: getHooksConfig('/current/claude-memory-layer/dist') };
    settings.hooks.Stop![0].hooks[0].command = 'node "$PLUGIN/claude-memory-layer/dist/hooks/stop.js"';
    settings.hooks.SessionEnd![0].hooks[0].command += ' && echo extra';
    const checkedTargets: string[] = [];
    const checks = inspectPluginHookTargets(settings, '/current/claude-memory-layer/dist', {
      existsImpl: (target) => { checkedTargets.push(target); return true; },
      realpathImpl: (target) => target
    });
    expect(checks.filter((check) => check.status === 'unverifiable').map((check) => check.hookName))
      .toEqual(['Stop', 'SessionEnd']);
    expect(checkedTargets).toHaveLength(3);
  });

  it('does not declare unquoted glob or brace expansion targets current', () => {
    const pluginPath = '/tmp/claude-memory-layer-{old,new}*/dist';
    const settings = { hooks: getHooksConfig(pluginPath) };
    for (const entries of Object.values(settings.hooks)) {
      for (const entry of entries ?? []) {
        for (const hook of entry.hooks) hook.command = hook.command.replaceAll("'", '');
      }
    }
    const checks = inspectPluginHookTargets(settings, pluginPath, {
      existsImpl: () => { throw new Error('must not inspect a shell expansion'); },
      realpathImpl: (target) => target
    });
    expect(checks.every((check) => check.status === 'unverifiable')).toBe(true);
  });
});
