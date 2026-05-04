import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

export interface InstallMcpServerCommandOptions {
  configPath?: string;
  serverName?: string;
  command?: string;
  args?: string[];
  dryRun?: boolean;
}

export function installMcpServer(options: InstallMcpServerCommandOptions = {}): {
  configPath: string;
  config: ClaudeDesktopConfig;
} {
  const configPath = options.configPath ?? getDefaultClaudeDesktopConfigPath();
  const config = installMcpServerConfig(readJsonConfig(configPath), {
    serverName: options.serverName ?? 'claude-memory-layer',
    command: options.command ?? 'claude-memory-layer-mcp',
    args: options.args ?? []
  });

  if (!options.dryRun) {
    saveJsonConfig(configPath, config);
  }

  return { configPath, config };
}
