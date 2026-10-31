import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseCodexMcpServers, readMcpClientConfigs } from '../../src/apps/cli/mcp-client-config.js';

const tempDirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cml-mcp-client-config-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('readMcpClientConfigs', () => {
  it('reads this server from Claude Code user and local scopes, Claude Desktop, and Codex under the given HOME', () => {
    const home = tempHome();
    const cwd = '/work/repo';
    writeFile(join(home, '.claude.json'), JSON.stringify({
      mcpServers: {
        'claude-memory-layer': { type: 'stdio', command: 'claude-memory-layer-mcp', args: [] },
        unrelated: { command: 'other-mcp' }
      },
      projects: {
        [cwd]: { mcpServers: { 'code-memory': { command: 'node', args: ['/x/dist/mcp/index.js'] } } },
        '/elsewhere': { mcpServers: { 'claude-memory-layer': { command: 'ignored' } } }
      }
    }));
    writeFile(join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), JSON.stringify({
      mcpServers: { 'claude-memory-layer': { command: '/usr/local/bin/claude-memory-layer-mcp' } }
    }));
    writeFile(join(home, '.codex', 'config.toml'), [
      'model = "x"',
      '[mcp_servers.claude-memory-layer]',
      'command = "/opt/node/bin/node"',
      'args = ["/opt/cml/dist/mcp/index.js"]',
      '',
      '[mcp_servers.cua-driver]',
      'command = "/usr/local/bin/cua-driver"'
    ].join('\n'));
    const before = readFileSync(join(home, '.claude.json'), 'utf8');

    const reads = readMcpClientConfigs({ homeDir: home, cwd, platform: 'darwin', env: {} });

    expect(reads).toEqual([
      {
        client: 'claude-code',
        configPath: join(home, '.claude.json'),
        servers: [
          { name: 'claude-memory-layer', scope: 'user', command: 'claude-memory-layer-mcp', args: [] },
          { name: 'code-memory', scope: 'local', command: 'node', args: ['/x/dist/mcp/index.js'] }
        ]
      },
      {
        client: 'claude-desktop',
        configPath: join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
        servers: [{ name: 'claude-memory-layer', command: '/usr/local/bin/claude-memory-layer-mcp', args: [] }]
      },
      {
        client: 'codex',
        configPath: join(home, '.codex', 'config.toml'),
        servers: [{ name: 'claude-memory-layer', command: '/opt/node/bin/node', args: ['/opt/cml/dist/mcp/index.js'] }]
      }
    ]);
    expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe(before);
  });

  it('reports no servers when the configs do not exist, and an error when one cannot be parsed', () => {
    const home = tempHome();
    writeFile(join(home, '.claude.json'), '{ not json');

    const reads = readMcpClientConfigs({ homeDir: home, cwd: '/work', platform: 'linux', env: {} });

    expect(reads[0]).toMatchObject({ client: 'claude-code', servers: [], error: expect.any(String) });
    expect(reads[1]).toEqual({ client: 'claude-desktop', configPath: join(home, '.config', 'claude', 'claude_desktop_config.json'), servers: [] });
    expect(reads[2]).toEqual({ client: 'codex', configPath: join(home, '.codex', 'config.toml'), servers: [] });
  });
});

describe('parseCodexMcpServers', () => {
  it('reads quoted table names, literal strings, multi-line args and stops at sub-tables', () => {
    const servers = parseCodexMcpServers([
      '[mcp_servers."claude-memory-layer"]',
      "command = 'C:\\node\\node.exe' # comment",
      'args = [',
      '  "/opt/cml/dist/mcp/index.js",',
      "  '--x',",
      ']',
      '[mcp_servers."claude-memory-layer".env]',
      'command = "not-the-server-command"',
      '[mcp_servers.other]',
      'command = "other"',
      '[[profiles.list]]',
      'command = "not-other-either"'
    ].join('\n'));

    expect(servers).toEqual([
      { name: 'claude-memory-layer', command: 'C:\\node\\node.exe', args: ['/opt/cml/dist/mcp/index.js', '--x'] },
      { name: 'other', command: 'other', args: [] }
    ]);
  });
});
