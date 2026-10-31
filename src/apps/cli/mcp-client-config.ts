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
