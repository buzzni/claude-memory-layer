import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getDefaultClaudeDesktopConfigPath } from './mcp-install.js';

/** Recognizes this package's MCP server among the entries an MCP client config registers. */
export function isClaudeMemoryMcpServer(serverName: string, server: unknown): boolean {
  if (!server || typeof server !== 'object' || Array.isArray(server)) return false;
  const record = server as Record<string, unknown>;
  const command = typeof record.command === 'string' ? record.command : '';
  const args = Array.isArray(record.args)
    ? record.args.filter((item): item is string => typeof item === 'string')
    : [];
  const invocation = [command, ...args].join(' ').replace(/\\/g, '/');
  if (/claude-memory-layer/i.test(invocation)) return true;
  return /memory/i.test(serverName)
    && /(?:^|[\s/])(?:\.\/)?(?:dist|src)\/(?:extensions\/)?mcp\/index\.(?:js|ts)(?:\s|$)/i.test(invocation);
}

export type McpClientName = 'claude-code' | 'claude-desktop' | 'codex';

export interface RegisteredMcpServer {
  name: string;
  /** Claude Code scope the entry lives in; `claude mcp add -s <scope>` targets it. */
  scope?: 'user' | 'local';
  command: string;
  args: string[];
}

export interface McpClientConfigRead {
  client: McpClientName;
  configPath: string;
  servers: RegisteredMcpServer[];
  error?: string;
}

/**
 * Reads, never writes, the MCP client configs this server is usually
 * registered in: Claude Code (`~/.claude.json`, user scope plus the cwd's
 * local scope), Claude Desktop (where `mcp install` writes) and Codex
 * (`~/.codex/config.toml`). A missing file reads as no servers.
 */
export function readMcpClientConfigs(options: {
  homeDir?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
} = {}): McpClientConfigRead[] {
  const homeDir = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();

  return [
    readConfig('claude-code', path.join(homeDir, '.claude.json'), (text) => {
      const config = JSON.parse(text) as { mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> };
      return [
        ...jsonServers(config.mcpServers, 'user'),
        ...jsonServers(config.projects?.[cwd]?.mcpServers, 'local')
      ];
    }),
    readConfig('claude-desktop', getDefaultClaudeDesktopConfigPath(options.platform, options.env, homeDir), (text) =>
      jsonServers((JSON.parse(text) as { mcpServers?: unknown }).mcpServers)),
    readConfig('codex', path.join(homeDir, '.codex', 'config.toml'), (text) =>
      parseCodexMcpServers(text).filter((server) => isRegisteredClaudeMemoryServer(server.name, server)))
  ];
}

function readConfig(
  client: McpClientName,
  configPath: string,
  parse: (text: string) => RegisteredMcpServer[]
): McpClientConfigRead {
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch {
    return { client, configPath, servers: [] };
  }
  if (!text.trim()) return { client, configPath, servers: [] };
  try {
    return { client, configPath, servers: parse(text) };
  } catch (error) {
    return { client, configPath, servers: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function isRegisteredClaudeMemoryServer(serverName: string, server: unknown): boolean {
  return serverName === 'claude-memory-layer' || isClaudeMemoryMcpServer(serverName, server);
}

function jsonServers(value: unknown, scope?: RegisteredMcpServer['scope']): RegisteredMcpServer[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(([name, server]) => isRegisteredClaudeMemoryServer(name, server))
    .flatMap(([name, server]) => {
      const record = server as Record<string, unknown>;
      if (typeof record.command !== 'string') return [];
      const args = Array.isArray(record.args)
        ? record.args.filter((item): item is string => typeof item === 'string')
        : [];
      return [{ name, ...(scope ? { scope } : {}), command: record.command, args }];
    });
}

const TOML_STRING = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;

function tomlStrings(value: string): string[] {
  return Array.from(value.matchAll(TOML_STRING), (match) => {
    if (match[2] !== undefined) return match[2];
    try {
      return JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return match[1];
    }
  });
}

/**
 * Just enough TOML to read `command` and `args` from `[mcp_servers.<name>]`
 * tables, which is the shape `codex mcp add` writes. Inline-table forms are
 * not recognized and read as no servers.
 */
export function parseCodexMcpServers(toml: string): Array<{ name: string; command: string; args: string[] }> {
  const servers: Array<{ name: string; command?: string; args: string[] }> = [];
  let current: (typeof servers)[number] | null = null;
  let pendingArgs: string | null = null;

  for (const line of toml.split(/\r?\n/)) {
    if (pendingArgs !== null && current) {
      pendingArgs += `\n${line}`;
      if (/\]\s*(?:#.*)?$/.test(line.trim())) {
        current.args = tomlStrings(pendingArgs);
        pendingArgs = null;
      }
      continue;
    }
    if (line.trim().startsWith('[')) {
      const table = /^\s*\[\s*mcp_servers\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/.exec(line);
      current = table ? { name: table[1] ?? table[2] ?? table[3], args: [] } : null;
      if (current) servers.push(current);
      continue;
    }
    if (!current) continue;
    const command = /^\s*command\s*=\s*(.+)$/.exec(line);
    if (command) {
      current.command = tomlStrings(command[1])[0];
      continue;
    }
    const args = /^\s*args\s*=\s*(\[.*)$/.exec(line);
    if (args) {
      if (/\]\s*(?:#.*)?$/.test(args[1].trim())) current.args = tomlStrings(args[1]);
      else pendingArgs = args[1];
    }
  }

  return servers.flatMap((server) => server.command === undefined
    ? []
    : [{ name: server.name, command: server.command, args: server.args }]);
}
