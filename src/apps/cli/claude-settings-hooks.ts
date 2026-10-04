import * as fs from 'fs';
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

export type ClaudeHookTargetStatus = 'current' | 'missing' | 'missing-target' | 'different-target' | 'unverifiable';

export interface ClaudeHookTargetCheck {
  hookName: PluginHookName;
  status: ClaudeHookTargetStatus;
}

/** Parse literal shell arguments without executing or expanding the command. */
function literalShellWords(command: string): string[] | null {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === '$' || char === '`') return null;
      else if (char === '\\' && /[\\"$`]/.test(command[index + 1] ?? '')) word += command[++index];
      else word += char;
      continue;
    }
    if ('\n\r$`;&|<>()*?[]{}'.includes(char)) return null;
    if (/\s/.test(char)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === '\\') {
      if (index + 1 === command.length) return null;
      word += command[++index];
      started = true;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

function literalNodeTarget(command: string): string | null {
  const words = literalShellWords(command);
  if (!words || words.length !== 2 || !/^node(?:\.exe)?$/.test(path.basename(words[0]))) return null;
  // Relative targets depend on the invoking client's cwd, which this check
  // does not know. Wrappers, substitutions and Node flags remain unverified.
  return path.isAbsolute(words[1]) ? words[1] : null;
}

/** Compare registered CML targets to this CLI's installation, without writes. */
export function inspectPluginHookTargets(
  settings: ClaudeSettingsWithHooks,
  pluginPath: string,
  deps: {
    existsImpl?: (filePath: string) => boolean;
    realpathImpl?: (filePath: string) => string;
  } = {}
): ClaudeHookTargetCheck[] {
  const existsImpl = deps.existsImpl ?? fs.existsSync;
  const realpathImpl = deps.realpathImpl ?? fs.realpathSync;
  const canonicalPath = (filePath: string): string => {
    try {
      return realpathImpl(filePath);
    } catch {
      return path.resolve(filePath);
    }
  };

  return (Object.entries(PLUGIN_HOOKS) as Array<[PluginHookName, string]>).flatMap(([hookName, fileName]) => {
    const expectedPath = canonicalPath(path.join(pluginPath, 'hooks', fileName));
    const commands = (settings.hooks?.[hookName] ?? [])
      .flatMap((entry) => entry.hooks ?? [])
      .filter((hook) => {
        if (hook.type !== 'command') return false;
        const target = literalNodeTarget(hook.command);
        return isPluginHookCommand(hook.command, pluginPath)
          || (target !== null && canonicalPath(target) === expectedPath);
      });
    if (commands.length === 0) return [{ hookName, status: 'missing' as const }];

    return commands.map((hook): ClaudeHookTargetCheck => {
      const target = literalNodeTarget(hook.command);
      if (!target) return { hookName, status: 'unverifiable' };
      if (!existsImpl(target)) return { hookName, status: 'missing-target' };
      return { hookName, status: canonicalPath(target) === expectedPath ? 'current' : 'different-target' };
    });
  });
}

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
