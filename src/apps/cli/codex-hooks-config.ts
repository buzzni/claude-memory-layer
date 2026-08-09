import * as path from 'node:path';

import { shellQuotePathForNode } from './claude-settings-hooks.js';

export interface CodexHookCommand {
  type: string;
  command?: string;
  commandWindows?: string;
  timeout?: number;
  statusMessage?: string;
  additionalContextLimit?: number;
  [key: string]: unknown;
}

export interface CodexHookEntry {
  matcher?: string;
  hooks: CodexHookCommand[];
  [key: string]: unknown;
}

export interface CodexHooksConfig {
  description?: string;
  hooks?: Record<string, CodexHookEntry[] | undefined>;
  [key: string]: unknown;
}

export const REQUIRED_CODEX_HOOK_FILES = [
  'codex-session-start.js',
  'codex-session-end.js',
  'codex-session-import-worker.js'
] as const;

const CODEX_HOOK_FILES = {
  SessionStart: 'codex-session-start.js',
  SessionEnd: 'codex-session-end.js'
} as const;

export type CodexMemoryHookName = keyof typeof CODEX_HOOK_FILES;

export function buildCodexHookCommand(pluginPath: string, fileName: string): string {
  const absolutePluginPath = path.resolve(pluginPath);
  return `node ${shellQuotePathForNode(path.join(absolutePluginPath, 'hooks', fileName))}`;
}

export function buildCodexHookWindowsCommand(pluginPath: string, fileName: string): string {
  const absolutePluginPath = path.resolve(pluginPath);
  return `node "${path.join(absolutePluginPath, 'hooks', fileName).replace(/"/g, '""')}"`;
}

export function getCodexMemoryHooks(pluginPath: string): Record<CodexMemoryHookName, CodexHookEntry[]> {
  return {
    SessionStart: [
      {
        matcher: 'startup|resume|clear|compact',
        hooks: [
          {
            type: 'command',
            command: buildCodexHookCommand(pluginPath, CODEX_HOOK_FILES.SessionStart),
            commandWindows: buildCodexHookWindowsCommand(pluginPath, CODEX_HOOK_FILES.SessionStart),
            statusMessage: 'Loading project memory',
            additionalContextLimit: 5000
          }
        ]
      }
    ],
    SessionEnd: [
      {
        hooks: [
          {
            type: 'command',
            command: buildCodexHookCommand(pluginPath, CODEX_HOOK_FILES.SessionEnd),
            commandWindows: buildCodexHookWindowsCommand(pluginPath, CODEX_HOOK_FILES.SessionEnd),
            statusMessage: 'Saving session memory',
            timeout: 3
          }
        ]
      }
    ]
  };
}

export function isCodexMemoryHookCommand(command: string | undefined, pluginPath?: string): boolean {
  if (!command) return false;
  const normalized = command.replace(/\\/g, '/');
  const normalizedPluginPath = pluginPath?.replace(/\\/g, '/').replace(/\/$/, '');

  return Object.values(CODEX_HOOK_FILES).some((fileName) => {
    if (normalizedPluginPath && normalized.includes(`${normalizedPluginPath}/hooks/${fileName}`)) {
      return true;
    }
    return normalized.includes('claude-memory-layer') && normalized.includes(`/hooks/${fileName}`);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate only the structural fields we mutate, preserving newer Codex fields. */
export function parseCodexHooksConfig(value: unknown): CodexHooksConfig {
  if (!isRecord(value)) {
    throw new Error('Codex hooks config must be a JSON object');
  }
  if (value.hooks === undefined) return value as CodexHooksConfig;
  if (!isRecord(value.hooks)) {
    throw new Error('Codex hooks config "hooks" must be a JSON object');
  }

  for (const [eventName, entries] of Object.entries(value.hooks)) {
    if (!Array.isArray(entries)) {
      throw new Error(`Codex hooks config "hooks.${eventName}" must be an array`);
    }
    for (const [entryIndex, entry] of entries.entries()) {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
        throw new Error(`Codex hooks config "hooks.${eventName}[${entryIndex}].hooks" must be an array`);
      }
      for (const [hookIndex, hook] of entry.hooks.entries()) {
        if (!isRecord(hook)) {
          throw new Error(`Codex hook "hooks.${eventName}[${entryIndex}].hooks[${hookIndex}]" must be a JSON object`);
        }
        if (hook.command !== undefined && typeof hook.command !== 'string') {
          throw new Error(`Codex hook "hooks.${eventName}[${entryIndex}].hooks[${hookIndex}].command" must be a string`);
        }
      }
    }
  }
  return value as CodexHooksConfig;
}

export function removeCodexMemoryHooks<T extends CodexHooksConfig>(config: T, pluginPath?: string): T {
  const next = { ...config };
  if (!config.hooks) return next;

  const hooks = { ...config.hooks };
  for (const hookName of Object.keys(CODEX_HOOK_FILES) as CodexMemoryHookName[]) {
    const entries = hooks[hookName] ?? [];
    const cleaned = entries
      .map((entry) => ({
        ...entry,
        hooks: (entry.hooks ?? []).filter((hook) => (
          !isCodexMemoryHookCommand(hook.command, pluginPath)
          && !isCodexMemoryHookCommand(hook.commandWindows, pluginPath)
        ))
      }))
      .filter((entry) => entry.hooks.length > 0);

    if (cleaned.length > 0) {
      hooks[hookName] = cleaned;
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

export function mergeCodexMemoryHooks<T extends CodexHooksConfig>(config: T, pluginPath: string): T {
  const cleaned = removeCodexMemoryHooks(config, pluginPath);
  const next = { ...cleaned, hooks: { ...(cleaned.hooks ?? {}) } };
  const pluginHooks = getCodexMemoryHooks(pluginPath);

  for (const hookName of Object.keys(CODEX_HOOK_FILES) as CodexMemoryHookName[]) {
    next.hooks[hookName] = [
      ...(next.hooks[hookName] ?? []),
      ...pluginHooks[hookName]
    ];
  }
  return next;
}

export function hasCodexMemoryHook(
  config: CodexHooksConfig,
  hookName: CodexMemoryHookName,
  pluginPath?: string
): boolean {
  return (config.hooks?.[hookName] ?? []).some((entry) => (
    entry.hooks.some((hook) => (
      isCodexMemoryHookCommand(hook.command, pluginPath)
      || isCodexMemoryHookCommand(hook.commandWindows, pluginPath)
    ))
  ));
}
