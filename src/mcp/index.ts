#!/usr/bin/env node
/**
 * MCP Server for Claude Desktop
 * Provides memory search tools via Model Context Protocol
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

import { tools } from './tools.js';
import { handleToolCall } from './handlers.js';

const server = new Server(
  {
    name: 'code-memory-mcp',
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// Tool listing handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Tool call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return handleToolCall(name, args || {});
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('code-memory MCP server started');
}

main().catch(console.error);
