import * as path from 'path';

export interface ClaudeHookCommand {
  type: string;
  command: string;
}

export interface ClaudeHookEntry {
  matcher: string;
  hooks: ClaudeHookCommand[];
}

export interface ClaudeSettingsHooks {
  UserPromptSubmit?: ClaudeHookEntry[];
  PostToolUse?: ClaudeHookEntry[];
  SessionStart?: ClaudeHookEntry[];
  Stop?: ClaudeHookEntry[];
  SessionEnd?: ClaudeHookEntry[];
  [key: string]: ClaudeHookEntry[] | undefined;
}

export interface ClaudeSettingsWithHooks {
  hooks?: ClaudeSettingsHooks;
  [key: string]: unknown;
}

export const REQUIRED_HOOK_FILES = [
  'user-prompt-submit.js',
  'post-tool-use.js',
  'session-start.js',
  'stop.js',
  'session-end.js'
] as const;

export const PLUGIN_HOOKS = {
  SessionStart: 'session-start.js',
  UserPromptSubmit: 'user-prompt-submit.js',
  PostToolUse: 'post-tool-use.js',
  Stop: 'stop.js',
  SessionEnd: 'session-end.js'
} as const;

export type PluginHookName = keyof typeof PLUGIN_HOOKS;

export function shellQuotePathForNode(filePath: string): string {
  return `'${filePath.replace(/'/g, `'\\''`)}'`;
}

export function buildHookCommand(pluginPath: string, fileName: string): string {
  return `node ${shellQuotePathForNode(path.join(pluginPath, 'hooks', fileName))}`;
}

export function getHooksConfig(pluginPath: string): ClaudeSettingsHooks {
  const makeHook = (fileName: string): ClaudeHookEntry[] => [
    {
      matcher: '',
      hooks: [
        {
          type: 'command',
          command: buildHookCommand(pluginPath, fileName)
        }
      ]
    }
  ];

  return Object.fromEntries(
    Object.entries(PLUGIN_HOOKS).map(([hookName, fileName]) => [hookName, makeHook(fileName)])
  ) as ClaudeSettingsHooks;
}

export function isPluginHookCommand(command: string | undefined, pluginPath?: string): boolean {
  if (!command) return false;
  const normalized = command.replace(/\\/g, '/');
  const normalizedPluginPath = pluginPath?.replace(/\\/g, '/').replace(/\/$/, '');

  return REQUIRED_HOOK_FILES.some((fileName) => {
    if (normalizedPluginPath && normalized.includes(`${normalizedPluginPath}/hooks/${fileName}`)) {
      return true;
    }
    return normalized.includes('claude-memory-layer') && normalized.includes(`/hooks/${fileName}`);
  });
}

export function hasHook(
  settings: ClaudeSettingsWithHooks,
  hookName: PluginHookName,
  commandFragment: string
): boolean {
  const hookEntries = settings.hooks?.[hookName];
  if (!hookEntries) return false;
  return hookEntries.some((entry) => entry.hooks?.some((hook) => hook.command?.includes(commandFragment)));
}

export function removePluginHooksFromSettings<T extends ClaudeSettingsWithHooks>(settings: T, pluginPath?: string): T {
  const next = { ...settings };
  if (!settings.hooks) return next;

  const hooks: ClaudeSettingsHooks = { ...settings.hooks };

  for (const hookName of Object.keys(PLUGIN_HOOKS) as PluginHookName[]) {
    const entries = hooks[hookName] ?? [];
    const cleanedEntries = entries
      .map((entry) => ({
        ...entry,
        hooks: (entry.hooks ?? []).filter((hook) => !isPluginHookCommand(hook.command, pluginPath))
      }))
      .filter((entry) => entry.hooks.length > 0);

    if (cleanedEntries.length > 0) {
      hooks[hookName] = cleanedEntries;
    } else {
      delete hooks[hookName];
    }
  }

  if (Object.keys(hooks).length > 0) {
    next.hooks = hooks;
  } else {
    delete next.hooks;
  }

  return next;
}

export function mergePluginHooksIntoSettings<T extends ClaudeSettingsWithHooks>(settings: T, pluginPath: string): T {
  const cleaned = removePluginHooksFromSettings(settings, pluginPath);
  const next = { ...cleaned, hooks: { ...(cleaned.hooks ?? {}) } };
  const pluginHooks = getHooksConfig(pluginPath);

  for (const hookName of Object.keys(PLUGIN_HOOKS) as PluginHookName[]) {
    next.hooks[hookName] = [
      ...(next.hooks[hookName] ?? []),
      ...(pluginHooks[hookName] ?? [])
    ];
  }

  return next;
}
