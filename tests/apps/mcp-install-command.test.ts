import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getDefaultClaudeDesktopConfigPath,
  installMcpServerConfig,
  readJsonConfig,
  saveJsonConfig
} from '../../src/apps/cli/mcp-install.js';

const tempDirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cml-mcp-install-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('MCP install command helpers', () => {
  it('resolves the Claude Desktop config path per platform', () => {
    expect(getDefaultClaudeDesktopConfigPath('darwin', {}, '/Users/me')).toBe('/Users/me/Library/Application Support/Claude/claude_desktop_config.json');
    expect(getDefaultClaudeDesktopConfigPath('linux', {}, '/home/me')).toBe('/home/me/.config/claude/claude_desktop_config.json');
    expect(getDefaultClaudeDesktopConfigPath('win32', { APPDATA: 'C:/Users/me/AppData/Roaming' }, 'C:/Users/me')).toBe('C:/Users/me/AppData/Roaming/Claude/claude_desktop_config.json');
  });

  it('adds claude-memory-layer MCP server while preserving existing config', () => {
    const config = installMcpServerConfig(
      { mcpServers: { existing: { command: 'node', args: ['server.js'] } }, other: true },
      { serverName: 'claude-memory-layer', command: 'claude-memory-layer-mcp', args: [] }
    );

    expect(config).toEqual({
      mcpServers: {
        existing: { command: 'node', args: ['server.js'] },
        'claude-memory-layer': { command: 'claude-memory-layer-mcp', args: [] }
      },
      other: true
    });
  });

  it('atomically writes config files and creates parent directories', () => {
    const configPath = join(tempDir(), 'Claude', 'claude_desktop_config.json');
    saveJsonConfig(configPath, installMcpServerConfig({}, { serverName: 'code-memory', command: 'node', args: ['dist/mcp/index.js'] }));

    expect(readJsonConfig(configPath)).toEqual({
      mcpServers: {
        'code-memory': { command: 'node', args: ['dist/mcp/index.js'] }
      }
    });
    expect(readFileSync(configPath, 'utf8')).toContain('"mcpServers"');
  });
});
