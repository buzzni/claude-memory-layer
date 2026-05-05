import { describe, expect, it } from 'vitest';

import {
  buildHookCommand,
  getHooksConfig,
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
});
