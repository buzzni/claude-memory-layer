import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ClaudeDesktopConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export interface InstallMcpServerOptions extends McpServerEntry {
  serverName: string;
}

export function getDefaultClaudeDesktopConfigPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }

  if (platform === 'win32') {
    return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  }

  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'claude', 'claude_desktop_config.json');
}

export function readJsonConfig(configPath: string): ClaudeDesktopConfig {
  if (!existsSync(configPath)) {
    return {};
  }

  const content = readFileSync(configPath, 'utf8').trim();
  if (!content) {
    return {};
  }

  return JSON.parse(content) as ClaudeDesktopConfig;
}

export function saveJsonConfig(configPath: string, config: ClaudeDesktopConfig): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tempPath, configPath);
}

export function installMcpServerConfig(
  existingConfig: ClaudeDesktopConfig,
  options: InstallMcpServerOptions
): ClaudeDesktopConfig {
  const { serverName, command, args, env } = options;
  const serverEntry: McpServerEntry = { command };

  if (args && args.length > 0) {
    serverEntry.args = args;
  } else if (args) {
    serverEntry.args = [];
  }

  if (env && Object.keys(env).length > 0) {
    serverEntry.env = env;
  }

  return {
    ...existingConfig,
    mcpServers: {
      ...(existingConfig.mcpServers ?? {}),
      [serverName]: serverEntry
    }
  };
}

/**
 * The invocation `mcp install` records by default: the node running this CLI
 * plus the realpath of this package's MCP entrypoint. A PATH name such as
 * `claude-memory-layer-mcp` lets whichever install comes first on the MCP
 * client's PATH (e.g. a stale nvm-managed one) serve the session instead.
 */
export function getDefaultMcpServerEntry(
  pluginPath: string,
  execPath: string = process.execPath
): Required<Pick<McpServerEntry, 'command' | 'args'>> {
  const entryPath = join(pluginPath, 'mcp', 'index.js');
  if (!existsSync(entryPath)) {
    throw new Error(`MCP entrypoint not found at ${entryPath}. Run "npm run build" or pass --command.`);
  }
  return { command: execPath, args: [realpathSync(entryPath)] };
}

export interface InstallMcpServerCommandOptions {
  configPath?: string;
  serverName?: string;
  /** Overrides the default absolute invocation; recorded as given. */
  command?: string;
  args?: string[];
  /** This package's dist directory; required unless `command` is given. */
  pluginPath?: string;
  execPath?: string;
  dryRun?: boolean;
}

export function installMcpServer(options: InstallMcpServerCommandOptions = {}): {
  configPath: string;
  config: ClaudeDesktopConfig;
} {
  const configPath = options.configPath ?? getDefaultClaudeDesktopConfigPath();
  const invocation = options.command
    ? { command: options.command, args: options.args ?? [] }
    : defaultInvocation(options);
  const config = installMcpServerConfig(readJsonConfig(configPath), {
    serverName: options.serverName ?? 'claude-memory-layer',
    ...invocation
  });

  if (!options.dryRun) {
    saveJsonConfig(configPath, config);
  }

  return { configPath, config };
}

function defaultInvocation(options: InstallMcpServerCommandOptions): { command: string; args: string[] } {
  if (!options.pluginPath) {
    throw new Error('MCP entrypoint not found: no plugin path given. Pass --command.');
  }
  const entry = getDefaultMcpServerEntry(options.pluginPath, options.execPath);
  return { command: entry.command, args: [...entry.args, ...(options.args ?? [])] };
}
