import { describe, expect, it } from 'vitest';

import {
  buildCodexHookCommand,
  buildCodexHookWindowsCommand,
  getCodexMemoryHooks,
  hasCodexMemoryHook,
  mergeCodexMemoryHooks,
  parseCodexHooksConfig,
  removeCodexMemoryHooks,
  type CodexHooksConfig
} from '../../src/apps/cli/codex-hooks-config.js';

describe('Codex memory hook config', () => {
  it('builds lifecycle hooks with the Codex timeout and context limits', () => {
    const hooks = getCodexMemoryHooks('/tmp/cml dist');

    expect(buildCodexHookCommand('/tmp/cml dist', 'codex-session-start.js'))
      .toBe("node '/tmp/cml dist/hooks/codex-session-start.js'");
    expect(buildCodexHookWindowsCommand('/tmp/cml dist', 'codex-session-start.js'))
      .toBe('node "/tmp/cml dist/hooks/codex-session-start.js"');
    expect(hooks.SessionStart[0]).toMatchObject({
      matcher: 'startup|resume|clear|compact',
      hooks: [{
        command: "node '/tmp/cml dist/hooks/codex-session-start.js'",
        commandWindows: 'node "/tmp/cml dist/hooks/codex-session-start.js"',
        additionalContextLimit: 5000
      }]
    });
    expect(hooks.SessionEnd[0]).toMatchObject({
      hooks: [{
        command: "node '/tmp/cml dist/hooks/codex-session-end.js'",
        timeout: 3
      }]
    });
  });

  it('resolves relative plugin paths because Codex runs hooks from the session cwd', () => {
    expect(buildCodexHookCommand('relative-dist', 'codex-session-end.js'))
      .toBe(`node '${process.cwd()}/relative-dist/hooks/codex-session-end.js'`);
  });

  it('rejects malformed config structures before installation can overwrite them', () => {
    expect(() => parseCodexHooksConfig([])).toThrow('must be a JSON object');
    expect(() => parseCodexHooksConfig({ hooks: [] })).toThrow('"hooks" must be a JSON object');
    expect(() => parseCodexHooksConfig({ hooks: { SessionEnd: {} } }))
      .toThrow('"hooks.SessionEnd" must be an array');
    expect(() => parseCodexHooksConfig({ hooks: { SessionEnd: [{ hooks: [{ command: 42 }] }] } }))
      .toThrow('.command" must be a string');
    expect(parseCodexHooksConfig({ hooks: { SessionEnd: [{ hooks: [{ type: 'prompt' }] }] } }))
      .toBeTruthy();
  });

  it('merges idempotently while preserving unrelated Codex hooks and top-level config', () => {
    const original: CodexHooksConfig = {
      description: 'personal hooks',
      custom: { keep: true },
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'node /other/start.js' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'node /other/stop.js' }] }]
      }
    };

    const once = mergeCodexMemoryHooks(original, '/opt/claude-memory-layer/dist');
    const twice = mergeCodexMemoryHooks(once, '/opt/claude-memory-layer/dist');

    expect(twice).toEqual(once);
    expect(twice.custom).toEqual({ keep: true });
    expect(twice.hooks?.SessionStart?.[0].hooks[0].command).toBe('node /other/start.js');
    expect(twice.hooks?.Stop).toEqual(original.hooks?.Stop);
    expect(hasCodexMemoryHook(twice, 'SessionStart', '/opt/claude-memory-layer/dist')).toBe(true);
    expect(hasCodexMemoryHook(twice, 'SessionEnd', '/opt/claude-memory-layer/dist')).toBe(true);
  });

  it('removes only claude-memory-layer handlers, including mixed matcher groups', () => {
    const config: CodexHooksConfig = {
      hooks: {
        SessionEnd: [{
          matcher: 'other',
          hooks: [
            {
              type: 'command',
              command: 'node /opt/claude-memory-layer/dist/hooks/codex-session-end.js',
              commandWindows: 'node "C:\\other\\end.js"'
            },
            { type: 'command', command: 'node /other/end.js' }
          ]
        }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /other/prompt.js' }] }]
      }
    };

    const removed = removeCodexMemoryHooks(config, '/opt/claude-memory-layer/dist');

    expect(removed.hooks?.SessionEnd).toEqual([{
      matcher: 'other',
      hooks: [{ type: 'command', command: 'node /other/end.js' }]
    }]);
    expect(removed.hooks?.UserPromptSubmit).toEqual(config.hooks?.UserPromptSubmit);
  });
});
